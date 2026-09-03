import type { ContractShape, Infer } from '@orkestrel/contract'
import type { DriverInterface, TableInterface } from '@orkestrel/database'
import type { QueueInterface, QueueOptions, QueueStoreInterface, StoredEntry } from './types.js'
import { integerShape, stringShape } from '@orkestrel/contract'
import { createDatabase } from '@orkestrel/database'
import { Queue } from './Queue.js'
import { DatabaseQueueStore } from './stores/DatabaseQueueStore.js'
import { MemoryQueueStore } from './stores/MemoryQueueStore.js'

/**
 * Creates a concurrent, cooperative job queue — a bounded-concurrency engine that
 * runs each enqueued input through a handler, with retries and a per-attempt
 * timeout / abort, all over the L1 `Abort` / `Timeout` primitives.
 *
 * @remarks
 * Worker loops PARK on a wake list when no entry is ready and are woken one-at-a-time
 * by `enqueue` / `resume`, so an idle queue consumes no CPU (no polling). `enqueue`
 * returns a promise that settles when the entry finally completes, fails (after its
 * retries), or is rejected by an abort. A queue-level `abort` never retries; the
 * lifecycle (`start` / `stop` / `pause` / `resume` / `abort` / `clear` / `destroy`)
 * follows the fixed lifecycle vocabulary. The queue is observable: a typed `emitter` surfaces
 * `enqueue` / `start` / `retry` / `success` / `failure` / `abort` / `drain`.
 *
 * @typeParam TInput - The work input each entry carries
 * @typeParam TResult - The value the handler resolves for an entry
 * @param options - The `handler` plus optional `concurrency`, `retries`, and a default
 *   per-attempt `timeout` in milliseconds. Default: `concurrency` `1`, `retries` `0`,
 *   `timeout` `0`.
 * @returns A working {@link QueueInterface}
 *
 * @example
 * ```ts
 * import { createQueue } from '@orkestrel/queue'
 *
 * const queue = createQueue<string, number>({
 * 	handler: async (url, { signal }) => (await fetch(url, { signal })).status,
 * 	concurrency: 4,
 * 	retries: 2,
 * 	timeout: 5_000,
 * })
 *
 * const status = await queue.enqueue('https://example.com')
 * ```
 */
export function createQueue<TInput, TResult>(
	options: QueueOptions<TInput, TResult>,
): QueueInterface<TInput, TResult> {
	return new Queue(options)
}

/**
 * Creates a {@link DatabaseQueueStore} over any {@link DriverInterface} — the durable,
 * driver-pluggable backing for a queue's outstanding entries.
 *
 * @remarks
 * Builds a one-table database (`entries`, keyed by `id`) over the supplied driver, with
 * the fixed `{ id; input; attempts }` column map — `input` is the caller's own shape,
 * so the stored entry's payload is validated and typed by it. Reads narrow through that
 * contract, so the store's `load` returns typed `StoredEntry<Infer<TInput>>[]` with no
 * cast. Pass `createMemoryDriver()` for an ephemeral store, a server `createJSONDriver` /
 * `createSQLiteDriver` for a persistent one — the durability is the driver's job, the
 * store engine is shared. The `input` shape must be JSON-serializable to survive a JSON
 * or SQLite driver.
 *
 * @typeParam TInput - The contract shape of each entry's `input` payload
 * @param input - The {@link ContractShape} for the work payload (used directly as the
 *   `input` column)
 * @param driver - The storage backend the entries persist to
 * @returns A {@link QueueStoreInterface} over the driver, typed by `input`
 *
 * @example
 * ```ts
 * import { objectShape, stringShape } from '@orkestrel/contract'
 * import { createMemoryDriver } from '@orkestrel/database'
 * import { createDatabaseQueueStore } from '@orkestrel/queue'
 *
 * const store = createDatabaseQueueStore(
 * 	objectShape({ url: stringShape(), label: stringShape() }),
 * 	createMemoryDriver(),
 * )
 * await store.save({ id: 'job-1', input: { url: 'https://example.com', label: 'home' }, attempts: 0 })
 * ```
 */
export function createDatabaseQueueStore<TInput extends ContractShape>(
	input: TInput,
	driver: DriverInterface,
): QueueStoreInterface<Infer<TInput>>
// The preceding public signature types the store by `Infer<TInput>`. The implementation
// runs on the BROAD `ContractShape`, so the `entries` row is built and the table read
// once — not re-instantiated per concrete `TInput`. (A generic `TInput` member can't be
// reduced by the contract's object inference, which would also trip TS's
// instantiation-depth guard; the broad body sidesteps both, and every call site still
// sees the precise `Infer<TInput>` from the overload.) No cast: the contract-narrowed
// row satisfies `StoredEntry<unknown>` structurally.
export function createDatabaseQueueStore(
	input: ContractShape,
	driver: DriverInterface,
): QueueStoreInterface<unknown> {
	const columns = {
		id: stringShape(),
		input,
		attempts: integerShape({ min: 0, max: Number.MAX_SAFE_INTEGER }),
	}
	const database = createDatabase({ driver, tables: { entries: columns } })
	const table: TableInterface<StoredEntry<unknown>> = database.table('entries')
	return new DatabaseQueueStore(table)
}

/**
 * Creates an in-memory {@link MemoryQueueStore} — the zero-plumbing DEFAULT queue store
 * over a plain `Map` (the twin of {@link DatabaseQueueStore}).
 *
 * @remarks
 * The entries live in a process-lifetime `Map` and are gone when the process exits. The
 * supplied shape is compiled and enforced for every save. Exact JSON inputs are cloned
 * into deeply frozen owned snapshots, and each load returns fresh snapshots, so neither
 * caller mutation nor a returned object can alias stored state. For durability across
 * restarts, build the store over a persistent driver with
 * {@link createDatabaseQueueStore}.
 *
 * @typeParam TInput - The contract shape of each entry's `input` payload
 * @param input - The runtime {@link ContractShape} for the work payload
 * @returns A validated memory-backed {@link QueueStoreInterface}, typed by `input`
 *
 * @example
 * ```ts
 * import { stringShape } from '@orkestrel/contract'
 * import { createMemoryQueueStore } from '@orkestrel/queue'
 *
 * const store = createMemoryQueueStore(stringShape())
 * await store.save({ id: 'job-1', input: 'task', attempts: 0 })
 * ```
 */
export function createMemoryQueueStore<TInput extends ContractShape>(
	input: TInput,
): QueueStoreInterface<Infer<TInput>> {
	return new MemoryQueueStore(input)
}
