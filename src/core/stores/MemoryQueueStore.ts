import type { QueueStoreInterface, StoredEntry } from '../types.js'

/**
 * The in-memory {@link QueueStoreInterface} — a process-lifetime `Map` of
 * {@link StoredEntry}s keyed by id, the DEFAULT store
 * {@link import('../factories.js').createMemoryQueueStore} builds.
 *
 * @remarks
 * A plain `Map<string, StoredEntry<TInput>>` (AGENTS §21 — the entry is already pure,
 * self-contained JSON, so no `databases` table / driver codec is needed for the memory
 * tier; this is the zero-plumbing twin of {@link DatabaseQueueStore}, which wraps a
 * `TableInterface` for a driver-pluggable durable backend). The store holds ONLY
 * outstanding work, so `load` yields precisely the entries to resume — though a memory
 * store is gone when the process exits, so `restore()` recovers nothing after a real
 * restart. For durability across restarts, build a {@link DatabaseQueueStore} over a
 * server JSON / SQLite driver (the SAME interface, so the queue / worker never knows).
 *
 * - **`save` upserts an entry under its OWN `id`** (a re-`save` of an existing `id`
 *   overwrites it — `Map.set`, never a duplicate).
 * - **`remove` drops a finished entry by `id`**; an absent `id` is a no-op (no throw).
 * - **`load` returns every outstanding entry** as a readonly array (the `Map`'s values
 *   in insertion order — the work to resume).
 * - **`clear` empties the store** — drop every outstanding entry.
 *
 * Each primitive is async (it returns a resolved `Promise`) to satisfy the
 * {@link QueueStoreInterface} signatures, wrapping the synchronous `Map` op — so the
 * memory and driver-backed stores are interchangeable behind the one interface. The
 * public surface is EXACTLY `save` / `remove` / `load` / `clear` — no extra members (the
 * §22 method bijection with {@link QueueStoreInterface}).
 *
 * @typeParam TInput - The work input each {@link StoredEntry} carries
 *
 * @example
 * ```ts
 * import { createMemoryQueueStore, stringShape } from '@src/core'
 *
 * const store = createMemoryQueueStore(stringShape())
 * await store.save({ id: 'job-1', input: 'https://example.com', attempts: 0 })
 * const outstanding = await store.load() // readonly StoredEntry<string>[]
 * await store.remove('job-1') // a finished entry leaves the store
 * ```
 */
export class MemoryQueueStore<TInput> implements QueueStoreInterface<TInput> {
	readonly #entries = new Map<string, StoredEntry<TInput>>()

	/** Upsert an entry under its OWN `id` (a re-`save` of an existing `id` overwrites it). */
	save(entry: StoredEntry<TInput>): Promise<void> {
		this.#entries.set(entry.id, entry)
		return Promise.resolve()
	}

	/** Drop a finished entry by `id`; `Map.delete` of an absent id is already a no-op (no throw). */
	remove(id: string): Promise<void> {
		this.#entries.delete(id)
		return Promise.resolve()
	}

	/** Every outstanding entry — the work to resume (the `Map`'s values, insertion order). */
	load(): Promise<readonly StoredEntry<TInput>[]> {
		return Promise.resolve([...this.#entries.values()])
	}

	/** Empty the store — drop every outstanding entry. */
	clear(): Promise<void> {
		this.#entries.clear()
		return Promise.resolve()
	}
}
