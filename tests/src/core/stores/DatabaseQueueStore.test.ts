import type { ContractShape, Infer } from '@orkestrel/contract'
import type { QueueStoreInterface } from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	arrayShape,
	booleanShape,
	integerShape,
	nullableShape,
	numberShape,
	objectShape,
	optionalShape,
	stringShape,
} from '@orkestrel/contract'
import { createMemoryDriver } from '@orkestrel/database'
import { createDatabaseQueueStore } from '@src/core'
import { requireElement } from '../../../setup.js'

// A real DatabaseQueueStore over a fresh memory driver (no mocks) — the exact construction
// `createMemoryQueueStore` USED to make before it became the plain-`Map` MemoryQueueStore
// factory, so this mirror keeps exercising the driver-backed store (and its key-ordered
// `load`). Typed by `Infer<TInput>` via the factory overload, so the typed-access assertions
// below need no `as`.
const memoryStore = <TInput extends ContractShape>(
	input: TInput,
): QueueStoreInterface<Infer<TInput>> => createDatabaseQueueStore(input, createMemoryDriver())

// src/core/workers/stores/DatabaseQueueStore.ts — the durable, driver-backed queue store over
// the databases layer. Exercised over a real memory-backed store (no mocks): a stored
// entry round-trips by value AND by type, `save` upserts by id, `remove` drops one,
// `load` returns every outstanding entry in key order, and `clear` empties it. The
// typed `load()` boundary is proven by a compiling property access on the result
// (AGENTS §1 — no `as` needed; the contract narrows the read). Beyond the per-feature
// cases, production-grade sections cover: scale (200 entries — save/load/remove/clear,
// stable key order), upsert churn on one id (100 re-saves → exactly one row) and across
// interleaved ids (no cross-contamination), and complex / edge-value inputs (deeply
// nested arrays / booleans / nullables / optionals / nested objects, an absent optional,
// an empty array) — each surviving the round-trip AND coming back fully typed with no `as`.

describe('DatabaseQueueStore (over a memory driver)', () => {
	it('round-trips a saved entry through load() — value and type', async () => {
		const store = memoryStore(stringShape())
		await store.save({ id: 'job-1', input: 'https://example.com', attempts: 0 })

		const outstanding = await store.load()
		expect(outstanding).toHaveLength(1)
		const [entry] = outstanding
		expect(entry).toEqual({ id: 'job-1', input: 'https://example.com', attempts: 0 })
		// The loaded `input` is typed as `string` (no `as`): a string method compiles.
		expect(entry?.input.toUpperCase()).toBe('HTTPS://EXAMPLE.COM')
	})

	it('round-trips a NESTED-OBJECT input — proving the typed payload survives', async () => {
		const store = memoryStore(
			objectShape({
				url: stringShape(),
				headers: objectShape({ accept: stringShape(), retries: integerShape({ min: 0 }) }),
			}),
		)
		await store.save({
			id: 'job-nested',
			input: { url: 'https://example.com', headers: { accept: 'json', retries: 3 } },
			attempts: 1,
		})

		const [entry] = await store.load()
		expect(entry?.input).toEqual({
			url: 'https://example.com',
			headers: { accept: 'json', retries: 3 },
		})
		// Nested property access compiles — the inferred input type is structural, not `unknown`.
		expect(entry?.input.headers.accept).toBe('json')
		expect(entry?.input.headers.retries).toBe(3)
	})

	it('upserts by id — re-saving the same id overwrites, never duplicates', async () => {
		const store = memoryStore(stringShape())
		await store.save({ id: 'job-1', input: 'first', attempts: 0 })
		await store.save({ id: 'job-1', input: 'first', attempts: 2 })

		const outstanding = await store.load()
		expect(outstanding).toHaveLength(1)
		expect(outstanding[0]).toEqual({ id: 'job-1', input: 'first', attempts: 2 })
	})

	it('removes one outstanding entry by id, leaving the rest', async () => {
		const store = memoryStore(stringShape())
		await store.save({ id: 'a', input: 'a', attempts: 0 })
		await store.save({ id: 'b', input: 'b', attempts: 0 })

		await store.remove('a')

		const outstanding = await store.load()
		expect(outstanding.map((entry) => entry.id)).toEqual(['b'])
	})

	it('remove of an absent id is a no-op (no throw)', async () => {
		const store = memoryStore(stringShape())
		await store.save({ id: 'a', input: 'a', attempts: 0 })

		await expect(store.remove('missing')).resolves.toBeUndefined()
		expect(await store.load()).toHaveLength(1)
	})

	it('load() returns every outstanding entry in a stable (key) order', async () => {
		const store = memoryStore(stringShape())
		// Saved out of key order; the store reads back in key order (the driver contract).
		await store.save({ id: 'j3', input: 'c', attempts: 0 })
		await store.save({ id: 'j1', input: 'a', attempts: 0 })
		await store.save({ id: 'j2', input: 'b', attempts: 0 })

		const outstanding = await store.load()
		expect(outstanding.map((entry) => entry.id)).toEqual(['j1', 'j2', 'j3'])
	})

	it('clear() empties the store', async () => {
		const store = memoryStore(stringShape())
		await store.save({ id: 'a', input: 'a', attempts: 0 })
		await store.save({ id: 'b', input: 'b', attempts: 0 })

		await store.clear()

		expect(await store.load()).toEqual([])
	})
})

