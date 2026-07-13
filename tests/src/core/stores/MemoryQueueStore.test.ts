import { describe, expect, it } from 'vitest'
import type { StoredEntry } from '@src/core'
import { MemoryQueueStore } from '@src/core'

// src/core/workers/stores/MemoryQueueStore.ts — the zero-plumbing DEFAULT queue store
// over a plain `Map` (the twin of DatabaseQueueStore, which wraps a databases table for a
// driver-pluggable durable backend). Exercised directly over the real class (no mocks):
// every `StoredEntry` is a real, typed value built inline (the genuine `{ id; input;
// attempts }` shape, §16) — there is no codec to fake. The cases cover the four-method
// surface and its semantics: a `save` → `load` round-trip by value, `save` upserts by id
// (never a duplicate), `remove` drops one (an absent id is a silent no-op), `load` returns
// EVERY outstanding entry (the bulk-restore semantic — the whole table is the work to
// resume), and `clear` empties it. Each primitive resolves a `Promise` (the async wrapper
// over the synchronous Map op), so the memory store is interchangeable with the
// driver-backed one behind `QueueStoreInterface`. Production-grade sections add scale (200
// entries), upsert churn on one id, interleaved-id isolation, and a structured-object
// `input` surviving the round-trip by reference-equal value.

// A real StoredEntry builder with the genuine shape + overrides (a data stub, never a mock,
// §16) — keeps each case's intent (the field under test) in the foreground.
const entryOf = <TInput>(id: string, input: TInput, attempts = 0): StoredEntry<TInput> => ({
	id,
	input,
	attempts,
})

describe('MemoryQueueStore (a plain-Map queue store)', () => {
	it('round-trips a saved entry through load() — by value', async () => {
		const store = new MemoryQueueStore<string>()
		await store.save(entryOf('job-1', 'https://example.com'))

		const outstanding = await store.load()
		expect(outstanding).toHaveLength(1)
		expect(outstanding[0]).toEqual({ id: 'job-1', input: 'https://example.com', attempts: 0 })
	})

	it('load() returns a readonly snapshot array, not the backing store', async () => {
		const store = new MemoryQueueStore<string>()
		await store.save(entryOf('a', 'a'))

		const first = await store.load()
		const second = await store.load()
		// A fresh array each call — mutating one read never leaks into the store or a later read.
		expect(first).not.toBe(second)
		expect(second).toHaveLength(1)
	})

	it('upserts by id — re-saving the same id overwrites, never duplicates', async () => {
		const store = new MemoryQueueStore<string>()
		await store.save(entryOf('job-1', 'first', 0))
		await store.save(entryOf('job-1', 'first', 2))

		const outstanding = await store.load()
		expect(outstanding).toHaveLength(1)
		expect(outstanding[0]).toEqual({ id: 'job-1', input: 'first', attempts: 2 })
	})

	it('removes one outstanding entry by id, leaving the rest', async () => {
		const store = new MemoryQueueStore<string>()
		await store.save(entryOf('a', 'a'))
		await store.save(entryOf('b', 'b'))

		await store.remove('a')

		const outstanding = await store.load()
		expect(outstanding.map((entry) => entry.id)).toEqual(['b'])
	})

	it('remove of an absent id is a no-op (no throw)', async () => {
		const store = new MemoryQueueStore<string>()
		await store.save(entryOf('a', 'a'))

		await expect(store.remove('missing')).resolves.toBeUndefined()
		expect(await store.load()).toHaveLength(1)
	})

	it('load() returns EVERY outstanding entry — the bulk-restore semantic', async () => {
		const store = new MemoryQueueStore<string>()
		await store.save(entryOf('j1', 'a'))
		await store.save(entryOf('j2', 'b'))
		await store.save(entryOf('j3', 'c'))

		const outstanding = await store.load()
		// The whole table is the work to resume — all three come back (insertion order).
		expect(outstanding.map((entry) => entry.id)).toEqual(['j1', 'j2', 'j3'])
		expect(outstanding.map((entry) => entry.input)).toEqual(['a', 'b', 'c'])
	})

	it('clear() empties the store', async () => {
		const store = new MemoryQueueStore<string>()
		await store.save(entryOf('a', 'a'))
		await store.save(entryOf('b', 'b'))

		await store.clear()

		expect(await store.load()).toEqual([])
	})
})

