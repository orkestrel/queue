import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '@orkestrel/emitter'

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
 */
export type QueueEventMap<TResult> = {
	/** An entry was accepted (and durably persisted, when a store is set) — its id. */
	readonly enqueue: readonly [id: string]
	/** An attempt began running — the entry's id (after it was dequeued, in flight). */
	readonly start: readonly [id: string]
	/** A failed attempt is being retried — the entry's id + the next (1-based) attempt index. */
	readonly retry: readonly [id: string, attempt: number]
	/** An entry settled successfully — its id + the resolved result. */
	readonly success: readonly [id: string, result: TResult]
	/** An entry settled with a terminal failure — its id + the error (always `unknown`). */
	readonly failure: readonly [id: string, error: unknown]
	/** The queue was aborted — the cancel reason. */
	readonly abort: readonly [reason: unknown]
	/** The queue went idle — no pending entries and none in flight (drained). */
	readonly drain: readonly []
}

/**
 * One queued unit of work, plus the resolvers of the promise `enqueue` returned.
 *
 * @remarks
 * `id` keys the entry in the durable store; `attempts` is the STARTING attempt index — `0`
 * for a fresh entry, the persisted count for one resumed by `restore`. Held only inside the
 * {@link QueueInterface} engine (the in-flight pending list); not part of the public call
 * surface, but centralized here per AGENTS §5 (an impl file holds only its class).
 *
 * @typeParam TInput - The work payload the entry carries
 * @typeParam TResult - The value the entry resolves
 */
export interface QueueEntry<TInput, TResult> {
	readonly id: string
	readonly input: TInput
	readonly options: QueueEntryOptions | undefined
	readonly attempts: number
	readonly resolve: (value: TResult) => void
	readonly reject: (error: unknown) => void
}

/** The per-attempt execution handle a queue handler receives. */
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

/** Runs one queued entry's work; may reject to trigger a retry. */
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
 * - `timeout` — the per-attempt deadline in milliseconds; overrides the queue
 *   default. A non-positive value (or no default) means no deadline.
 * - `signal` — an entry-scoped abort; once it fires the entry rejects (its
 *   in-flight attempt's `signal` fires too) and does not retry.
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
 *   `1` (ordered, one-at-a-time). Floored at `1`.
 * - `retries` — the default extra attempts per entry on failure; defaults to `0`.
 * - `timeout` — the default per-attempt deadline in milliseconds; defaults to none
 *   (a non-positive value means no deadline).
 * - `store` — durable backing; outstanding entries survive a restart; call
 *   `restore()` to re-run them.
 * - `on` — the reserved {@link EmitterHooks} key (§8): initial listeners for the queue's
 *   {@link QueueEventMap}, wired at construction (e.g. `{ drain: () => log('idle') }`).
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
 */
export interface QueueInterface<TInput, TResult> {
	readonly emitter: EmitterInterface<QueueEventMap<TResult>>
	readonly count: number
	readonly active: number
	readonly paused: boolean
	readonly stopped: boolean
	enqueue(input: TInput, options?: QueueEntryOptions): Promise<TResult>
	/** Re-enqueue outstanding entries loaded from the store; no-op without a store. */
	restore(): Promise<void>
	start(): void
	stop(): void
	pause(): void
	resume(): void
	abort(reason?: unknown): void
	clear(): void
	destroy(): void
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
 */
export interface QueueStoreInterface<TInput> {
	save(entry: StoredEntry<TInput>): Promise<void>
	remove(id: string): Promise<void>
	load(): Promise<readonly StoredEntry<TInput>[]>
	clear(): Promise<void>
}
