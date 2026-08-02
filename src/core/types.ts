import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '@orkestrel/emitter'

/**
 * Machine-readable queue failure categories.
 *
 * @example
 * ```ts
 * const code: QueueCode = 'cleanup'
 * ```
 */
export type QueueCode =
	| 'invalid'
	| 'duplicate'
	| 'stopped'
	| 'aborted'
	| 'destroyed'
	| 'cleared'
	| 'timeout'
	| 'store'
	| 'cleanup'

/**
 * Structured context carried by a {@link QueueError}.
 *
 * @example
 * ```ts
 * const context: QueueErrorContext = { id: 'job-1', operation: 'remove' }
 * ```
 */
export interface QueueErrorContext {
	readonly id?: string
	readonly option?: 'id' | 'concurrency' | 'retries' | 'timeout' | 'signal'
	readonly operation?: 'save' | 'remove' | 'load' | 'clear'
	readonly value?: unknown
}

/**
 * Construction options for a {@link QueueError}.
 *
 * @example
 * ```ts
 * const options: QueueErrorOptions = { code: 'invalid', context: { option: 'id' } }
 * ```
 */
export interface QueueErrorOptions {
	readonly code: QueueCode
	readonly context?: QueueErrorContext
	readonly cause?: unknown
}

/**
 * The push observation surface of a {@link QueueInterface} (AGENTS §13) — the lifecycle
 * moments a fire-and-forget observer (logging, metrics, tracing) subscribes to, ALONGSIDE
 * the per-entry `enqueue` promise.
 *
 * @typeParam TResult - The value an entry resolves (the `success` payload), mirroring the
 *   {@link QueueInterface}'s own `TResult` — so the map is `QueueEventMap<TResult>`.
 *
 * @remarks
 * Listener isolation is the emitter's (AGENTS §13): every event is emitted directly and a
 * listener throw is routed to the emitter's OWN `error` handler (the `error` option), never
 * onto this domain map and never into the cooperative wake-park / settle-once engine — so a
 * buggy observer can never reorder, throw into, or corrupt the queue. Every emit sits AFTER
 * the relevant wake / park / settle transition, so observation is purely a side-channel: a
 * throwing observer cannot unbalance `active` or strand a parked worker. Subscribe via
 * `queue.emitter.on(...)`.
 *
 * Declared as a `type` alias (not `interface extends EventMap`, §4.5 — `EventMap` is a
 * `type` kind): a type-literal satisfies the `EventMap` constraint
 * (`Record<string, readonly unknown[]>`) structurally, whereas an interface lacks the
 * required index signature.
 *
 * @example
 * ```ts
 * const hooks: EmitterHooks<QueueEventMap<number>> = { success: (_id, result) => report(result) }
 * ```
 */
export type QueueEventMap<TResult> = {
	/** An entry was accepted (and durably persisted, when a store is set) — its id. */
	readonly enqueue: readonly [id: string]
	/** An attempt began running — the entry's id (after it was dequeued, in flight). */
	readonly start: readonly [id: string]
	/** A failed attempt is being retried — the entry id + completed-attempt count. */
	readonly retry: readonly [id: string, attempt: number]
	/** An entry settled successfully — its id + the resolved result. */
	readonly success: readonly [id: string, result: TResult]
	/** An entry settled with a terminal failure — its id + the error (always `unknown`). */
	readonly failure: readonly [id: string, error: unknown]
	/** The queue was aborted — its coded abort error. */
	readonly abort: readonly [reason: unknown]
	/** The queue transitioned to no reserved live ids (drained). */
	readonly drain: readonly []
}

/**
 * The per-attempt execution handle a queue handler receives.
 *
 * @example
 * ```ts
 * const handler: QueueHandler<string, string> = (input, { id, signal }) =>
 * 	signal.aborted ? id : input
 * ```
 */
export interface QueueExecution {
	/**
	 * The entry's stable id — equal across every attempt and across a crash-replay
	 * (`restore` re-runs an entry under its original id). Durable persistence is
	 * at-least-once (a crash between handler-success and the store's `remove`, or a
	 * failed `remove`, re-runs the entry), so use this id to make a handler idempotent
	 * — de-dup against it over the replay window.
	 */
	readonly id: string
	/** Fires on the per-attempt timeout, a queue-level abort, or the entry's own signal. */
	readonly signal: AbortSignal
}

/**
 * Runs one queued entry's work; may reject to trigger a retry.
 *
 * @typeParam TInput - The work input
 * @typeParam TResult - The resolved work result
 *
 * @example
 * ```ts
 * const handler: QueueHandler<number, number> = (input) => input * 2
 * ```
 */
export type QueueHandler<TInput, TResult> = (
	input: TInput,
	execution: QueueExecution,
) => Promise<TResult> | TResult

/**
 * Per-entry options for `enqueue`.
 *
 * @remarks
 * - `id` — a trace label for the entry; defaults to a random UUID.
 * - `retries` — extra attempts after the first on failure (or a per-attempt
 *   timeout); overrides the queue default. A queue-level abort never retries.
 * - `timeout` — the nonnegative integer per-attempt deadline in milliseconds, at most
 *   `2_147_483_647`; overrides the queue default. Zero means no deadline.
 * - `signal` — an entry-scoped abort; once it fires the entry rejects (its
 *   in-flight attempt's `signal` fires too) and does not retry.
 *
 * @example
 * ```ts
 * const options: QueueEntryOptions = { id: 'job-1', retries: 2, timeout: 500 }
 * ```
 */
