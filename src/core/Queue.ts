import type { AbortInterface } from '@orkestrel/abort'
import type { Result } from '@orkestrel/contract'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { TimeoutInterface } from '@orkestrel/timeout'
import type {
	QueueEntryOptions,
	QueueEventMap,
	QueueHandler,
	QueueInterface,
	QueueOptions,
	QueueStoreInterface,
	StoredEntry,
} from './types.js'
import { createAbort } from '@orkestrel/abort'
import { isString, preview } from '@orkestrel/contract'
import { Emitter } from '@orkestrel/emitter'
import { createTimeout } from '@orkestrel/timeout'
import { isQueueError, QueueError } from './errors.js'
import { readOption, validateOption } from './helpers.js'
import {
	isQueueConcurrency,
	isQueueRetries,
	isQueueSignal,
	isQueueTimeout,
	isStoredEntry,
} from './validators.js'

/**
 * A concurrent, cooperative FIFO job queue with optional outstanding-work persistence.
 *
 * @typeParam TInput - The work input each entry carries
 * @typeParam TResult - The value each entry resolves
 *
 * @example
 * ```ts
 * const queue = new Queue<number, number>({ handler: (input) => input * 2 })
 * const result = await queue.enqueue(21)
 * ```
 */
export class Queue<TInput, TResult> implements QueueInterface<TInput, TResult> {
	readonly #handler: QueueHandler<TInput, TResult>
	readonly #concurrency: number
	readonly #retries: number
	readonly #timeout: number
	readonly #store: QueueStoreInterface<TInput> | undefined
	readonly #abort: AbortInterface = createAbort()
	readonly #emitter: Emitter<QueueEventMap<TResult>>
	readonly #entries = new Map<
		PromiseWithResolvers<TResult>,
		{
			readonly id: string
			readonly input: TInput
			readonly options: QueueEntryOptions | undefined
			readonly attempts: number
			settled: boolean
		}
	>()
	readonly #live = new Map<string, PromiseWithResolvers<TResult>>()
	readonly #pending: Array<PromiseWithResolvers<TResult>> = []
	readonly #claims = new Set<PromiseWithResolvers<TResult>>()
	readonly #wakes: Array<() => void> = []
	readonly #workers = new Set<Promise<void>>()
	readonly #admissions = new Map<PromiseWithResolvers<TResult>, Promise<void>>()
	readonly #orphans = new Set<PromiseWithResolvers<TResult>>()
	readonly #cleanups = new Map<PromiseWithResolvers<TResult>, Promise<void>>()
	#admission: Promise<void> = Promise.resolve()
	#stopPromise: Promise<void> | undefined
	#abortPromise: Promise<void> | undefined
	#destroyPromise: Promise<void> | undefined
	#generation = 0
	#paused = false
	#stopped = false
	#drained = true

