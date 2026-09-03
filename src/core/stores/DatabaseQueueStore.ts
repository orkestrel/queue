import type { TableInterface } from '@orkestrel/database'
import type { QueueStoreInterface, StoredEntry } from '../types.js'

/**
 * Represents a {@link QueueStoreInterface} backed by one table of the `@orkestrel/database` layer — a
 * queue's durable state IS a table, so persistence reduces to keyed CRUD over a
 * `TableInterface`.
 *
 * @remarks
 * The store is driver-agnostic: it holds a single {@link TableInterface} whose
 * backend (memory, JSON, SQLite) is chosen by whoever builds it (the factories).
 * `save` upserts an entry by its primary key (`set`), `remove` drops one (`remove`),
 * `load` returns every outstanding entry (`records` with no criteria), and `clear`
 * empties the table. Reads are narrowed through the table's contract, so `load`
 * returns typed {@link StoredEntry}`<TInput>[]` with no cast — the table
 * is created over the `{ id; input; attempts }` column map, which `Infer`s to exactly
 * that row. The store holds only OUTSTANDING work (completed entries are `remove`d), so
 * `load` on startup yields precisely the entries to resume.
 *
 * @typeParam TInput - The work input each {@link StoredEntry} carries
 *
 * @example
 * ```ts
 * import { stringShape } from '@orkestrel/contract'
 * import { createMemoryDriver } from '@orkestrel/database'
 * import { createDatabaseQueueStore } from '@orkestrel/queue'
 *
 * const store = createDatabaseQueueStore(stringShape(), createMemoryDriver())
 * await store.save({ id: 'job-1', input: 'https://example.com', attempts: 0 })
 * const outstanding = await store.load() // readonly StoredEntry<string>[]
 * ```
 */
export class DatabaseQueueStore<TInput> implements QueueStoreInterface<TInput> {
	readonly #table: TableInterface<StoredEntry<TInput>>

	/**
	 * Wraps a table as a queue store.
	 *
	 * @param table - The {@link TableInterface} holding the outstanding entries — its
	 *   row is a {@link StoredEntry}`<TInput>` (the `{ id; input; attempts }` shape)
	 */
	constructor(table: TableInterface<StoredEntry<TInput>>) {
		this.#table = table
	}

	/** Upserts an entry by its `id` (a re-`save` of an existing `id` overwrites it). */
	async save(entry: StoredEntry<TInput>): Promise<void> {
		await this.#table.set(entry)
	}

	/** Drops a finished entry by `id`; absent is a no-op (no throw). */
	async remove(id: string): Promise<void> {
		await this.#table.remove(id)
	}

	/** Returns every outstanding entry — the work to resume after a restart. */
	load(): Promise<ReadonlyArray<StoredEntry<TInput>>> {
		return this.#table.records()
	}

	/** Empties the store — drops every outstanding entry. */
	async clear(): Promise<void> {
		await this.#table.clear()
	}
}