export interface QueueEntryOptions {
	readonly id?: string
	readonly retries?: number
	readonly timeout?: number
	readonly signal?: AbortSignal
}

/**
 * Options for `createQueue`.
 *
 * @remarks
 * - `handler` — runs each entry's work; rejecting triggers a retry while attempts
 *   remain.
 * - `concurrency` — the maximum number of entries in flight at once; defaults to
 *   `1` and must be a positive safe integer.
 * - `retries` — the default extra attempts per entry on failure; defaults to `0`
 *   and must be a nonnegative safe integer.
 * - `timeout` — the default per-attempt deadline in integer milliseconds; defaults to zero
 *   and must be between zero and `2_147_483_647`, inclusive.
 * - `store` — durable backing; outstanding entries survive a restart; call
 *   `restore()` to re-run them.
 * - `on` — the reserved {@link EmitterHooks} key (§8): initial listeners for the queue's
 *   {@link QueueEventMap}, wired at construction (e.g. `{ drain: () => log('idle') }`).
 *
 * @example
 * ```ts
 * const options: QueueOptions<number, number> = { handler: (input) => input, concurrency: 2 }
 * ```
 */
export interface QueueOptions<TInput, TResult> {
	readonly on?: EmitterHooks<QueueEventMap<TResult>>
	/** The emitter's listener-error handler (AGENTS §13) — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	readonly handler: QueueHandler<TInput, TResult>
	readonly concurrency?: number
	readonly retries?: number
	readonly timeout?: number
	readonly store?: QueueStoreInterface<TInput>
}

/**
 * A concurrent, cooperative job queue.
 *
 * @remarks
 * Exposes a typed {@link emitter} (AGENTS §13) carrying its lifecycle moments
 * ({@link QueueEventMap}) for fire-and-forget observers, ALONGSIDE each `enqueue` promise.
 * Emitting is observation-only — every event fires AFTER the relevant wake / park / settle
 * transition, so a buggy observer can never reorder or corrupt the wake-park / settle-once
 * engine: the emitter isolates a listener throw and routes it to its `error` handler (the
 * `error` option), never the engine. Subscribe via `queue.emitter.on(...)`.
 *
 * @example
 * ```ts
 * const queue: QueueInterface<number, number> = createQueue({ handler: (input) => input })
 * ```
 */
export interface QueueInterface<TInput, TResult> {
	readonly emitter: EmitterInterface<QueueEventMap<TResult>>
	readonly count: number
	readonly active: number
	readonly paused: boolean
	readonly stopped: boolean
	/** Reserve and submit one FIFO entry. */
	enqueue(input: TInput, options?: QueueEntryOptions): Promise<TResult>
	/** Re-enqueue outstanding entries loaded from the store; no-op without a store. */
	restore(): Promise<void>
	/** Begin or restart worker execution. */
	start(): void
	/** Reject non-active work and await current-loop/durable quiescence. */
	stop(): Promise<void>
	/** Suspend new execution resumably. */
	pause(): void
	/** Continue execution after a pause. */
	resume(): void
	/** Cancel active work, reject pending work, and await cleanup. */
	abort(reason?: unknown): Promise<void>
	/** Reject non-active work and await its durable cleanup. */
	clear(): Promise<void>
	/** Tear down idempotently and destroy observation last. */
	destroy(): Promise<void>
}

/**
 * A durably persisted, still-outstanding queue entry — re-run after a restart.
 *
 * @remarks
 * The store holds only entries that have NOT yet completed, so what `load`
 * returns on startup is exactly the work to resume. `id` keys the entry (the
 * store upserts by it); `input` is the handler's work payload (it must be
 * JSON-serializable to survive a JSON / SQLite driver); `attempts` is how many
 * times the entry has been tried so far.
 *
 * @example
 * ```ts
 * const entry: StoredEntry<string> = { id: 'job-1', input: 'task', attempts: 0 }
 * ```
 */
export interface StoredEntry<TInput> {
	readonly id: string
	readonly input: TInput
	readonly attempts: number
}

/**
 * Durable backing for a Queue's outstanding entries.
 *
 * @remarks
 * The store holds ONLY work that has not yet completed: `save` upserts an entry
 * (by its `id`), `remove` drops a finished one, `load` returns everything
 * outstanding (to restore a queue after a restart), and `clear` empties it. It is
 * a minimal interface (AGENTS §21) over the `databases` layer — a queue's durable
 * state is just a table — so any `DriverInterface` backend (memory, JSON, SQLite)
 * persists it without the store knowing which.
 *
 * @typeParam TInput - The work input each {@link StoredEntry} carries
 *
 * @example
 * ```ts
 * const store: QueueStoreInterface<string> = createMemoryQueueStore(stringShape())
 * ```
 */
export interface QueueStoreInterface<TInput> {
	save(entry: StoredEntry<TInput>): Promise<void>
	remove(id: string): Promise<void>
	load(): Promise<readonly StoredEntry<TInput>[]>
	clear(): Promise<void>
}
