import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '@orkestrel/emitter'

/**
 * Represents the machine-readable queue failure categories.
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
 * Represents the construction and per-entry option keys a queue validates.
 *
 * @example
 * ```ts
 * const option: QueueOption = 'concurrency'
 * ```
 */
export type QueueOption = 'id' | 'concurrency' | 'retries' | 'timeout' | 'signal'

/**
 * Represents the structured context carried by a {@link QueueError}.
 *
 * @example
 * ```ts
 * const context: QueueErrorContext = { id: 'job-1', operation: 'remove' }
 * ```
 */
export interface QueueErrorContext {
	readonly id?: string
	readonly option?: QueueOption
	readonly operation?: 'save' | 'remove' | 'load' | 'clear'
	readonly value?: unknown
}

/**
 * Represents the construction options for a {@link QueueError}.
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
 * Represents the push observation surface of a {@link QueueInterface} — the lifecycle
 * moments a fire-and-forget observer (logging, metrics, tracing) subscribes to, ALONGSIDE
 * the per-entry `enqueue` promise.
 *
 * @typeParam TResult - The value an entry resolves (the `success` payload), mirroring the
 *   {@link QueueInterface}'s own `TResult` — so the map is `QueueEventMap<TResult>`.
 *
 * @remarks
 * Listener isolation is the emitter's: every event is emitted directly and a
 * listener throw is routed to the emitter's OWN `error` handler (the `error` option), never
 * onto this domain map and never into the cooperative wake-park / settle-once engine — so a
 * buggy observer can never reorder, throw into, or corrupt the queue. Every emit sits AFTER
 * the relevant wake / park / settle transition, so observation is purely a side-channel: a
 * throwing observer cannot unbalance `active` or strand a parked worker. Subscribe through
 * `queue.emitter.on(...)`.
 *
 * Declared as a `type` alias (not `interface extends EventMap` — `EventMap` is a
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
	/** Signals that an entry was accepted (and durably persisted, when a store is set) — its id. */
	readonly enqueue: readonly [id: string]
	/** Signals that an attempt began running — the entry's id (after it was dequeued, in flight). */
	readonly start: readonly [id: string]
	/** Signals that a failed attempt is being retried — the entry id + completed-attempt count. */
	readonly retry: readonly [id: string, attempt: number]
	/** Signals that an entry settled successfully — its id + the resolved result. */
	readonly success: readonly [id: string, result: TResult]
	/** Signals that an entry settled with a terminal failure — its id + the error (always `unknown`). */
	readonly failure: readonly [id: string, error: unknown]
	/** Signals that the queue was aborted — its coded abort error. */
	readonly abort: readonly [reason: unknown]
	/** Signals that the queue transitioned to no reserved live ids (drained). */
	readonly drain: readonly []
}

/**
 * Represents the per-attempt execution handle a queue handler receives.
 *
 * @example
 * ```ts
 * const handler: QueueHandler<string, string> = (input, { id, signal }) =>
 * 	signal.aborted ? id : input
 * ```
 */
export interface QueueContext {
	/**
	 * Holds the entry's stable id — equal across every attempt and across a crash-replay
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
	context: QueueContext,
) => Promise<TResult> | TResult

/**
 * Represents the per-entry options for `enqueue`.
 *
 * @remarks
 * - `id` — a trace label for the entry. Default: a random UUID.
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
 * Represents the options for `createQueue`.
 *
 * @remarks
 * - `handler` — runs each entry's work; rejecting triggers a retry while attempts
 *   remain.
 * - `concurrency` — the maximum number of entries in flight at once. Default: `1`.
 *   Must be a positive safe integer.
 * - `retries` — the default extra attempts per entry on failure. Default: `0`.
 *   Must be a nonnegative safe integer.
 * - `timeout` — the default per-attempt deadline in integer milliseconds. Default: `0`,
 *   which disables the deadline. Must be between `0` and `2_147_483_647`, inclusive.
 * - `store` — durable backing; outstanding entries survive a restart; call
 *   `restore()` to re-run them.
 * - `on` — the reserved {@link EmitterHooks} key: initial listeners for the queue's
 *   {@link QueueEventMap}, wired at construction, for example `{ drain: () => log('idle') }`.
 *
 * @example
 * ```ts
 * const options: QueueOptions<number, number> = { handler: (input) => input, concurrency: 2 }
 * ```
 */
export interface QueueOptions<TInput, TResult> {
	readonly on?: EmitterHooks<QueueEventMap<TResult>>
	/** Holds the emitter's listener-error handler — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	readonly handler: QueueHandler<TInput, TResult>
	readonly concurrency?: number
	readonly retries?: number
	readonly timeout?: number
	readonly store?: QueueStoreInterface<TInput>
}

/**
 * Represents a concurrent, cooperative job queue.
 *
 * @remarks
 * Exposes a typed {@link emitter} carrying its lifecycle moments
 * ({@link QueueEventMap}) for fire-and-forget observers, ALONGSIDE each `enqueue` promise.
 * Emitting is observation-only — every event fires AFTER the relevant wake / park / settle
 * transition, so a buggy observer can never reorder or corrupt the wake-park / settle-once
 * engine: the emitter isolates a listener throw and routes it to its `error` handler (the
 * `error` option), never the engine. Subscribe through `queue.emitter.on(...)`.
 *
 * @example
 * ```ts
 * const queue: QueueInterface<number, number> = createQueue({ handler: (input) => input })
 * ```
 */
export interface QueueInterface<TInput, TResult> {
	/** Holds the typed push observation surface carrying this queue's {@link QueueEventMap} moments. */
	readonly emitter: EmitterInterface<QueueEventMap<TResult>>
	/** Counts the reserved live entries — admitting, pending, claimed, or awaiting cleanup. */
	readonly count: number
	/** Counts the claimed entries in flight, never above the queue's concurrency. */
	readonly active: number
	/** Reports the pause state: true while `pause` has suspended dequeuing; false otherwise. */
	readonly paused: boolean
	/** Reports the halt state: true after `stop` or `abort` has halted the queue; false otherwise. */
	readonly stopped: boolean
	/** Reserves and submits one FIFO entry. */
	enqueue(input: TInput, options?: QueueEntryOptions): Promise<TResult>
	/** Re-enqueues outstanding entries loaded from the store; no-op without a store. */
	restore(): Promise<void>
	/** Begins or restarts worker execution. */
	start(): void
	/** Rejects non-active work and awaits current-loop/durable quiescence. */
	stop(): Promise<void>
	/** Suspends new execution resumably. */
	pause(): void
	/** Continues execution after a pause. */
	resume(): void
	/** Cancels active work, rejects pending work, and awaits cleanup. */
	abort(reason?: unknown): Promise<void>
	/** Rejects non-active work and awaits its durable cleanup. */
	clear(): Promise<void>
	/** Tears down idempotently and destroys observation last. */
	destroy(): Promise<void>
}

/**
 * Represents a durably persisted, still-outstanding queue entry — re-run after a restart.
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
 * Represents the durable backing for a Queue's outstanding entries.
 *
 * @remarks
 * The store holds ONLY work that has not yet completed: `save` upserts an entry
 * (by its `id`), `remove` drops a finished one, `load` returns everything
 * outstanding (to restore a queue after a restart), and `clear` empties it. It is
 * a minimal interface over the `@orkestrel/database` layer — a queue's durable
 * state is a table — so any `DriverInterface` backend (memory, JSON, SQLite)
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
	load(): Promise<ReadonlyArray<StoredEntry<TInput>>>
	clear(): Promise<void>
}