// ── Scale: save / load / remove / clear over many entries ────────────────────
//
// PRODUCTION GAP: the per-feature cases use 2–3 entries. A queue under load holds many
// outstanding rows; save → load → remove → clear must all stay correct at scale, with
// load returning every row.

describe('MemoryQueueStore — at scale', () => {
	it('round-trips 200 entries, removes a half, then clears', async () => {
		const store = new MemoryQueueStore<number>()
		const total = 200
		for (let index = 0; index < total; index += 1) {
			await store.save(entryOf(`job-${String(index).padStart(4, '0')}`, index, index % 4))
		}

		const loaded = await store.load()
		expect(loaded).toHaveLength(total)
		expect(loaded[0]).toEqual({ id: 'job-0000', input: 0, attempts: 0 })
		expect(loaded[total - 1]).toEqual({ id: 'job-0199', input: 199, attempts: 3 })

		// Remove every even-indexed entry; the odd ones remain.
		for (let index = 0; index < total; index += 2) {
			await store.remove(`job-${String(index).padStart(4, '0')}`)
		}
		const remaining = await store.load()
		expect(remaining).toHaveLength(total / 2)
		expect(remaining.every((entry) => entry.input % 2 === 1)).toBe(true)

		await store.clear()
		expect(await store.load()).toEqual([])
	})
})

// ── Upsert churn on a single id + interleaved-id isolation ───────────────────
//
// PRODUCTION GAP: as an entry's attempt count climbs, the queue re-saves the SAME id many
// times. Hammering one id with repeated upserts must never accumulate duplicates — the
// store holds exactly one row, carrying the latest value — and interleaved upserts across
// several ids must not cross-contaminate.

describe('MemoryQueueStore — upsert churn on one id', () => {
	it('keeps exactly one row after 100 re-saves of the same id (the last value wins)', async () => {
		const store = new MemoryQueueStore<string>()
		for (let attempt = 0; attempt < 100; attempt += 1) {
			await store.save(entryOf('climbing', `payload-${attempt}`, attempt))
		}
		const loaded = await store.load()
		expect(loaded).toHaveLength(1)
		expect(loaded[0]).toEqual({ id: 'climbing', input: 'payload-99', attempts: 99 })
	})

	it('interleaves upserts across several ids without cross-contaminating rows', async () => {
		const store = new MemoryQueueStore<number>()
		for (let round = 0; round < 10; round += 1) {
			await store.save(entryOf('a', round, round))
			await store.save(entryOf('b', round * 10, round))
			await store.save(entryOf('c', round * 100, round))
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

// ── Structured-object inputs round-trip by value ─────────────────────────────
//
// PRODUCTION GAP: a real `input` payload is often a structured object, not a scalar. The
// plain-Map store does no encoding, so an entry round-trips as the SAME typed value — its
// nested fields intact (and, unlike a driver round-trip, the very same reference).

describe('MemoryQueueStore — structured-object inputs', () => {
	it('round-trips a nested-object input by value (no encoding, same reference)', async () => {
		interface Job {
			readonly url: string
			readonly headers: { readonly accept: string; readonly retries: number }
		}
		const store = new MemoryQueueStore<Job>()
		const input: Job = { url: 'https://example.com', headers: { accept: 'json', retries: 3 } }
		await store.save(entryOf('job-nested', input, 1))

		const [entry] = await store.load()
		expect(entry?.input).toEqual(input)
		// No codec layer — the stored value is the very object handed in (a plain-Map store).
		expect(entry?.input).toBe(input)
		// Typed access compiles (the class is generic over the input, not `unknown`).
		expect(entry?.input.headers.accept).toBe('json')
	})
})
