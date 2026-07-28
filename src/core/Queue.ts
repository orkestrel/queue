import type { AbortInterface } from '@orkestrel/abort'
import type { Result } from '@orkestrel/contract'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { TimeoutInterface } from '@orkestrel/timeout'
import type {
	QueueEntry,
	QueueEntryOptions,
	QueueEventMap,
	QueueHandler,
	QueueInterface,
	QueueOptions,
	QueueStoreInterface,
} from './types.js'
import { createAbort } from '@orkestrel/abort'
import { Emitter } from '@orkestrel/emitter'
import { createTimeout } from '@orkestrel/timeout'
import { createAttemptError } from './helpers.js'

/**
 * A concurrent, cooperative job queue.
 *
 * @remarks
 * - **Cooperative wake-park loop.** Up to `concurrency` worker loops run; each
 *   takes the next pending entry, or — when none is ready (empty or paused) —
 *   PARKS by awaiting a fresh promise whose resolver is held in a wake list.
 *   `enqueue` / `resume` resolve one parked resolver to wake exactly one worker,
 *   so idle workers consume no CPU (no busy-poll, no timers, no recursion).
 * - **FIFO + bounded concurrency.** Entries run in enqueue order; at most
 *   `concurrency` are in flight at once (default `1` = strictly ordered). A surplus
 *   entry waits for a worker to free up.
 * - **Per-attempt deadline + cancellation.** Each attempt's `signal` (handed to the
 *   handler) fires on the per-attempt `Timeout` expiring, a queue-level `abort`, or
 *   the entry's own `signal`. The handler is RACED against that signal, so an attempt
 *   that ignores its `signal` still fails on the deadline. Built on the L1 `Abort` /
 *   `Timeout` primitives (a queue / entry abort CLEARS the deadline, never expires it).
 * - **Retries.** A failed attempt (a handler rejection or a per-attempt timeout)
 *   retries while attempts remain (`retries` + 1 total). A queue-level abort NEVER
 *   retries — it rejects the entry at once; an entry-`signal` abort likewise.
 * - **Lifecycle (§10).** `pause` parks workers; `resume` wakes them; `stop` ends the
 *   loops permanently and rejects pending (in-flight settle); `abort` fires the queue
 *   signal (cancelling in-flight attempts) and rejects pending; `clear` drops only
 *   pending; `destroy` aborts then stops, idempotently.
 * - **Durability (optional `store`).** The store mirrors only OUTSTANDING work: an
 *   entry is `save`d on accept (and re-`save`d as its attempt count climbs) and
 *   `remove`d the moment it settles (success or terminal failure) or is drained by a
 *   lifecycle call. Accepting work durably is NOT best-effort — a failed initial `save`
 *   rejects the enqueue; per-attempt persistence IS best-effort (in-memory state is
 *   authoritative). A graceful shutdown empties the store; a crash leaves rows that
 *   `restore()` re-runs at their persisted attempt count (queue-default retries /
 *   timeout, no per-entry signal). At-least-once — handlers should be idempotent.
 * - **Observable (§13).** The owned {@link emitter} ({@link QueueEventMap}) carries the
 *   lifecycle moments — `enqueue` / `start` / `retry` / `success` / `failure` / `abort` /
 *   `drain` — for fire-and-forget observers. Every event is emitted directly, strictly AFTER
 *   the relevant wake / park / settle transition; the emitter isolates a listener throw and
 *   routes it to its `error` handler (the `error` option), so a buggy observer can NEVER
 *   reorder, throw into, or corrupt the cooperative wake-park / settle-once engine: `active`
 *   stays balanced and no parked worker is stranded regardless of what a listener does.
 *   Observation is purely a side-channel.
 */