// ── Scale: save / load / remove / clear over many entries ────────────────────
//
// PRODUCTION GAP: the per-feature cases use 2–3 entries. A durable queue under load
// holds many outstanding rows; save → load → remove → clear must all stay correct at
// scale, with load returning every row in the driver's stable key order.

describe('DatabaseQueueStore — at scale', () => {
	it('round-trips 200 entries, loads them in stable key order, removes + clears at scale', async () => {
		const store = memoryStore(integerShape({ min: 0 }))
		const total = 200
		// Save 200 entries with shuffled-looking ids (zero-padded so string order is stable).
		for (let index = 0; index < total; index += 1) {
			const id = `job-${String(index).padStart(4, '0')}`
			await store.save({ id, input: index, attempts: index % 4 })
		}

		const loaded = await store.load()
		expect(loaded).toHaveLength(total)
		// load() yields in the driver's stable key order (ascending id) — deterministic.
		const ids = loaded.map((entry) => entry.id)
		expect(ids).toEqual([...ids].sort())
		// First and last entries carry their exact typed payload (no `as` — input is number).
		expect(loaded[0]).toEqual({ id: 'job-0000', input: 0, attempts: 0 })
		expect(requireElement(loaded, total - 1).input + 1).toBe(total)

		// Remove every even-indexed entry; the odd ones remain, still in order.
		for (let index = 0; index < total; index += 2) {
			await store.remove(`job-${String(index).padStart(4, '0')}`)
		}
		const remaining = await store.load()
		expect(remaining).toHaveLength(total / 2)
		expect(remaining.every((entry) => entry.input % 2 === 1)).toBe(true)

		// clear() empties the whole table in one shot.
		await store.clear()
		expect(await store.load()).toEqual([])
	})
})

// ── Upsert churn on a single id ──────────────────────────────────────────────
//
// PRODUCTION GAP: as an entry's attempt count climbs, the queue re-saves the SAME id
// many times. Hammering one id with repeated upserts must never accumulate duplicates —
// the store holds exactly one row, carrying the latest value.

describe('DatabaseQueueStore — upsert churn on one id', () => {
	it('keeps exactly one row after 100 re-saves of the same id (the last value wins)', async () => {
		const store = memoryStore(stringShape())
		for (let attempt = 0; attempt < 100; attempt += 1) {
			await store.save({ id: 'climbing', input: `payload-${attempt}`, attempts: attempt })
		}
		const loaded = await store.load()
		// One id → one row, never 100 duplicates.
		expect(loaded).toHaveLength(1)
		expect(loaded[0]).toEqual({ id: 'climbing', input: 'payload-99', attempts: 99 })
	})

	it('interleaves upserts across several ids without cross-contaminating rows', async () => {
		const store = memoryStore(integerShape({ min: 0 }))
		// Three ids, each re-saved several times with climbing attempts, interleaved.
		for (let round = 0; round < 10; round += 1) {
			await store.save({ id: 'a', input: round, attempts: round })
			await store.save({ id: 'b', input: round * 10, attempts: round })
			await store.save({ id: 'c', input: round * 100, attempts: round })
		}
		const loaded = await store.load()
		expect(loaded).toHaveLength(3)
		expect(loaded).toEqual([
			{ id: 'a', input: 9, attempts: 9 },
			{ id: 'b', input: 90, attempts: 9 },
			{ id: 'c', input: 900, attempts: 9 },
		])
	})
})

