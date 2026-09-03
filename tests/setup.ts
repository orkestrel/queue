// ── Environment-agnostic base setup ───────────────────────────────────────────
//
// Loaded first by every test project (`vite.config.ts` `setupFiles[0]`). Holds ONLY
// helpers with no `node:*` / DOM dependency, so it is safe for `src:core` alike.
//
// This package repeats none of the fleet-wide helpers: they live in `@orkestrel/test`
// and every suite imports them from there. What lives here is the queue-shaped test
// infrastructure that package cannot own — the scripted `QueueStoreInterface` boundary
// stub, the `StoredEntry` builder, the driver-backed store builder, and the event-name
// table the emitter suites record against.

import type { ContractShape, Infer } from '@orkestrel/contract'
import type { QueueStoreInterface, StoredEntry } from '@src/core'
import { createMemoryDriver } from '@orkestrel/database'
import { createDatabaseQueueStore } from '@src/core'

/** The scripted primitives a stub store may override; each unsupplied one resolves a no-op. */
export interface StubStoreOptions<TInput> {
	readonly save?: (entry: StoredEntry<TInput>) => Promise<void>
	readonly remove?: (id: string) => Promise<void>
	readonly load?: () => Promise<ReadonlyArray<StoredEntry<TInput>>>
	readonly clear?: () => Promise<void>
}

/** A scripted store paired with the live records of what the queue asked it to persist. */
export interface StubStoreResult<TInput> {
	readonly store: QueueStoreInterface<TInput>
	readonly saves: ReadonlyArray<StoredEntry<TInput>>
	readonly removes: readonly string[]
}

/** The `QueueEventMap` names the emitter suites record. */
export const QUEUE_EVENTS = Object.freeze([
	'enqueue',
	'start',
	'retry',
	'success',
	'failure',
	'abort',
	'drain',
] as const)

/**
 * The recorded-name union, derived from the list rather than from `keyof QueueEventMap`:
 * `createRecorders` takes its names as a type argument (nothing infers them from the
 * emitter), and a union wider than the list would type an unwired key as a recorder while
 * it reads `undefined`.
 */
export type QueueEvent = (typeof QUEUE_EVENTS)[number]

/**
 * Creates a scripted `QueueStoreInterface` boundary stub over the real interface.
 *
 * @remarks
 * Every primitive records before it delegates, so `saves` and `removes` report what the
 * queue asked for even when the supplied primitive rejects. An unsupplied `save`, `remove`,
 * or `clear` resolves a no-op and an unsupplied `load` resolves an empty array, so each
 * case supplies only the primitive its scenario scripts.
 *
 * @typeParam TInput - The work input each {@link StoredEntry} carries
 * @param options - The primitives this case scripts. Default: every primitive is a no-op.
 * @returns The store plus its live `saves` and `removes` records
 *
 * @example
 * ```ts
 * const { store, saves } = createStubStore<string>({
 * 	save: () => Promise.reject(new Error('store offline')),
 * })
 * ```
 */
export function createStubStore<TInput>(
	options?: StubStoreOptions<TInput>,
): StubStoreResult<TInput> {
	const saves: Array<StoredEntry<TInput>> = []
	const removes: string[] = []
	const scripted = options
	const store: QueueStoreInterface<TInput> = {
		save(entry) {
			saves.push(entry)
			return scripted?.save === undefined ? Promise.resolve() : scripted.save(entry)
		},
		remove(id) {
			removes.push(id)
			return scripted?.remove === undefined ? Promise.resolve() : scripted.remove(id)
		},
		load() {
			return scripted?.load === undefined ? Promise.resolve([]) : scripted.load()
		},
		clear() {
			return scripted?.clear === undefined ? Promise.resolve() : scripted.clear()
		},
	}
	return { store, saves, removes }
}

/**
 * Creates one real {@link StoredEntry} with the genuine `{ id; input; attempts }` shape.
 *
 * @typeParam TInput - The work input the entry carries
 * @param id - The entry's stable id
 * @param input - The handler's work payload
 * @param attempts - How many times the entry has been tried. Default: `0`.
 * @returns The entry, as an inert data value
 *
 * @example
 * ```ts
 * const entry = createStoredEntry('job-1', 'task')
 * ```
 */
export function createStoredEntry<TInput>(
	id: string,
	input: TInput,
	attempts = 0,
): StoredEntry<TInput> {
	return { id, input, attempts }
}

/**
 * Creates a driver-backed queue store over a fresh in-memory driver.
 *
 * @remarks
 * This is the exact construction `createMemoryQueueStore` made before it became the
 * plain-`Map` store factory, so the driver-backed engine and its key-ordered `load` stay
 * exercised. The result is typed by `Infer<TInput>` through the factory overload, so a
 * typed property access on a loaded entry compiles with no assertion.
 *
 * @typeParam TInput - The contract shape of each entry's `input` payload
 * @param input - The runtime contract for the work payload
 * @returns A driver-backed {@link QueueStoreInterface}, typed by `input`
 *
 * @example
 * ```ts
 * const store = createDriverQueueStore(stringShape())
 * ```
 */
export function createDriverQueueStore<TInput extends ContractShape>(
	input: TInput,
): QueueStoreInterface<Infer<TInput>> {
	return createDatabaseQueueStore(input, createMemoryDriver())
}