export class Queue<TInput, TResult> implements QueueInterface<TInput, TResult> {
	readonly #handler: QueueHandler<TInput, TResult>
	readonly #concurrency: number
	readonly #retries: number
	readonly #timeout: number
	// Optional durable backing — mirrors outstanding entries so a restart can resume them.
	readonly #store: QueueStoreInterface<TInput> | undefined
	// The queue-level cancellation — its signal is a parent of every attempt's signal.
	readonly #abort: AbortInterface = createAbort()
	// The PUSH observation surface (§13) — owned, never inherited. The emitter isolates a
	// listener throw (routing it to the `error` handler), so it can never escape into the
	// wake-park / settle-once loop.
	readonly #emitter: Emitter<QueueEventMap<TResult>>

	readonly #pending: QueueEntry<TInput, TResult>[] = []
	// The ids of LIVE entries — pending or in-flight on THIS queue. An id is added when
	// an entry is accepted (enqueue / restore launch) and removed when it settles or is
	// drained. `restore` skips any id already here, so it is idempotent + safe on a
	// non-idle queue (it re-launches only genuinely-outstanding-but-not-live rows).
	readonly #live = new Set<string>()
	// Resolvers of parked worker loops, woken one-at-a-time (FIFO).
	readonly #wakes: (() => void)[] = []
	#active = 0
	#running = 0
	#paused = false
	#stopped = false
	#aborted = false
	#destroyed = false