// ── Complex / edge-value inputs round-trip through the typed boundary ────────
//
// PRODUCTION GAP: only a shallow nested object is covered. A real `input` payload may be
// an array of objects, carry booleans / nullables / optionals / a record map, and nest
// deeply. Each must survive the JSON-ish round-trip AND come back fully TYPED (every
// property access below compiles with NO `as` — the contract narrows the read, AGENTS §1).

describe('DatabaseQueueStore — complex / edge-value inputs', () => {
	it('round-trips a deeply nested payload of arrays, booleans, nullables and nested objects', async () => {
		const store = memoryStore(
			objectShape({
				url: stringShape(),
				active: booleanShape(),
				weight: numberShape(),
				note: nullableShape(stringShape()),
				tags: arrayShape(stringShape()),
				steps: arrayShape(objectShape({ name: stringShape(), retries: integerShape({ min: 0 }) })),
				meta: objectShape({ a: numberShape(), b: numberShape(), c: numberShape() }),
				deep: objectShape({
					level: integerShape({ min: 0 }),
					inner: objectShape({ flag: booleanShape() }),
				}),
			}),
		)
		const payload = {
			url: 'https://example.com/path?q=1',
			active: true,
			weight: 3.5,
			note: null,
			tags: ['alpha', 'beta', 'gamma'],
			steps: [
				{ name: 'fetch', retries: 2 },
				{ name: 'parse', retries: 0 },
			],
			meta: { a: 1, b: 2, c: 3 },
			deep: { level: 4, inner: { flag: false } },
		}
		await store.save({ id: 'complex', input: payload, attempts: 0 })

		const [entry] = await store.load()
		// Whole-value equality — nothing dropped or reordered across the round-trip.
		expect(entry?.input).toEqual(payload)
		// Typed access compiles end-to-end with no assertion — the inferred input is structural.
		expect(entry?.input.active).toBe(true)
		expect(entry?.input.note).toBeNull()
		expect(entry?.input.tags.map((tag) => tag.toUpperCase())).toEqual(['ALPHA', 'BETA', 'GAMMA'])
		expect(entry?.input.steps[0]?.retries).toBe(2)
		expect(entry?.input.meta.b).toBe(2)
		expect(entry?.input.deep.inner.flag).toBe(false)
	})

	it('round-trips an optional field present in one entry and absent in another', async () => {
		const store = memoryStore(
			objectShape({ url: stringShape(), label: optionalShape(stringShape()) }),
		)
		await store.save({ id: 'with', input: { url: 'a', label: 'home' }, attempts: 0 })
		await store.save({ id: 'without', input: { url: 'b' }, attempts: 0 })

		const loaded = await store.load()
		const withLabel = loaded.find((entry) => entry.id === 'with')
		const withoutLabel = loaded.find((entry) => entry.id === 'without')
		expect(withLabel?.input.label).toBe('home')
		// The absent optional comes back undefined (not stored as null) — typed access compiles.
		expect(withoutLabel?.input.label).toBeUndefined()
		expect(withoutLabel?.input.url).toBe('b')
	})

	it('round-trips an array-of-objects input and an empty array', async () => {
		const store = memoryStore(
			objectShape({ items: arrayShape(objectShape({ sku: stringShape(), qty: integerShape() })) }),
		)
		await store.save({
			id: 'order',
			input: {
				items: [
					{ sku: 'x', qty: 2 },
					{ sku: 'y', qty: 5 },
				],
			},
			attempts: 0,
		})
		await store.save({ id: 'empty', input: { items: [] }, attempts: 0 })

		const loaded = await store.load()
		const order = loaded.find((entry) => entry.id === 'order')
		const empty = loaded.find((entry) => entry.id === 'empty')
		expect(order?.input.items).toEqual([
			{ sku: 'x', qty: 2 },
			{ sku: 'y', qty: 5 },
		])
		expect(order?.input.items.reduce((sum, item) => sum + item.qty, 0)).toBe(7)
		// An empty array survives as an empty array (not dropped / coerced to undefined).
		expect(empty?.input.items).toEqual([])
	})
})