	/**
	 * Create a queue.
	 *
	 * @param options - Handler, validated execution limits, persistence, and observation hooks
	 */
	constructor(options: QueueOptions<TInput, TResult>) {
		const configuredConcurrency = options.concurrency
		const concurrency = validateOption(
			configuredConcurrency === undefined ? 1 : configuredConcurrency,
			isQueueConcurrency,
			'concurrency',
			'queue concurrency must be a positive safe integer',
		)
		const configuredRetries = options.retries
		const retries = validateOption(
			configuredRetries === undefined ? 0 : configuredRetries,
			isQueueRetries,
			'retries',
			'queue retries must be a nonnegative safe integer',
		)
		const configuredTimeout = options.timeout
		const timeout = validateOption(
			configuredTimeout === undefined ? 0 : configuredTimeout,
			isQueueTimeout,
			'timeout',
			'queue timeout must be within the native timer range',
		)
		const on = options.on
		const error = options.error
		this.#handler = options.handler
		this.#concurrency = concurrency
		this.#retries = retries
		this.#timeout = timeout
		this.#store = options.store
		this.#emitter = new Emitter<QueueEventMap<TResult>>({
			...(on === undefined ? {} : { on }),
			...(error === undefined ? {} : { error }),
		})
	}

	get emitter(): EmitterInterface<QueueEventMap<TResult>> {
		return this.#emitter
	}

	get count(): number {
		return this.#live.size
	}

	get active(): number {
		return this.#claims.size
	}

	get paused(): boolean {
		return this.#paused
	}

	get stopped(): boolean {
		return this.#stopped || this.#abortPromise !== undefined
	}

	/**
	 * Reserve and submit one FIFO entry.
	 *
	 * @param input - Handler input
	 * @param options - Optional id, retry/timeout overrides, and entry abort signal
	 * @returns The entry's settle-once execution promise
	 * @throws {QueueError} Synchronously when an option is inaccessible or invalid
	 */
	enqueue(input: TInput, options?: QueueEntryOptions): Promise<TResult> {
		const rawId = readOption(options, 'id', 'queue entry id could not be read')
		const supplied =
			rawId === undefined
				? undefined
				: validateOption(rawId, isString, 'id', 'queue entry id must be a string')
		const rawRetries = readOption(options, 'retries', 'queue retries could not be read')
		const retries =
			rawRetries === undefined
				? undefined
				: validateOption(
						rawRetries,
						isQueueRetries,
						'retries',
						'queue retries must be a nonnegative safe integer',
					)
		const rawTimeout = readOption(options, 'timeout', 'queue timeout could not be read')
		const timeout =
			rawTimeout === undefined
				? undefined
				: validateOption(
						rawTimeout,
						isQueueTimeout,
						'timeout',
						'queue timeout must be within the native timer range',
					)
		const rawSignal = readOption(options, 'signal', 'queue signal could not be read')
		const signal =
			rawSignal === undefined
				? undefined
				: validateOption(rawSignal, isQueueSignal, 'signal', 'queue signal must be an AbortSignal')
		const normalized: QueueEntryOptions | undefined =
			options === undefined
				? undefined
				: Object.freeze({
						...(supplied === undefined ? {} : { id: supplied }),
						...(retries === undefined ? {} : { retries }),
						...(timeout === undefined ? {} : { timeout }),
						...(signal === undefined ? {} : { signal }),
					})
		if (this.#destroyPromise !== undefined) {
			return Promise.reject(new QueueError('queue is destroyed', { code: 'destroyed' }))
		}
		if (this.#abortPromise !== undefined) {
			return Promise.reject(new QueueError('queue is aborted', { code: 'aborted' }))
		}
		if (this.#stopped) {
			return Promise.reject(new QueueError('queue is stopped', { code: 'stopped' }))
		}
		const id = supplied ?? crypto.randomUUID()
		if (this.#live.has(id)) {
			return Promise.reject(
				new QueueError('queue entry id is already live', {
					code: 'duplicate',
					context: { id },
				}),
			)
		}
		const token = this.#reserve(id, input, normalized, 0)
		if (this.#store === undefined) this.#accept(token)
		else this.#schedule(token)
		return token.promise
	}

	/**
	 * Load and accept every outstanding stored entry from the current lifecycle generation.
	 *
	 * @returns A promise that settles after every loaded entry is reserved and accepted
	 * @throws {QueueError} Thrown when the store's load fails or returns a malformed entry.
	 */
	async restore(): Promise<void> {
		if (this.#store === undefined || this.stopped || this.#destroyPromise !== undefined) return
		const generation = this.#generation
		const entries: Array<StoredEntry<TInput>> = []
		let malformed = false
		try {
			const loaded = await this.#store.load()
			for (const stored of loaded) {
				const candidate = { id: stored.id, input: stored.input, attempts: stored.attempts }
				if (!isStoredEntry(candidate)) {
					malformed = true
					break
				}
				entries.push(Object.freeze(candidate))
			}
		} catch (error: unknown) {
			throw new QueueError('queue store load failed', {
				code: 'store',
				cause: error,
				context: { operation: 'load' },
			})
		}
		if (malformed) {
			throw new QueueError('queue store returned an invalid entry', {
				code: 'store',
				context: { operation: 'load' },
			})
		}
		if (generation !== this.#generation || this.stopped || this.#destroyPromise !== undefined)
			return
		for (const stored of entries) {
			if (generation !== this.#generation || this.stopped || this.#destroyPromise !== undefined)
				return
			if (this.#live.has(stored.id)) continue
			const token = this.#reserve(stored.id, stored.input, undefined, stored.attempts)
			this.#accept(token)
			void token.promise.catch(() => {})
		}
	}

	/** Begin or restart worker execution unless the queue is terminal. */
	start(): void {
		if (this.#abortPromise !== undefined || this.#destroyPromise !== undefined) return
		this.#stopped = false
		this.#stopPromise = undefined
		this.#spawn()
	}

	/**
	 * Reject non-active work and await current-loop and durable cleanup quiescence.
	 *
	 * @returns The stable stop barrier
	 */
	stop(): Promise<void> {
		if (this.#destroyPromise !== undefined) return this.#destroyPromise
		if (this.#abortPromise !== undefined) return this.#abortPromise
		if (this.#stopped && this.#stopPromise !== undefined) return this.#stopPromise
		const barrier = Promise.withResolvers<void>()
		this.#stopPromise = barrier.promise
		this.#stopped = true
		this.#generation += 1
		const existing = [...this.#cleanups.values()]
		const cleanup = [
			...this.#drain(new QueueError('queue is stopped', { code: 'stopped' })),
			...this.#cleanOrphans(true),
		]
		const tasks = [...this.#workers, ...this.#admissions.values(), ...existing, ...cleanup]
		this.#wakeAll()
		void this.#settleBarrier(barrier, tasks, 'queue stop cleanup failed')
		return barrier.promise
	}

	/** Suspend new execution while leaving active entries untouched. */
	pause(): void {
		if (this.#paused || this.stopped || this.#destroyPromise !== undefined) return
		this.#paused = true
	}

	/** Continue execution after a pause. */
	resume(): void {
		if (!this.#paused || this.stopped || this.#destroyPromise !== undefined) return
		this.#paused = false
		this.#wakeAll()
	}

	/**
	 * Cancel the queue and await owned cleanup.
	 *
	 * @param reason - Optional cause carried by the coded abort error
	 * @returns The stable abort barrier
	 */
	abort(reason?: unknown): Promise<void> {
		if (this.#abortPromise !== undefined) return this.#abortPromise
		const barrier = Promise.withResolvers<void>()
		this.#abortPromise = barrier.promise
		this.#stopped = true
		this.#generation += 1
		const error = new QueueError(reason instanceof Error ? reason.message : 'queue is aborted', {
			code: 'aborted',
			...(reason === undefined ? {} : { cause: reason }),
		})
		this.#abort.abort(error)
		const existing = [...this.#cleanups.values()]
		const cleanup = [...this.#drain(error), ...this.#cleanOrphans(true)]
		const tasks = [...this.#workers, ...this.#admissions.values(), ...existing, ...cleanup]
		this.#wakeAll()
		this.#emitter.emit('abort', error)
		void this.#settleBarrier(barrier, tasks, 'queue abort cleanup failed')
		return barrier.promise
	}

	/**
	 * Reject non-active work and await its durable cleanup.
	 *
	 * @returns A promise that settles after every affected removal completes
	 */
	clear(): Promise<void> {
		if (this.#destroyPromise !== undefined) {
			return Promise.reject(new QueueError('queue is destroyed', { code: 'destroyed' }))
		}
		const existing: Array<Promise<void>> = []
		for (const [token, cleanup] of this.#cleanups) {
			if (!this.#claims.has(token)) existing.push(cleanup)
		}
		const cleanup = [
			...this.#drain(new QueueError('queue is cleared', { code: 'cleared' })),
			...this.#cleanOrphans(false),
		]
		return this.#finish(
			[...this.#admissions.values(), ...existing, ...cleanup],
			'queue clear cleanup failed',
		)
	}

	/**
	 * Tear down once, destroying the emitter only after cleanup finishes.
	 *
	 * @returns The stable destroy barrier
	 */
	destroy(): Promise<void> {
		if (this.#destroyPromise !== undefined) return this.#destroyPromise
		const barrier = Promise.withResolvers<void>()
		this.#destroyPromise = barrier.promise
		const aborting = this.abort(new QueueError('queue is destroyed', { code: 'destroyed' }))
		void this.#settleDestroy(barrier, aborting)
		return barrier.promise
	}

	#reserve(
		id: string,
		input: TInput,
		options: QueueEntryOptions | undefined,
		attempts: number,
	): PromiseWithResolvers<TResult> {
		const token = Promise.withResolvers<TResult>()
		this.#entries.set(token, { id, input, options, attempts, settled: false })
		this.#live.set(id, token)
		this.#drained = false
		return token
	}

	#schedule(token: PromiseWithResolvers<TResult>): void {
		const task = this.#admission.then(() => this.#admit(token))
		this.#admissions.set(token, task)
		this.#admission = task.catch(() => {})
		void task.finally(() => this.#admissions.delete(token)).catch(() => {})
	}

	async #admit(token: PromiseWithResolvers<TResult>): Promise<void> {
		const entry = this.#entries.get(token)
		if (entry === undefined || this.#store === undefined) return
		try {
			await this.#store.save({ id: entry.id, input: entry.input, attempts: entry.attempts })
		} catch (error: unknown) {
			try {
				await this.#cleanup(token)
			} catch (cleanup: unknown) {
				this.#settleToken(token, { success: false, error: cleanup })
				this.#emitDrain()
				throw cleanup
			}
			this.#settleToken(token, {
				success: false,
				error: new QueueError(
					error instanceof Error ? error.message : 'queue admission save failed',
					{
						code: 'store',
						cause: error,
						context: { id: entry.id, operation: 'save' },
					},
				),
			})
			this.#emitDrain()
			return
		}
		if (
			entry.settled ||
			this.#abortPromise !== undefined ||
			this.#destroyPromise !== undefined ||
			this.#stopped
		) {
			await this.#discard(token)
			return
		}
		this.#accept(token)
	}

	#accept(token: PromiseWithResolvers<TResult>): void {
		const entry = this.#entries.get(token)
		if (entry === undefined) return
		this.#pending.push(token)
		this.#emitter.emit('enqueue', entry.id)
		this.#spawn()
		this.#wake()
	}

	#spawn(): void {
		if (this.#stopped || this.#abortPromise !== undefined || this.#destroyPromise !== undefined)
			return
		const demand = Math.min(this.#concurrency, this.#claims.size + this.#pending.length)
		while (this.#workers.size < demand) {
			const generation = this.#generation
			const worker = this.#worker(generation)
			this.#workers.add(worker)
			void worker
				.finally(() => {
					this.#workers.delete(worker)
					this.#spawn()
				})
				.catch(() => {})
		}
	}

	async #worker(generation: number): Promise<void> {
		while (generation === this.#generation) {
			const token = await this.#next(generation)
			if (token === undefined) return
			try {
				await this.#run(token)
			} catch (error: unknown) {
				await this.#fail(token, error)
				throw error
			}
		}
	}

	#next(generation: number): Promise<PromiseWithResolvers<TResult> | undefined> {
		return new Promise((resolve) => this.#take(generation, resolve))
	}

	#take(
		generation: number,
		resolve: (token: PromiseWithResolvers<TResult> | undefined) => void,
	): void {
		if (
			generation !== this.#generation ||
			this.#stopped ||
			this.#abortPromise !== undefined ||
			this.#destroyPromise !== undefined
		) {
			resolve(undefined)
			return
		}
		if (this.#paused || this.#pending.length === 0) {
			this.#wakes.push(() => this.#take(generation, resolve))
			return
		}
		const token = this.#pending.shift()
		if (token === undefined) {
			this.#wakes.push(() => this.#take(generation, resolve))
			return
		}
		const entry = this.#entries.get(token)
		if (entry === undefined) {
			this.#take(generation, resolve)
			return
		}
		this.#claims.add(token)
		resolve(token)
	}

	#wake(): void {
		const resolver = this.#wakes.shift()
		if (resolver !== undefined) resolver()
	}

	#wakeAll(): void {
		const resolvers = this.#wakes.splice(0)
		for (const resolver of resolvers) resolver()
	}

	#drain(error: QueueError): ReadonlyArray<Promise<void>> {
		for (const token of this.#admissions.keys()) this.#settleToken(token, { success: false, error })
		const tokens = this.#pending.splice(0)
		const cleanup: Array<Promise<void>> = []
		for (const token of tokens) {
			this.#settleToken(token, { success: false, error })
			cleanup.push(this.#discard(token))
		}
		return cleanup
	}

	#cleanOrphans(claimed: boolean): ReadonlyArray<Promise<void>> {
		const cleanup: Array<Promise<void>> = []
		for (const token of this.#orphans) {
			if (claimed || !this.#claims.has(token)) cleanup.push(this.#discard(token))
		}
		return cleanup
	}

	async #discard(token: PromiseWithResolvers<TResult>): Promise<void> {
		try {
			await this.#cleanup(token)
		} finally {
			this.#emitDrain()
		}
	}

	#cleanup(token: PromiseWithResolvers<TResult>): Promise<void> {
		const current = this.#cleanups.get(token)
		if (current !== undefined) return current
		const barrier = Promise.withResolvers<void>()
		this.#cleanups.set(token, barrier.promise)
		void this.#clean(token, barrier)
		return barrier.promise
	}

	async #clean(
		token: PromiseWithResolvers<TResult>,
		barrier: PromiseWithResolvers<void>,
	): Promise<void> {
		const entry = this.#entries.get(token)
		if (entry === undefined) {
			barrier.resolve()
			this.#cleanups.delete(token)
			return
		}
		try {
			if (this.#store !== undefined) await this.#store.remove(entry.id)
			this.#release(token)
			barrier.resolve()
		} catch (error: unknown) {
			if (this.#live.get(entry.id) === token) this.#orphans.add(token)
			barrier.reject(
				new QueueError('queue entry cleanup failed', {
					code: 'cleanup',
					cause: error,
					context: { id: entry.id, operation: 'remove' },
				}),
			)
		} finally {
			if (this.#cleanups.get(token) === barrier.promise) this.#cleanups.delete(token)
		}
	}

	#release(token: PromiseWithResolvers<TResult>): void {
		const entry = this.#entries.get(token)
		if (entry === undefined || this.#live.get(entry.id) !== token) return
		this.#live.delete(entry.id)
		this.#orphans.delete(token)
		if (entry.settled) this.#entries.delete(token)
	}

	async #run(token: PromiseWithResolvers<TResult>): Promise<void> {
		const entry = this.#entries.get(token)
		if (entry === undefined) return
		const retries = entry.options?.retries ?? this.#retries
		const timeout = entry.options?.timeout ?? this.#timeout
		const signal = entry.options?.signal
		let completed = entry.attempts
		this.#emitter.emit('start', entry.id)
		while (true) {
			if (await this.#interrupt(token, signal)) return
			const outcome = await this.#attempt(entry.id, entry.input, timeout, signal)
			completed += 1
			if (outcome.success) {
				await this.#settle(token, outcome)
				return
			}
			if (await this.#interrupt(token, signal)) return
			if (completed > retries) {
				await this.#settle(token, outcome)
				return
			}
			await this.#saveAttempt(token, completed)
			this.#emitter.emit('retry', entry.id, completed)
		}
	}

	async #interrupt(
		token: PromiseWithResolvers<TResult>,
		signal: AbortSignal | undefined,
	): Promise<boolean> {
		const entry = this.#entries.get(token)
		if (entry === undefined) return true
		if (this.#abort.aborted) {
			await this.#settle(token, { success: false, error: this.#abort.signal.reason })
			return true
		}
		if (!signal?.aborted) return false
		await this.#settle(token, {
			success: false,
			error: new QueueError(
				signal.reason instanceof Error ? signal.reason.message : 'queue entry is aborted',
				{
					code: 'aborted',
					cause: signal.reason,
					context: { id: entry.id },
				},
			),
		})
		return true
	}

	async #saveAttempt(token: PromiseWithResolvers<TResult>, attempts: number): Promise<void> {
		const entry = this.#entries.get(token)
		if (this.#store === undefined || entry === undefined) return
		try {
			await this.#store.save({ id: entry.id, input: entry.input, attempts })
		} catch {
			// Live execution is authoritative; a crash may replay an earlier persisted attempt.
		}
	}

	async #fail(token: PromiseWithResolvers<TResult>, error: unknown): Promise<void> {
		if (!this.#claims.has(token)) return
		try {
			await this.#cleanup(token)
		} catch (cleanup: unknown) {
			this.#finishEntry(token, { success: false, error: cleanup })
			throw cleanup
		}
		this.#finishEntry(token, { success: false, error })
	}

	async #settle(
		token: PromiseWithResolvers<TResult>,
		outcome: Result<TResult, unknown>,
	): Promise<void> {
		try {
			await this.#cleanup(token)
		} catch (error: unknown) {
			this.#finishEntry(token, { success: false, error })
			throw error
		}
		this.#finishEntry(token, outcome)
	}

	#finishEntry(token: PromiseWithResolvers<TResult>, outcome: Result<TResult, unknown>): void {
		if (!this.#claims.delete(token)) return
		const entry = this.#entries.get(token)
		const drain = this.#latchDrain()
		if (entry === undefined || !this.#settleToken(token, outcome)) {
			if (drain) this.#emitter.emit('drain')
			return
		}
		if (outcome.success) this.#emitter.emit('success', entry.id, outcome.value)
		else this.#emitter.emit('failure', entry.id, outcome.error)
		if (drain) this.#emitter.emit('drain')
	}

	#settleToken(token: PromiseWithResolvers<TResult>, outcome: Result<TResult, unknown>): boolean {
		const entry = this.#entries.get(token)
		if (entry === undefined || entry.settled) return false
		entry.settled = true
		if (outcome.success) token.resolve(outcome.value)
		else token.reject(outcome.error)
		if (this.#live.get(entry.id) !== token) this.#entries.delete(token)
		return true
	}

	#latchDrain(): boolean {
		if (this.#drained || this.#claims.size !== 0 || this.#live.size !== 0) return false
		this.#drained = true
		return true
	}

	#emitDrain(): void {
		if (this.#latchDrain()) this.#emitter.emit('drain')
	}

	async #attempt(
		id: string,
		input: TInput,
		timeout: number,
		signal: AbortSignal | undefined,
	): Promise<Result<TResult>> {
		const cancel =
			signal === undefined ? this.#abort.signal : AbortSignal.any([this.#abort.signal, signal])
		let deadline: TimeoutInterface | undefined
		let attemptSignal = cancel
		if (timeout > 0) {
			deadline = createTimeout({ ms: timeout, signal: cancel })
			deadline.start()
			attemptSignal = AbortSignal.any([cancel, deadline.signal])
		}
		try {
			const value = await this.#race(id, input, attemptSignal, deadline)
			return { success: true, value }
		} catch (error: unknown) {
			return {
				success: false,
				error: error instanceof Error ? error : new Error(preview(error), { cause: error }),
			}
		} finally {
			deadline?.clear()
		}
	}

	#race(
		id: string,
		input: TInput,
		signal: AbortSignal,
		deadline: TimeoutInterface | undefined,
	): Promise<TResult> {
		if (signal.aborted) {
			return Promise.reject(
				new QueueError(
					deadline?.expired === true ? 'queue attempt timed out' : 'queue attempt aborted',
					{
						code: deadline?.expired === true ? 'timeout' : 'aborted',
						cause: signal.reason,
						context: { id },
					},
				),
			)
		}
		const cleanup = new AbortController()
		return new Promise<TResult>((resolve, reject) => {
			signal.addEventListener(
				'abort',
				() =>
					reject(
						new QueueError(
							deadline?.expired === true ? 'queue attempt timed out' : 'queue attempt aborted',
							{
								code: deadline?.expired === true ? 'timeout' : 'aborted',
								cause: signal.reason,
								context: { id },
							},
						),
					),
				{ once: true, signal: cleanup.signal },
			)
			try {
				Promise.resolve(this.#handler(input, { id, signal })).then(
					(value) => {
						cleanup.abort()
						resolve(value)
					},
					(error: unknown) => {
						cleanup.abort()
						reject(error)
					},
				)
			} catch (error: unknown) {
				cleanup.abort()
				reject(error)
			}
		})
	}

	async #finish(tasks: ReadonlyArray<Promise<void>>, message: string): Promise<void> {
		const results = await Promise.allSettled(tasks)
		const errors: unknown[] = []
		for (const result of results) {
			if (result.status === 'rejected' && !errors.includes(result.reason)) {
				errors.push(result.reason)
			}
		}
		if (errors.length === 0) return
		const error = errors[0]
		if (errors.length === 1 && isQueueError(error)) throw error
		throw new QueueError(message, {
			code: 'cleanup',
			cause: new AggregateError(errors, message),
			context: { operation: 'remove' },
		})
	}

	async #settleBarrier(
		barrier: PromiseWithResolvers<void>,
		tasks: ReadonlyArray<Promise<void>>,
		message: string,
	): Promise<void> {
		try {
			await this.#finish(tasks, message)
			barrier.resolve()
		} catch (error: unknown) {
			barrier.reject(error)
		}
	}

	async #settleDestroy(
		barrier: PromiseWithResolvers<void>,
		aborting: Promise<void>,
	): Promise<void> {
		let failure: unknown
		try {
			await aborting
		} catch (error: unknown) {
			failure = error
		}
		try {
			await this.#finish(
				[
					...this.#workers,
					...this.#admissions.values(),
					...this.#cleanups.values(),
					...this.#cleanOrphans(true),
				],
				'queue destroy cleanup failed',
			)
		} catch (error: unknown) {
			failure =
				failure === undefined
					? error
					: new QueueError('queue destroy cleanup failed', {
							code: 'cleanup',
							cause: new AggregateError([failure, error], 'queue destroy cleanup failed'),
							context: { operation: 'remove' },
						})
		} finally {
			this.#emitter.destroy()
		}
		if (failure === undefined) barrier.resolve()
		else barrier.reject(failure)
	}
}