	constructor(options: QueueOptions<TInput, TResult>) {
		this.#handler = options.handler
		this.#concurrency = Math.max(1, options.concurrency ?? 1)
		this.#retries = Math.max(0, options.retries ?? 0)
		this.#timeout = Math.max(0, options.timeout ?? 0)
		this.#store = options.store
		this.#emitter = new Emitter<QueueEventMap<TResult>>({
			...(options.on !== undefined ? { on: options.on } : {}),
			...(options.error !== undefined ? { error: options.error } : {}),
		})
		this.#spawn()
	}

	get emitter(): EmitterInterface<QueueEventMap<TResult>> {
		return this.#emitter
	}

	get count(): number {
		return this.#pending.length + this.#active
	}

	get active(): number {
		return this.#active
	}

	get paused(): boolean {
		return this.#paused
	}

	get stopped(): boolean {
		return this.#stopped || this.#aborted
	}

	enqueue(input: TInput, options?: QueueEntryOptions): Promise<TResult> {
		if (this.#destroyed) return Promise.reject(new Error('queue is destroyed'))
		if (this.#aborted) return Promise.reject(new Error('queue is aborted'))
		if (this.#stopped) return Promise.reject(new Error('queue is stopped'))
		const id = options?.id ?? crypto.randomUUID()
		// Durable backing: persist the entry BEFORE it becomes runnable, so accepting
		// work is durable (a failed initial `save` rejects the enqueue).
		if (this.#store !== undefined) return this.#persist(this.#store, id, input, options)
		// No store: keep the fast path 100% synchronous — push and wake within the
		// executor so `count` reflects the entry the moment `enqueue` returns.
		return new Promise<TResult>((resolve, reject) => {
			this.#live.add(id)
			this.#pending.push({ id, input, options, attempts: 0, resolve, reject })
			// Observe the accepted entry — AFTER it is live + pending, BEFORE `#wake` (never
			// inside the wake resolver-shift), so a swallowed listener throw can't perturb the
			// worker the wake is about to release.
			this.#emitter.emit('enqueue', id)
			this.#wake()
		})
	}

	async restore(): Promise<void> {
		if (this.#store === undefined || this.#stopped || this.#aborted || this.#destroyed) return
		const entries = await this.#store.load()
		// The queue may have been aborted / destroyed during the `load()` await — re-check
		// the halt flags before launching, so nothing is pushed that would never run + never
		// settle (mirrors `#persist`'s post-await re-check).
		if (this.#destroyed || this.#aborted || this.#stopped) return
		for (const entry of entries) {
			// Idempotent + safe on a live queue: a row whose id is ALREADY live (pending or
			// in-flight) is skipped, so `restore()` never double-launches an id that is still
			// running — it re-launches only genuinely-outstanding-but-not-live rows.
			if (this.#live.has(entry.id)) continue
			// Resume each at its persisted attempt count. There is no original caller, so
			// swallow a terminal rejection on the result promise (it isn't an unhandled
			// rejection); the row is still removed by `#run`'s settle. Restored entries use
			// the queue-default retries / timeout and carry no per-entry signal.
			const result = new Promise<TResult>((resolve, reject) => {
				this.#live.add(entry.id)
				this.#pending.push({
					id: entry.id,
					input: entry.input,
					options: undefined,
					attempts: entry.attempts,
					resolve,
					reject,
				})
				// A restored row is an accepted entry — observe it like a fresh `enqueue`, AFTER
				// it is live + pending and BEFORE `#wake`.
				this.#emitter.emit('enqueue', entry.id)
				this.#wake()
			})
			result.catch(() => {})
		}
	}

	start(): void {
		if (this.#aborted || this.#destroyed) return
		this.#stopped = false
		this.#spawn()
	}

	stop(): void {
		if (this.#stopped) return
		this.#stopped = true
		this.#drain(new Error('queue is stopped'))
		this.#wakeAll()
	}

	pause(): void {
		if (this.#paused || this.stopped || this.#destroyed) return
		this.#paused = true
	}

	resume(): void {
		if (!this.#paused || this.stopped || this.#destroyed) return
		this.#paused = false
		this.#wakeAll()
	}

	abort(reason?: unknown): void {
		if (this.#aborted) return
		this.#aborted = true
		this.#abort.abort(reason)
		this.#drain(this.#abort.signal.reason)
		this.#wakeAll()
		// Observe the abort — AFTER the queue signal fired, pending was drained, and the
		// parked workers were woken, so a swallowed listener throw can't perturb the cancel.
		this.#emitter.emit('abort', this.#abort.signal.reason)
	}

	clear(): void {
		this.#drain(new Error('queue cleared'))
	}

	destroy(): void {
		if (this.#destroyed) return
		this.#destroyed = true
		this.abort()
		this.#stopped = true
		this.#wakeAll()
	}

	// Spawn worker loops up to `concurrency`, unless the queue is no longer running.
	#spawn(): void {
		if (this.#stopped || this.#aborted || this.#destroyed) return
		while (this.#running < this.#concurrency) {
			this.#running += 1
			void this.#worker()
		}
	}

	// One cooperative worker loop: take the next entry or park; exit when halted.
	async #worker(): Promise<void> {
		try {
			while (true) {
				const entry = await this.#next()
				if (entry === undefined) break
				this.#active += 1
				try {
					await this.#run(entry)
				} finally {
					this.#active -= 1
					// Observe the queue going idle — AFTER the settle balanced `#active` back
					// down; the entry that just finished was the last in flight and nothing is
					// pending, so this is the clean drained boundary (the transition fires once,
					// since exactly one decrement brings `#active` to 0 with an empty backlog).
					if (this.#active === 0 && this.#pending.length === 0) this.#emitter.emit('drain')
				}
			}
		} finally {
			this.#running -= 1
		}
	}

	// The park point: resolve to the next ready entry, or `undefined` once halted.
	#next(): Promise<QueueEntry<TInput, TResult> | undefined> {
		return new Promise((resolve) => this.#take(resolve))
	}

	// Resolve one parked worker with an entry or halt signal; otherwise park it again.
	#take(resolve: (entry: QueueEntry<TInput, TResult> | undefined) => void): void {
		if (this.#stopped || this.#aborted || this.#destroyed) {
			resolve(undefined)
			return
		}
		if (this.#paused || this.#pending.length === 0) {
			this.#wakes.push(() => this.#take(resolve))
			return
		}
		resolve(this.#pending.shift())
	}

	// Wake exactly one parked worker (FIFO) — for a single new entry.
	#wake(): void {
		const resolver = this.#wakes.shift()
		if (resolver !== undefined) resolver()
	}

	// Wake every parked worker — for resume / halt, where all must re-check.
	#wakeAll(): void {
		const resolvers = this.#wakes.splice(0)
		for (const resolver of resolvers) resolver()
	}

	// Reject and discard every pending entry (in-flight entries are untouched). The
	// in-memory drain stays synchronous; the store catches up via a fire-and-forget
	// `remove` per drained entry (its rejection swallowed). In-flight rows are removed
	// by their own settle, not wiped here — so a precise `remove`, never `store.clear()`.
	#drain(error: unknown): void {
		while (this.#pending.length > 0) {
			const entry = this.#pending.shift()
			if (entry === undefined) continue
			this.#live.delete(entry.id)
			void this.#store?.remove(entry.id).catch(() => {})
			entry.reject(error)
		}
	}

	// Durably accept an entry: `save` it (at `attempts: 0`) BEFORE it becomes runnable,
	// so accepting work is durable. A failed initial `save` PROPAGATES (rejects the
	// enqueue). The queue may have died during the `await`, so re-check the halt flags
	// afterwards — if so, remove the just-saved row and reject rather than running it.
	async #persist(
		store: QueueStoreInterface<TInput>,
		id: string,
		input: TInput,
		options: QueueEntryOptions | undefined,
	): Promise<TResult> {
		await store.save({ id, input, attempts: 0 })
		if (this.#destroyed || this.#aborted || this.#stopped) {
			await store.remove(id).catch(() => {})
			throw new Error('queue is stopped')
		}
		return new Promise<TResult>((resolve, reject) => {
			this.#live.add(id)
			this.#pending.push({ id, input, options, attempts: 0, resolve, reject })
			// Observe the durably-accepted entry — AFTER the `save` succeeded + it is live +
			// pending, BEFORE `#wake`.
			this.#emitter.emit('enqueue', id)
			this.#wake()
		})
	}

	// Best-effort persist of the climbing attempt count on a retry — in-memory state is
	// authoritative, so a store error is swallowed (the entry keeps running regardless).
	async #saveAttempt(entry: QueueEntry<TInput, TResult>, attempts: number): Promise<void> {
		try {
			await this.#store?.save({ id: entry.id, input: entry.input, attempts })
		} catch {
			// Per-attempt persistence is best-effort; the in-memory attempt count is the truth.
		}
	}

	// Run one entry through its attempts, settling the promise `enqueue` returned.
	// Resumes at `entry.attempts` (0 for fresh, the persisted count when restored), so
	// the retry budget is honoured across a restart. Every terminal exit removes the
	// durable row BEFORE settling (`#settle`); a queue / entry abort never retries.
	async #run(entry: QueueEntry<TInput, TResult>): Promise<void> {
		const retries = Math.max(0, entry.options?.retries ?? this.#retries)
		const timeout = Math.max(0, entry.options?.timeout ?? this.#timeout)
		const signal = entry.options?.signal
		// Observe the attempt beginning — the entry is already dequeued and `#active` was
		// incremented by `#worker`, so this is strictly after that transition (NOT inside the
		// park `take`); the per-attempt `#race` below is left emit-free.
		this.#emitter.emit('start', entry.id)
		for (let attempt = entry.attempts; ; attempt += 1) {
			// A queue / entry abort rejects at once — never retried.
			if (this.#abort.aborted)
				return this.#settle(entry, { success: false, error: this.#abort.signal.reason })
			if (signal?.aborted) return this.#settle(entry, { success: false, error: signal.reason })
			// On a RETRY only, persist the climbing attempt count (best-effort) + observe the
			// retry — AFTER the prior attempt failed, BEFORE re-running (the 1-based attempt no.).
			if (attempt > entry.attempts) {
				await this.#saveAttempt(entry, attempt)
				this.#emitter.emit('retry', entry.id, attempt)
			}
			const outcome = await this.#attempt(entry.id, entry.input, timeout, signal)
			if (outcome.success) return this.#settle(entry, { success: true, value: outcome.value })
			if (this.#abort.aborted)
				return this.#settle(entry, { success: false, error: this.#abort.signal.reason })
			if (signal?.aborted) return this.#settle(entry, { success: false, error: signal.reason })
			if (attempt < retries) continue
			return this.#settle(entry, { success: false, error: outcome.error })
		}
	}

	// Settle one entry from a `#run` exit. WITHOUT a store there is nothing to remove, so
	// settle (resolve / reject) SYNCHRONOUSLY and return `void` — no awaited call, no
	// thenable to adopt — so the no-store path's microtask timing is byte-for-byte as before
	// (`#active` decrements exactly when it always did). WITH a store, return the async
	// remove-then-settle so the durable row is gone before the promise settles. A single
	// helper keeps the four exit points clean and the `TResult` type at the call site. The
	// `outcome` carries what to settle WITH so the terminal `success` / `failure` event fires
	// strictly AFTER the resolve / reject (and after the durable `remove` on the store path),
	// in the same microtask position the settle has always occupied — observation only.
	#settle(entry: QueueEntry<TInput, TResult>, outcome: Result<TResult>): void | Promise<void> {
		// The entry is no longer live — drop its id so a concurrent `restore` may re-launch
		// the row should it linger in the store (the single removal point for a settled run,
		// balancing every accept; the drain path removes the ids it rejects instead).
		this.#live.delete(entry.id)
		if (this.#store === undefined) {
			this.#commit(entry, outcome)
			return
		}
		return this.#forget(this.#store, entry, outcome)
	}

	// Resolve / reject the entry, THEN observe the terminal settle. The resolve / reject runs
	// FIRST and unchanged (the promise settles exactly as before); the emit is strictly after
	// it, so an isolated listener throw can't reorder or re-enter the settle-once latch.
	#commit(entry: QueueEntry<TInput, TResult>, outcome: Result<TResult>): void {
		if (outcome.success) {
			entry.resolve(outcome.value)
			this.#emitter.emit('success', entry.id, outcome.value)
		} else {
			entry.reject(outcome.error)
			this.#emitter.emit('failure', entry.id, outcome.error)
		}
	}

	// Best-effort remove the durable row (swallowing any store error → at-least-once), THEN
	// commit the settle — so a completed entry's promise resolves only after its row is gone
	// (a `load()` after `await`ing the entry sees it removed), and the terminal event fires
	// after that (`#commit`).
	async #forget(
		store: QueueStoreInterface<TInput>,
		entry: QueueEntry<TInput, TResult>,
		outcome: Result<TResult>,
	): Promise<void> {
		try {
			await store.remove(entry.id)
		} catch {
			// Best-effort: the in-memory settle is authoritative; a failed remove leaves a
			// stale row that `restore()` would re-run (at-least-once) — handlers stay idempotent.
		}
		this.#commit(entry, outcome)
	}

	// One attempt: build the combined signal, race the handler against it, settle.
	async #attempt(
		id: string,
		input: TInput,
		timeout: number,
		signal: AbortSignal | undefined,
	): Promise<Result<TResult>> {
		// Cancellation = the queue abort, plus the entry's own signal when present.
		const cancel =
			signal === undefined ? this.#abort.signal : AbortSignal.any([this.#abort.signal, signal])
		// A deadline that the cancellation CLEARS (never expires); the handler's signal
		// fires on cancellation OR on the deadline expiring.
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
			// A non-`Error` handler rejection is wrapped, preserving the original as `cause`.
			return {
				success: false,
				error: error instanceof Error ? error : new Error(String(error), { cause: error }),
			}
		} finally {
			deadline?.clear()
		}
	}

	// Race the handler against its signal: the deadline expiring or a cancellation
	// settles the attempt as a failure even if the handler ignores its `signal`. The
	// handler receives the entry's stable `id` (its idempotency key — equal across every
	// attempt and a crash-replay) plus the per-attempt `signal`.
	#race(
		id: string,
		input: TInput,
		signal: AbortSignal,
		deadline: TimeoutInterface | undefined,
	): Promise<TResult> {
		if (signal.aborted) return Promise.reject(createAttemptError(deadline?.expired === true))
		const cleanup = new AbortController()
		return new Promise<TResult>((resolve, reject) => {
			signal.addEventListener(
				'abort',
				() => reject(createAttemptError(deadline?.expired === true)),
				{
					once: true,
					signal: cleanup.signal,
				},
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
}
