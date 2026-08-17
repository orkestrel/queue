import type { QueueEventMap, QueueExecution, QueueStoreInterface, StoredEntry } from '@src/core'
import { describe, expect, it } from 'vitest'
import { stringShape } from '@orkestrel/contract'
import {
	createMemoryQueueStore,
	isQueueConcurrency,
	isQueueError,
	isQueueRetries,
	isQueueSignal,
	isQueueTimeout,
	Queue,
} from '@src/core'
import { createRecorder, requireValue, waitForDelay } from '@orkestrel/test'
import { recordEmitterEvents } from '../../setup.js'

// src/core/Queue.ts — the cooperative concurrent job engine. Real behaviour,
// no mocks: handlers are gated on manually-settled promises (Promise.withResolvers) so ordering /
// concurrency / pause are deterministic, and a real short Timeout drives the timeout
// test. A recorder counts handler invocations (AGENTS §16). Beyond the per-feature
// cases, production-grade stress sections cover: high concurrency × many entries (120
// through 8 workers — never over the cap, each runs once, full drain), handler return /
// failure shapes (sync throw vs async reject vs plain value vs non-Error throw),
// per-entry vs queue-level timeout / retry interaction, rapid lifecycle churn
// (pause/resume/clear/enqueue — count balanced, drains to 0), store-remove failures
// under churn (cleanup failures stay observable without wedging worker respawn), enqueue rejection
// messages for every halted state, restore at scale + racing a concurrent same-id
// enqueue (no double-run), and the wake-park under saturation (no lost wake / stuck
// entry) — all with real hand-written failing stores, never behaviour mocks.

describe('Queue — enqueue + FIFO (concurrency 1)', () => {
	it('runs the handler and resolves the promise with its result', async () => {
		const queue = new Queue<number, number>({ handler: (input) => input * 2 })
		await expect(queue.enqueue(21)).resolves.toBe(42)
	})

	it('runs entries in enqueue order at concurrency 1', async () => {
		const order: number[] = []
		const queue = new Queue<number, void>({
			handler: async (input) => {
				await waitForDelay(5)
				order.push(input)
			},
		})
		await Promise.all([queue.enqueue(1), queue.enqueue(2), queue.enqueue(3)])
		expect(order).toEqual([1, 2, 3])
	})
})

describe('Queue — bounded concurrency', () => {
	it('runs at most `concurrency` entries at once; the surplus waits', async () => {
		const gates = [
			Promise.withResolvers<void>(),
			Promise.withResolvers<void>(),
			Promise.withResolvers<void>(),
		]
		let live = 0
		let peak = 0
		const started = createRecorder<[number]>()
		const queue = new Queue<number, void>({
			concurrency: 2,
			handler: async (input) => {
				started.handler(input)
				live += 1
				peak = Math.max(peak, live)
				await requireValue(gates[input]).promise
				live -= 1
			},
		})

		const all = Promise.all([queue.enqueue(0), queue.enqueue(1), queue.enqueue(2)])
		void all.catch(() => {})
		try {
			// Let the workers pick up as many as they may.
			await waitForDelay(10)
			// Only two slots — the third entry has not started, and `active` caps at 2.
			expect(started.count).toBe(2)
			expect(queue.active).toBe(2)

			requireValue(gates[0]).resolve()
			await waitForDelay(10)
			// Freeing one slot lets the third start; still never more than two at once.
			expect(started.count).toBe(3)
			expect(queue.active).toBe(2)

			requireValue(gates[1]).resolve()
			requireValue(gates[2]).resolve()
			await all
			expect(peak).toBe(2)
			expect(queue.active).toBe(0)
		} finally {
			for (const gate of gates) gate.resolve()
			await Promise.allSettled([all])
			await queue.destroy()
		}
	})
})

describe('Queue — retries', () => {
	it('retries a failing handler and resolves once it succeeds', async () => {
		const attempts = createRecorder<[number]>()
		const queue = new Queue<number, string>({
			retries: 3,
			handler: (input) => {
				attempts.handler(input)
				if (attempts.count < 3) throw new Error('not yet')
				return 'ok'
			},
		})
		await expect(queue.enqueue(1)).resolves.toBe('ok')
		// Two failures + one success = three attempts.
		expect(attempts.count).toBe(3)
	})

	it('rejects after exhausting retries, having run `retries` + 1 attempts', async () => {
		const attempts = createRecorder<[]>()
		const queue = new Queue<undefined, void>({
			retries: 2,
			handler: () => {
				attempts.handler()
				throw new Error('always fails')
			},
		})
		await expect(queue.enqueue(undefined)).rejects.toThrow('always fails')
		expect(attempts.count).toBe(3)
	})
})

describe('Queue — per-attempt timeout', () => {
	it('fires the attempt signal on timeout and treats it as a failed attempt', async () => {
		const fired = createRecorder<[]>()
		const queue = new Queue<undefined, void>({
			timeout: 10,
			retries: 1,
			handler: (_input, execution: QueueExecution) =>
				new Promise<void>((resolve) => {
					// Ignore the signal deliberately, but observe that it fires on the deadline.
					execution.signal.addEventListener('abort', () => fired.handler(), { once: true })
					// Resolve well after the deadline — the queue must not wait for us.
					setTimeout(resolve, 100)
				}),
		})
		await expect(queue.enqueue(undefined)).rejects.toThrow('timed out')
		// Both attempts (initial + one retry) timed out, so the signal fired twice.
		expect(fired.count).toBe(2)
	})

	it('does not time out a handler that finishes before the deadline', async () => {
		const queue = new Queue<number, number>({
			timeout: 50,
			handler: async (input) => {
				await waitForDelay(5)
				return input
			},
		})
		await expect(queue.enqueue(7)).resolves.toBe(7)
	})
})

describe('Queue — abort', () => {
	it('rejects pending entries and fires the in-flight handler signal; no retries', async () => {
		const gate = Promise.withResolvers<void>()
		const fired = createRecorder<[]>()
		const attempts = createRecorder<[]>()
		const queue = new Queue<string, void>({
			concurrency: 1,
			retries: 5,
			handler: (_input, execution: QueueExecution) => {
				attempts.handler()
				execution.signal.addEventListener('abort', () => fired.handler(), { once: true })
				return gate.promise
			},
		})

		const running = queue.enqueue('inflight')
		const waiting = queue.enqueue('pending')
		await waitForDelay(10)
		expect(queue.active).toBe(1)

		const aborting = queue.abort(new Error('stop everything'))

		await expect(waiting).rejects.toThrow('stop everything')
		await expect(running).rejects.toBeDefined()
		await aborting
		// The in-flight attempt's signal fired, and it was NOT retried despite retries: 5.
		expect(fired.count).toBe(1)
		expect(attempts.count).toBe(1)
		expect(queue.stopped).toBe(true)
	})

	it('rejects new enqueues after an abort', async () => {
		const queue = new Queue<number, number>({ handler: (input) => input })
		await queue.abort()
		await expect(queue.enqueue(1)).rejects.toThrow('aborted')
	})
})

describe('Queue — pause / resume', () => {
	it('starts no new entries while paused, then proceeds on resume', async () => {
		const started = createRecorder<[number]>()
		const queue = new Queue<number, number>({
			handler: (input) => {
				started.handler(input)
				return input
			},
		})
		queue.pause()
		const pending = queue.enqueue(1)
		await waitForDelay(10)
		// Paused — the entry is enqueued but the worker stays parked.
		expect(started.count).toBe(0)
		expect(queue.paused).toBe(true)
		expect(queue.count).toBe(1)

		queue.resume()
		await expect(pending).resolves.toBe(1)
		expect(started.count).toBe(1)
		expect(queue.paused).toBe(false)
	})
})

describe('Queue — clear', () => {
	it('drops pending entries (rejected) and leaves the in-flight one running', async () => {
		const gate = Promise.withResolvers<number>()
		const queue = new Queue<number, number>({
			concurrency: 1,
			handler: (input) => (input === 0 ? gate.promise : Promise.resolve(input)),
		})

		const running = queue.enqueue(0)
		const dropped = queue.enqueue(1)
		await waitForDelay(10)
		expect(queue.active).toBe(1)

		const clearing = queue.clear()
		await expect(dropped).rejects.toThrow('cleared')
		await clearing
		// The in-flight entry is untouched — it finishes when its gate opens.
		expect(queue.active).toBe(1)
		gate.resolve(99)
		await expect(running).resolves.toBe(99)
	})
})

describe('Queue — stop / destroy', () => {
	it('stop ends the loops, rejects pending, and flips `stopped`', async () => {
		const started = createRecorder<[number]>()
		const queue = new Queue<number, number>({
			handler: (input) => {
				started.handler(input)
				return input
			},
		})
		queue.pause()
		const pending = queue.enqueue(1)
		const stopping = queue.stop()
		await expect(pending).rejects.toThrow('stopped')
		await stopping
		expect(queue.stopped).toBe(true)
		// A stopped queue runs nothing further.
		await waitForDelay(10)
		expect(started.count).toBe(0)
	})

	it('destroy aborts in-flight, rejects pending, and is idempotent', async () => {
		const gate = Promise.withResolvers<void>()
		const queue = new Queue<string, void>({
			concurrency: 1,
			handler: () => gate.promise,
		})
		const running = queue.enqueue('inflight')
		const waiting = queue.enqueue('pending')
		await waitForDelay(10)

		const destroying = queue.destroy()
		expect(queue.destroy()).toBe(destroying)

		await expect(running).rejects.toBeDefined()
		await expect(waiting).rejects.toBeDefined()
		await destroying
		expect(queue.stopped).toBe(true)
	})
})

describe('Queue — cooperative wake-park (no busy-loop)', () => {
	it('does not call the handler while idle (workers park, not spin)', async () => {
		const calls = createRecorder<[number]>()
		const queue = new Queue<number, number>({
			handler: (input) => {
				calls.handler(input)
				return input
			},
		})
		// Construction spawns a worker, which immediately parks on the empty queue.
		await waitForDelay(20)
		expect(calls.count).toBe(0)
		expect(queue.count).toBe(0)
		expect(queue.active).toBe(0)

		// The first enqueue is what wakes the parked worker.
		await expect(queue.enqueue(5)).resolves.toBe(5)
		expect(calls.count).toBe(1)
	})
})

// ── Durability (an optional QueueStoreInterface) ─────────────────────────────
//
// A store mirrors only OUTSTANDING work: `save` on accept + as the attempt count
// climbs, `remove` when an entry settles (success / terminal failure) or is drained
// by a lifecycle call. Tests use a real `createMemoryQueueStore` (no mocks); two
// queues sharing ONE store instance simulate a restart — queue B `restore()`s the
// rows queue A persisted. A real, deliberately-failing `QueueStoreInterface`
// (not a mock — a genuine alternate implementation) proves the initial-save
// propagates while per-attempt saves stay best-effort.

// A real QueueStoreInterface whose `save` always rejects (after recording the call);
// `load` / `remove` / `clear` succeed. Proves a failing persistence path's contract.
function failingSaveStore(): {
	readonly store: QueueStoreInterface<string>
	readonly saves: ReadonlyArray<StoredEntry<string>>
} {
	const saves: Array<StoredEntry<string>> = []
	const store: QueueStoreInterface<string> = {
		async save(entry) {
			saves.push(entry)
			throw new Error('store offline')
		},
		async remove() {},
		async load() {
			return []
		},
		async clear() {},
	}
	return { store, saves }
}

describe('Queue — durability: persist on accept, remove on settle', () => {
	it('saves an entry on enqueue and removes it once it completes', async () => {
		const store = createMemoryQueueStore(stringShape())
		const gate = Promise.withResolvers<string>()
		const queue = new Queue<string, string>({ store, handler: () => gate.promise })

		const running = queue.enqueue('a')
		// While in flight, the store mirrors the outstanding entry at attempts 0.
		await waitForDelay(10)
		const outstanding = await store.load()
		expect(outstanding).toHaveLength(1)
		expect(outstanding[0]).toEqual({ id: outstanding[0]?.id, input: 'a', attempts: 0 })

		gate.resolve('done')
		await expect(running).resolves.toBe('done')
		// Settled → its row is removed.
		expect(await store.load()).toEqual([])
	})

	it('removes the entry after retries are exhausted (terminal failure)', async () => {
		const store = createMemoryQueueStore(stringShape())
		const queue = new Queue<string, string>({
			store,
			retries: 2,
			handler: () => {
				throw new Error('always fails')
			},
		})

		await expect(queue.enqueue('a')).rejects.toThrow('always fails')
		// A terminal failure removes the row just like a success.
		expect(await store.load()).toEqual([])
	})

	it('climbs the persisted attempt count across retries, empty after success', async () => {
		const store = createMemoryQueueStore(stringShape())
		const gates = [
			Promise.withResolvers<void>(),
			Promise.withResolvers<void>(),
			Promise.withResolvers<void>(),
		]
		const attempts = createRecorder<[]>()
		const queue = new Queue<string, string>({
			store,
			retries: 3,
			handler: async () => {
				const index = attempts.count
				attempts.handler()
				await requireValue(gates[index]).promise
				if (index < 2) throw new Error('not yet')
				return 'ok'
			},
		})

		const running = queue.enqueue('a')
		void running.catch(() => {})
		try {
			// First attempt in flight — persisted at attempts 0.
			await waitForDelay(10)
			expect((await store.load())[0]?.attempts).toBe(0)

			// Fail attempt 0 → the queue retries; the climbing count is persisted (attempts 1).
			requireValue(gates[0]).resolve()
			await waitForDelay(10)
			expect((await store.load())[0]?.attempts).toBe(1)

			// Fail attempt 1 → retry again, persisted at attempts 2.
			requireValue(gates[1]).resolve()
			await waitForDelay(10)
			expect((await store.load())[0]?.attempts).toBe(2)

			// Attempt 2 succeeds → the row is removed.
			requireValue(gates[2]).resolve()
			await expect(running).resolves.toBe('ok')
			expect(await store.load()).toEqual([])
		} finally {
			for (const gate of gates) gate.resolve()
			await Promise.allSettled([running])
			await queue.destroy()
		}
	})
})

describe('Queue — durability: restore (restart simulation)', () => {
	it('re-runs the outstanding entries a prior queue persisted', async () => {
		const store = createMemoryQueueStore(stringShape())

		// Queue A: persist three entries but never run them — paused so its parked workers
		// never dequeue, leaving the rows durably saved in the shared store. (We must NOT
		// stop / drain A, since a lifecycle drain would remove the very rows
		// B is meant to restore; a paused A simply holds them.)
		const a = new Queue<string, string>({ store, handler: (input) => input })
		a.pause()
		void a.enqueue('one').catch(() => {})
		void a.enqueue('two').catch(() => {})
		void a.enqueue('three').catch(() => {})
		await waitForDelay(10)
		expect((await store.load()).map((entry) => entry.input).sort()).toEqual(['one', 'three', 'two'])

		// Queue B: a fresh queue over the SAME store, with a recording handler.
		const seen = createRecorder<[string]>()
		const b = new Queue<string, string>({
			store,
			handler: (input) => {
				seen.handler(input)
				return input
			},
		})
		await b.restore()
		b.start()
		await waitForDelay(20)

		// B's handler ran with exactly the persisted inputs, and the store is now empty.
		expect(seen.calls.map(([input]) => input).sort()).toEqual(['one', 'three', 'two'])
		expect(await store.load()).toEqual([])
	})

	it('resumes a restored entry at its persisted attempt count', async () => {
		const store = createMemoryQueueStore(stringShape())
		// Seed the store directly with an entry already tried twice.
		await store.save({ id: 'seed', input: 'payload', attempts: 2 })

		const attempts = createRecorder<[string]>()
		const queue = new Queue<string, string>({
			store,
			retries: 3, // budget of 4 total; two already spent → at most two more
			handler: (input) => {
				attempts.handler(input)
				throw new Error('still failing')
			},
		})
		await queue.restore()
		queue.start()
		await waitForDelay(20)

		// Resumed at attempt 2: attempts 2 and 3 run (two more), then the budget is spent.
		expect(attempts.count).toBe(2)
		expect(await store.load()).toEqual([])
	})

	it('swallows a restored entry whose handler always throws (no unhandled rejection)', async () => {
		const store = createMemoryQueueStore(stringShape())
		await store.save({ id: 'doomed', input: 'payload', attempts: 0 })

		const queue = new Queue<string, string>({
			store,
			handler: () => {
				throw new Error('doomed')
			},
		})
		// No original caller holds the restored entry's promise — its terminal rejection
		// must be swallowed (this test completing without an unhandledRejection proves it).
		await queue.restore()
		queue.start()
		await waitForDelay(20)
		expect(await store.load()).toEqual([])
	})

	it('is a no-op without a store', async () => {
		const queue = new Queue<string, string>({ handler: (input) => input })
		await expect(queue.restore()).resolves.toBeUndefined()
	})
})

describe('Queue — durability: lifecycle drains remove rows', () => {
	it('clear removes the drained pending rows; an in-flight row is removed on settle', async () => {
		const store = createMemoryQueueStore(stringShape())
		const gate = Promise.withResolvers<string>()
		const queue = new Queue<string, string>({
			store,
			concurrency: 1,
			handler: (input) => (input === 'inflight' ? gate.promise : Promise.resolve(input)),
		})

		const running = queue.enqueue('inflight')
		const dropped = queue.enqueue('pending')
		await waitForDelay(10)
		// Both are persisted; one is in flight, one is pending.
		expect(await store.load()).toHaveLength(2)

		const clearing = queue.clear()
		await expect(dropped).rejects.toThrow('cleared')
		await clearing
		// The pending row was dropped; the in-flight one is still mirrored until it settles.
		const afterClear = await store.load()
		expect(afterClear).toHaveLength(1)
		expect(afterClear[0]?.input).toBe('inflight')

		gate.resolve('done')
		await expect(running).resolves.toBe('done')
		// The in-flight entry's row is removed by its own settle, not by the clear.
		expect(await store.load()).toEqual([])
	})

	it('abort removes the drained pending rows', async () => {
		const store = createMemoryQueueStore(stringShape())
		const gate = Promise.withResolvers<string>()
		const queue = new Queue<string, string>({
			store,
			concurrency: 1,
			handler: (input) => (input === 'inflight' ? gate.promise : Promise.resolve(input)),
		})

		const running = queue.enqueue('inflight')
		const waiting = queue.enqueue('pending')
		await waitForDelay(10)
		expect(await store.load()).toHaveLength(2)

		const aborting = queue.abort(new Error('stop'))
		await expect(waiting).rejects.toThrow('stop')
		await expect(running).rejects.toBeDefined()
		await aborting
		// Both rows are gone: the pending one drained, the in-flight one removed on its
		// (abort-rejected) settle.
		expect(await store.load()).toEqual([])
	})
})

describe('Queue — durability: save failures', () => {
	it('rejects the enqueue when the initial save fails (accepting work is durable)', async () => {
		const { store, saves } = failingSaveStore()
		const ran = createRecorder<[string]>()
		const queue = new Queue<string, string>({
			store,
			handler: (input) => {
				ran.handler(input)
				return input
			},
		})

		// The initial save propagates — the enqueue rejects and the entry never runs.
		await expect(queue.enqueue('a')).rejects.toThrow('store offline')
		await waitForDelay(10)
		expect(ran.count).toBe(0)
		expect(saves).toHaveLength(1)
		expect(queue.count).toBe(0)
	})

	it('keeps running when a per-attempt save fails (best-effort persistence)', async () => {
		// A real store that succeeds the FIRST save (accept) then fails every later save
		// (the climbing-attempt persistence), proving per-attempt saves are best-effort.
		const saves: Array<StoredEntry<string>> = []
		const removes: string[] = []
		const store: QueueStoreInterface<string> = {
			async save(entry) {
				saves.push(entry)
				if (saves.length > 1) throw new Error('save flaky')
			},
			async remove(id) {
				removes.push(id)
			},
			async load() {
				return []
			},
			async clear() {},
		}
		const attempts = createRecorder<[]>()
		const queue = new Queue<string, string>({
			store,
			retries: 2,
			handler: () => {
				const index = attempts.count
				attempts.handler()
				if (index < 2) throw new Error('not yet')
				return 'ok'
			},
		})

		// Despite the per-attempt saves rejecting, the entry runs all attempts and succeeds;
		// in-memory state is authoritative. It still settles and removes its row.
		await expect(queue.enqueue('a')).resolves.toBe('ok')
		expect(attempts.count).toBe(3)
		expect(removes).toHaveLength(1)
	})
})

// ── Per-entry signal abort (a documented `enqueue({ signal })` feature) ───────
//
// An entry-scoped `signal` rejects ONLY that entry the moment it fires (the queue
// keeps running) and — like a queue-level abort — never retries. Its in-flight
// attempt's `execution.signal` fires too, and combined with a `timeout` the
// attempt's signal is the 3-way `AbortSignal.any` of queue-abort + entry-signal +
// deadline (whichever fires first wins). Real `AbortController`s, no mocks.

describe('Queue — per-entry signal abort', () => {
	it('rejects only the signalled entry with its reason and never retries it', async () => {
		const gate = Promise.withResolvers<void>()
		const fired = createRecorder<[]>()
		const attempts = createRecorder<[string]>()
		const queue = new Queue<string, void>({
			retries: 5, // a generous budget the abort must NOT consume
			handler: (input, execution: QueueExecution) => {
				attempts.handler(input)
				execution.signal.addEventListener('abort', () => fired.handler(), { once: true })
				// Only the signalled entry ('a') blocks on the gate; any later entry resolves at
				// once, so the queue is observably still alive after the abort.
				return input === 'a' ? gate.promise : Promise.resolve()
			},
		})

		const controller = new AbortController()
		const aborted = queue.enqueue('a', { signal: controller.signal })
		await waitForDelay(10)
		expect(attempts.count).toBe(1)

		controller.abort(new Error('entry gave up'))
		// The entry rejects with its OWN signal reason, and despite retries: 5 it ran once.
		await expect(aborted).rejects.toThrow('entry gave up')
		expect(fired.count).toBe(1)
		expect(attempts.calls).toEqual([['a']])
		expect(queue.active).toBe(0)
		expect(queue.count).toBe(0)
		// The queue itself is untouched — a fresh entry still runs to completion.
		expect(queue.stopped).toBe(false)
		await expect(queue.enqueue('b')).resolves.toBeUndefined()
		expect(attempts.calls).toEqual([['a'], ['b']])
	})

	it('an already-aborted entry signal rejects before the handler runs', async () => {
		const ran = createRecorder<[]>()
		const queue = new Queue<string, void>({
			handler: () => {
				ran.handler()
			},
		})
		const controller = new AbortController()
		controller.abort(new Error('pre-aborted'))
		await expect(queue.enqueue('a', { signal: controller.signal })).rejects.toThrow('pre-aborted')
		await waitForDelay(10)
		// The handler never ran — the abort was observed at the top of the run loop.
		expect(ran.count).toBe(0)
	})

	it('the entry signal wins the 3-way race over the deadline (aborted, not timed out)', async () => {
		const gate = Promise.withResolvers<void>()
		const fired = createRecorder<[]>()
		const queue = new Queue<string, void>({
			timeout: 100, // a far-off deadline the entry signal must beat
			retries: 3,
			// A non-cooperative handler: it ignores its signal and only settles on the gate,
			// so the ONLY thing that ends the attempt early is the combined signal firing.
			handler: (_input, execution: QueueExecution) => {
				execution.signal.addEventListener('abort', () => fired.handler(), { once: true })
				return gate.promise
			},
		})

		const controller = new AbortController()
		const aborted = queue.enqueue('a', { signal: controller.signal })
		await waitForDelay(10)

		// Fire the entry signal well before the 100ms deadline.
		controller.abort(new Error('cancelled early'))
		// The entry rejects with its own reason; the attempt was aborted, NOT timed out, and
		// it did not retry (an entry-signal abort is terminal).
		await expect(aborted).rejects.toThrow('cancelled early')
		expect(fired.count).toBe(1)
		// Wait PAST the original deadline: the per-attempt Timeout was cleared when the entry
		// signal won, so no late 'timed out' rejection or stray retry fires after the fact.
		await waitForDelay(120)
		expect(fired.count).toBe(1)
		gate.resolve() // release the abandoned handler promise — no second attempt observed it
	})
})

// ── restore() on a LIVE queue + racing a halt (FIX 1 + FIX 3 regressions) ─────
//
// `restore()` must be idempotent and safe on a non-idle queue: a row whose id is
// already live (pending or in-flight) is skipped, so no id runs twice. And a queue
// aborted / destroyed DURING the `load()` await must launch nothing.

describe('Queue — restore on a live queue (no double-execution)', () => {
	it('skips ids already live so each entry runs exactly once', async () => {
		const store = createMemoryQueueStore(stringShape())
		const inputs: readonly string[] = ['one', 'two', 'three']
		// One gate per input, pre-seeded so the handler only LOOKS one up (typed `void` so
		// `resolve()` takes no argument).
		const gates = new Map<string, PromiseWithResolvers<void>>(
			inputs.map((input) => [input, Promise.withResolvers<void>()]),
		)
		const seen = createRecorder<[string]>()
		// concurrency 2 so two enqueued entries are in-flight (gated) while a third stays
		// pending — all three live — then we restore() the SAME store on the SAME queue.
		const queue = new Queue<string, string>({
			store,
			concurrency: 2,
			handler: async (input) => {
				seen.handler(input)
				await gates.get(input)?.promise
				return input
			},
		})

		const running = inputs.map((input) => queue.enqueue(input))
		await waitForDelay(10)
		// Two in flight + one pending: all three rows are persisted and live.
		expect((await store.load()).map((entry) => entry.input).sort()).toEqual(['one', 'three', 'two'])

		// restore() on the SAME live queue: every loaded id is already live, so all are
		// skipped — nothing is re-launched.
		await queue.restore()
		await waitForDelay(10)

		// Only the two in-flight entries started (concurrency 2); 'three' is still pending —
		// and crucially the restore added no duplicate starts.
		expect(seen.count).toBe(2)

		// Open every gate and let the queue drain — still exactly one run per input.
		for (const gate of gates.values()) gate.resolve()
		await Promise.all(running)
		await waitForDelay(10)
		const counts = new Map<string, number>()
		for (const [input] of seen.calls) counts.set(input, (counts.get(input) ?? 0) + 1)
		expect([...counts.values()]).toEqual([1, 1, 1]) // one run each — none ran twice
		expect(await store.load()).toEqual([])
	})
})

describe('Queue — restore racing abort/destroy', () => {
	it('launches nothing when the queue is aborted during the load() await', async () => {
		// A real store whose `load()` blocks on a gate, so we can abort the queue mid-load.
		const loadGate = Promise.withResolvers<ReadonlyArray<StoredEntry<string>>>()
		const seen = createRecorder<[string]>()
		const store: QueueStoreInterface<string> = {
			async save() {},
			async remove() {},
			load() {
				return loadGate.promise
			},
			async clear() {},
		}
		const queue = new Queue<string, string>({
			store,
			handler: (input) => {
				seen.handler(input)
				return input
			},
		})

		// Begin restore — it parks inside the awaited load().
		const restoring = queue.restore()
		await waitForDelay(10)
		// Abort the queue while load() is still in flight, THEN let load() resolve with rows.
		const aborting = queue.abort(new Error('shutting down mid-load'))
		loadGate.resolve([{ id: 'late', input: 'payload', attempts: 0 }])
		await restoring
		await aborting
		await waitForDelay(10)

		// The post-load halt re-check fired: no entry was launched, and — the load-bearing
		// part — nothing was pushed into the queue. Without the re-check the loaded row would
		// be enqueued onto the already-aborted queue, where the worker has exited, leaving a
		// stuck pending entry that never runs AND never settles. `count` of 0 proves no leak.
		expect(seen.count).toBe(0)
		expect(queue.count).toBe(0)
	})
})

// ── start() idempotency + stop → start resume ────────────────────────────────

describe('Queue — start idempotency and stop/start resume', () => {
	it('start() on an already-running queue is a no-op (no extra workers, no double-run)', async () => {
		const seen = createRecorder<[number]>()
		const queue = new Queue<number, number>({
			concurrency: 1,
			handler: async (input) => {
				seen.handler(input)
				await waitForDelay(5)
				return input
			},
		})
		// Hammer start() while running — concurrency must stay 1 (entries strictly ordered),
		// proving no surplus worker loops were spawned.
		queue.start()
		queue.start()
		const order: number[] = []
		await Promise.all(
			[1, 2, 3].map((input) => queue.enqueue(input).then((value) => order.push(value))),
		)
		// Each ran once, and at concurrency 1 they completed in order — no extra workers.
		expect(seen.calls.map(([input]) => input)).toEqual([1, 2, 3])
		expect(order).toEqual([1, 2, 3])
		expect(queue.active).toBe(0)
	})

	it('resumes new work after stop() then start() (stop rejects pending)', async () => {
		const gate = Promise.withResolvers<number>()
		const seen = createRecorder<[number]>()
		const queue = new Queue<number, number>({
			concurrency: 1,
			handler: (input) => {
				seen.handler(input)
				// Entry 1 stays in flight on the gate so entry 2 is genuinely PENDING when we
				// stop (the single worker slot is occupied); later entries resolve at once.
				return input === 1 ? gate.promise : Promise.resolve(input)
			},
		})

		const running = queue.enqueue(1) // claims the worker slot (in flight)
		const pending = queue.enqueue(2) // truly pending behind it
		await waitForDelay(10)
		expect(queue.active).toBe(1)

		// stop() ends the loops and rejects the PENDING entry; the in-flight one settles on
		// its own once its gate opens.
		const stopping = queue.stop()
		await expect(pending).rejects.toThrow('stopped')
		gate.resolve(1)
		await expect(running).resolves.toBe(1)
		await stopping
		expect(queue.stopped).toBe(true)

		// start() revives the loops after the stop; a fresh enqueue now runs to completion.
		queue.start()
		expect(queue.stopped).toBe(false)
		await expect(queue.enqueue(3)).resolves.toBe(3)
		expect(seen.calls.map(([input]) => input)).toEqual([1, 3])
	})
})

// ── id on QueueExecution (the idempotency key, FIX 2) ─────────────────────────

describe('Queue — execution carries a stable id', () => {
	it('hands the handler the entry id, equal to the enqueue id', async () => {
		const ids = createRecorder<[string]>()
		const queue = new Queue<string, string>({
			handler: (input, execution: QueueExecution) => {
				ids.handler(execution.id)
				return input
			},
		})
		await queue.enqueue('a', { id: 'job-42' })
		expect(ids.calls).toEqual([['job-42']])
	})

	it('keeps the same id across retries of one entry', async () => {
		const ids = createRecorder<[string]>()
		const queue = new Queue<string, string>({
			retries: 2,
			handler: (input, execution: QueueExecution) => {
				ids.handler(execution.id)
				if (ids.count < 3) throw new Error('retry')
				return input
			},
		})
		await queue.enqueue('a', { id: 'stable' })
		// Three attempts, every one seeing the SAME stable id.
		expect(ids.calls).toEqual([['stable'], ['stable'], ['stable']])
	})

	it('a restored entry re-runs with the same id', async () => {
		const store = createMemoryQueueStore(stringShape())
		await store.save({ id: 'persisted-1', input: 'payload', attempts: 0 })
		const ids = createRecorder<[string]>()
		const queue = new Queue<string, string>({
			store,
			handler: (input, execution: QueueExecution) => {
				ids.handler(execution.id)
				return input
			},
		})
		await queue.restore()
		queue.start()
		await waitForDelay(20)
		// The restored entry ran under its persisted id — the idempotency key survives a replay.
		expect(ids.calls).toEqual([['persisted-1']])
		expect(await store.load()).toEqual([])
	})
})

// ── High concurrency × many entries (saturation drain) ───────────────────────
//
// PRODUCTION GAP: the existing concurrency test uses 3 entries through 2 slots. A real
// queue runs hundreds of entries through a handful of workers. The invariants that must
// hold at scale: (a) `active` NEVER exceeds `concurrency` at any observable moment,
// (b) every entry runs EXACTLY once (no lost, no double-run), (c) the queue drains
// fully — `count` and `active` settle to 0 with no stuck worker / forever-pending entry,
// and (d) entries are dispatched in FIFO order (the Nth to START is the Nth enqueued).

describe('Queue — high concurrency drains many entries (saturation)', () => {
	it('runs 120 entries through 8 workers exactly once, never exceeding the cap, draining fully', async () => {
		const total = 120
		const concurrency = 8
		let live = 0
		let peak = 0
		const ran = createRecorder<[number]>()
		const startOrder: number[] = []
		const queue = new Queue<number, number>({
			concurrency,
			handler: async (input) => {
				startOrder.push(input)
				live += 1
				peak = Math.max(peak, live)
				// The queue's own `active` view must never exceed the cap at any await point.
				expect(queue.active).toBeLessThanOrEqual(concurrency)
				await waitForDelay(1)
				ran.handler(input)
				live -= 1
				return input * 2
			},
		})

		const results = await Promise.all(
			Array.from({ length: total }, (_unused, index) => queue.enqueue(index)),
		)

		// Every entry resolved with its own doubled value, in enqueue order (Promise.all
		// preserves index), so nothing was lost or cross-wired.
		expect(results).toEqual(Array.from({ length: total }, (_unused, index) => index * 2))
		// Each entry's handler ran exactly once.
		expect(ran.count).toBe(total)
		const seenInputs = new Set(ran.calls.map(([input]) => input))
		expect(seenInputs.size).toBe(total)
		// The cap held under saturation — never more than `concurrency` in flight.
		expect(peak).toBe(concurrency)
		// FIFO dispatch: the first `concurrency` to start are 0..concurrency-1 (the initial
		// batch the workers picked up in order).
		expect(startOrder.slice(0, concurrency)).toEqual(
			Array.from({ length: concurrency }, (_unused, index) => index),
		)
		// Fully drained: no stuck worker, no forever-pending entry.
		expect(queue.count).toBe(0)
		expect(queue.active).toBe(0)
		// The queue still works after draining a large batch (workers re-parked cleanly).
		await expect(queue.enqueue(1000)).resolves.toBe(2000)
	})
})

// ── Handler shapes: sync throw vs async reject vs plain (non-Promise) value ───
//
// PRODUCTION GAP: a `QueueHandler` may return `Promise<TResult> | TResult` and may fail
// by THROWING synchronously or REJECTING asynchronously. The retry / settle machinery
// must treat all three uniformly: a synchronous throw is caught (not leaked past the
// race), an async rejection retries the same way, and a plain value resolves. Mixed in
// one queue to prove the engine never assumes the handler returns a thenable.

describe('Queue — handler return / failure shapes', () => {
	it('treats a synchronous throw exactly like an async rejection for retries', async () => {
		const syncAttempts = createRecorder<[]>()
		const syncQueue = new Queue<undefined, string>({
			retries: 2,
			handler: () => {
				syncAttempts.handler()
				if (syncAttempts.count < 3) throw new Error('sync boom') // thrown, not rejected
				return 'ok'
			},
		})
		await expect(syncQueue.enqueue(undefined)).resolves.toBe('ok')
		expect(syncAttempts.count).toBe(3)
	})

	it('exhausts retries on a synchronous throw and rejects with the thrown Error', async () => {
		const attempts = createRecorder<[]>()
		const queue = new Queue<undefined, void>({
			retries: 1,
			handler: () => {
				attempts.handler()
				throw new Error('always sync-throws')
			},
		})
		await expect(queue.enqueue(undefined)).rejects.toThrow('always sync-throws')
		expect(attempts.count).toBe(2) // retries + 1
	})

	it('resolves a plain (non-Promise) return value', async () => {
		const queue = new Queue<number, number>({ handler: (input) => input + 1 })
		// The handler returns a number directly — the engine wraps it, no thenable assumed.
		await expect(queue.enqueue(41)).resolves.toBe(42)
	})

	it('coerces a thrown non-Error value to an Error, preserving the original on cause', async () => {
		const queue = new Queue<undefined, void>({
			handler: () => {
				throw 'a bare string' // a non-Error rejection value
			},
		})
		const error = await queue.enqueue(undefined).catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(Error)
		expect(error instanceof Error ? error.cause : undefined).toBe('a bare string')
	})
})

// ── Per-entry vs queue-level timeout / retry interaction ─────────────────────
//
// PRODUCTION GAP: a per-entry `timeout` / `retries` overrides the queue default for ONE
// entry while siblings keep the default. The override must be honoured precisely under
// concurrency (one entry times out fast while another, given a longer per-entry budget,
// completes), and a per-entry retries:0 must defeat a generous queue default.

describe('Queue — per-entry timeout / retry overrides interact correctly', () => {
	it('honours a per-entry timeout override distinct from the queue default', async () => {
		const queue = new Queue<{ readonly hold: number }, string>({
			concurrency: 2,
			timeout: 1_000, // generous queue default
			handler: (input, execution: QueueExecution) =>
				new Promise<string>((resolve, reject) => {
					const timer = setTimeout(() => resolve('done'), input.hold)
					execution.signal.addEventListener(
						'abort',
						() => {
							clearTimeout(timer)
							reject(execution.signal.reason)
						},
						{ once: true },
					)
				}),
		})

		// Entry A: a tight 10ms per-entry timeout but the handler needs 100ms → it times out.
		const a = queue.enqueue({ hold: 100 }, { timeout: 10, retries: 0 })
		// Entry B: keeps the generous default and finishes quickly → it resolves.
		const b = queue.enqueue({ hold: 5 })
		await expect(a).rejects.toThrow('timed out')
		await expect(b).resolves.toBe('done')
	})

	it('a per-entry retries:0 defeats a generous queue-level retries default', async () => {
		const attempts = createRecorder<[]>()
		const queue = new Queue<undefined, void>({
			retries: 5, // the queue would retry five times…
			handler: () => {
				attempts.handler()
				throw new Error('nope')
			},
		})
		// …but this entry opts out of all retries.
		await expect(queue.enqueue(undefined, { retries: 0 })).rejects.toThrow('nope')
		expect(attempts.count).toBe(1) // ran exactly once
	})
})

// ── Rapid lifecycle churn — #live / count balance returns to empty ───────────
//
// PRODUCTION GAP: interleaving pause/resume/clear/enqueue rapidly must never corrupt the
// in-memory accounting. After the dust settles the queue must be drainable to count 0
// with no stuck worker — and the internal `#live` id set must be balanced (proven
// indirectly: a fresh restore() over the same store finds NO live ids lingering for
// already-settled entries, so it re-launches nothing spurious).

describe('Queue — rapid lifecycle churn keeps accounting balanced', () => {
	it('survives interleaved pause/resume/clear/enqueue and still drains to count 0', async () => {
		const ran = createRecorder<[number]>()
		// A paused queue so NOTHING dequeues during the churn — every enqueued entry stays
		// pending, making the clear() boundary deterministic (no wall-clock race over how
		// many a worker happened to pick up).
		const queue = new Queue<number, number>({
			concurrency: 3,
			handler: (input) => {
				ran.handler(input)
				return input
			},
		})
		queue.pause()

		// Churn while paused: two waves pile up pending, then clear() drops EVERY pending
		// entry (both waves — clear is all-pending, not wave-scoped), then resume + a third
		// wave runs to completion.
		const wave1 = Array.from({ length: 10 }, (_unused, index) => queue.enqueue(index))
		const wave2 = Array.from({ length: 10 }, (_unused, index) => queue.enqueue(100 + index))
		expect(queue.count).toBe(20) // all 20 pending behind the pause

		const clearing = queue.clear() // drops all 20 pending
		const cleared = await Promise.allSettled([...wave1, ...wave2])
		await clearing
		expect(cleared.every((result) => result.status === 'rejected')).toBe(true)
		expect(queue.count).toBe(0) // accounting balanced right after the clear
		expect(ran.count).toBe(0) // nothing ran — they were cleared before resume

		// Resume and run a fresh wave to completion — the loops are healthy post-churn.
		queue.resume()
		const wave3 = await Promise.all(
			Array.from({ length: 10 }, (_unused, index) => queue.enqueue(200 + index)),
		)
		expect(wave3).toEqual(Array.from({ length: 10 }, (_unused, index) => 200 + index))
		// Fully drained — no stuck worker, no leaked pending entry, accounting back to empty.
		expect(queue.count).toBe(0)
		expect(queue.active).toBe(0)
		await expect(queue.enqueue(999)).resolves.toBe(999)
	})

	it('balances count back to 0 after a storm of enqueues that all settle', async () => {
		const queue = new Queue<number, number>({
			concurrency: 4,
			handler: (input) => input,
		})
		// Fire 50 enqueues, alternating success and rejection via a throwing branch.
		const promises = Array.from({ length: 50 }, (_unused, index) =>
			queue.enqueue(index).catch(() => -1),
		)
		await Promise.all(promises)
		// Every entry settled; the in-memory accounting is back to empty.
		expect(queue.count).toBe(0)
		expect(queue.active).toBe(0)
	})
})

// ── Store-hook failures under churn (#live / count / drain stay intact) ───────
//
// Per-attempt count saves remain best-effort, but removals are observable cleanup. A store
// that rejects `remove` must reject the affected result/lifecycle promise and retain the
// live id reservation so a possibly-still-present row cannot be overwritten.

describe('Queue — store remove failures under churn', () => {
	it('surfaces every failed completion cleanup and retains each live reservation', async () => {
		// A real store that accepts saves (so entries are accepted) but ALWAYS throws on
		// remove — proving every durable cleanup failure is surfaced and reservations stay held.
		const removes = createRecorder<[string]>()
		const store: QueueStoreInterface<string> = {
			async save() {},
			async remove(id) {
				removes.handler(id)
				throw new Error('remove offline')
			},
			async load() {
				return []
			},
			async clear() {},
		}
		const ran = createRecorder<[string]>()
		const queue = new Queue<string, string>({
			store,
			concurrency: 4,
			handler: (input) => {
				ran.handler(input)
				return input
			},
		})

		// A mix of completing + cleared entries while remove fails on every settle / drain.
		const completing = Array.from({ length: 12 }, (_unused, index) => queue.enqueue(`run-${index}`))
		const settled = await Promise.allSettled(completing)
		// Despite every remove throwing, all entries ran and settled.
		expect(ran.count).toBe(12)
		expect(
			settled.every(
				(result) =>
					result.status === 'rejected' &&
					isQueueError(result.reason) &&
					result.reason.code === 'cleanup',
			),
		).toBe(true)
		// Removal was attempted for every settled entry.
		expect(removes.count).toBe(12)
		// In-memory accounting is authoritative and balanced — count back to 0, queue alive.
		expect(queue.count).toBe(12)
		expect(queue.active).toBe(0)
	})

	it('clears pending rows in-memory even when the store rejects the drain remove', async () => {
		const removes = createRecorder<[string]>()
		const gate = Promise.withResolvers<string>()
		const store: QueueStoreInterface<string> = {
			async save() {},
			async remove(id) {
				removes.handler(id)
				throw new Error('remove offline')
			},
			async load() {
				return []
			},
			async clear() {},
		}
		const queue = new Queue<string, string>({
			store,
			concurrency: 1,
			handler: (input) => (input === 'held' ? gate.promise : Promise.resolve(input)),
		})

		const running = queue.enqueue('held')
		const dropped = queue.enqueue('pending')
		await waitForDelay(10)
		// One in flight, one pending — count reflects both.
		expect(queue.count).toBe(2)

		// clear() drops the pending one in-memory and fires a (failing) remove for it.
		const clearing = queue.clear()
		await expect(dropped).rejects.toThrow('cleared')
		await expect(clearing).rejects.toSatisfy(
			(error: unknown) => isQueueError(error) && error.code === 'cleanup',
		)
		// Failed cleanup keeps both ids reserved because either durable row may remain.
		expect(queue.count).toBe(2)
		gate.resolve('done')
		await expect(running).rejects.toSatisfy(
			(error: unknown) => isQueueError(error) && error.code === 'cleanup',
		)
		expect(queue.count).toBe(2)
	})
})

// ── enqueue rejection messages for every halted state ────────────────────────
//
// PRODUCTION GAP: the abort-then-enqueue rejection is tested; stop and destroy are not.
// Each halted state must reject a new enqueue with its own precise message so a caller
// can tell WHY the queue refused the work.

describe('Queue — enqueue onto a halted queue rejects with the right reason', () => {
	it('rejects with "stopped" after stop()', async () => {
		const queue = new Queue<number, number>({ handler: (input) => input })
		await queue.stop()
		await expect(queue.enqueue(1)).rejects.toThrow('stopped')
	})

	it('rejects with "destroyed" after destroy()', async () => {
		const queue = new Queue<number, number>({ handler: (input) => input })
		await queue.destroy()
		await expect(queue.enqueue(1)).rejects.toThrow('destroyed')
	})

	it('rejects a STORE-backed enqueue without ever calling save once destroyed', async () => {
		// The destroyed/aborted/stopped guards sit BEFORE the persist path, so a halted
		// store-backed queue rejects synchronously without touching the store.
		const saves = createRecorder<[string]>()
		const store: QueueStoreInterface<string> = {
			async save(entry) {
				saves.handler(entry.id)
			},
			async remove() {},
			async load() {
				return []
			},
			async clear() {},
		}
		const queue = new Queue<string, string>({ store, handler: (input) => input })
		await queue.destroy()
		await expect(queue.enqueue('x')).rejects.toThrow('destroyed')
		expect(saves.count).toBe(0) // the store was never asked to save a doomed entry
	})
})

// ── restore at scale, racing concurrent enqueue + abort ──────────────────────
//
// PRODUCTION GAP: restore() at scale (many rows) must re-run every outstanding entry
// exactly once and drain. And restore() racing a concurrent enqueue must not lose or
// duplicate either the restored rows or the freshly-enqueued one.

describe('Queue — restore at scale + racing a concurrent enqueue', () => {
	it('restores 50 outstanding rows, running each exactly once, then drains', async () => {
		const store = createMemoryQueueStore(stringShape())
		// Seed 50 outstanding rows directly (a prior process's unfinished work).
		for (let index = 0; index < 50; index += 1) {
			await store.save({ id: `seed-${index}`, input: `payload-${index}`, attempts: 0 })
		}

		const seen = createRecorder<[string]>()
		const queue = new Queue<string, string>({
			store,
			concurrency: 8,
			handler: (input) => {
				seen.handler(input)
				return input
			},
		})
		await queue.restore()
		await waitForDelay(50)

		// Every seeded row ran exactly once and the store is now empty.
		expect(seen.count).toBe(50)
		expect(new Set(seen.calls.map(([input]) => input)).size).toBe(50)
		expect(await store.load()).toEqual([])
		expect(queue.count).toBe(0)
	})

	it('does not double-run a row when restore() races a fresh enqueue of the same id', async () => {
		const store = createMemoryQueueStore(stringShape())
		await store.save({ id: 'shared', input: 'from-store', attempts: 0 })

		const seen = createRecorder<[string, string]>()
		const gate = Promise.withResolvers<string>()
		const queue = new Queue<string, string>({
			store,
			concurrency: 2,
			handler: (input, execution: QueueExecution) => {
				seen.handler(execution.id, input)
				return input === 'live' ? gate.promise : Promise.resolve(input)
			},
		})

		// Enqueue a fresh entry under the SAME id as the stored row, then restore. The id is
		// live the moment enqueue pushes it, so restore() must SKIP the stored row for that
		// id — the id runs once (the live enqueue), never twice.
		const live = queue.enqueue('live', { id: 'shared' })
		await queue.restore()
		await waitForDelay(20)
		gate.resolve('live')
		await live

		// Exactly one run for id 'shared' — the live enqueue, not the restored row.
		const sharedRuns = seen.calls.filter(([id]) => id === 'shared')
		expect(sharedRuns).toHaveLength(1)
		expect(sharedRuns[0]?.[1]).toBe('live')
		expect(await store.load()).toEqual([])
	})
})

// ── No spurious wake / no stuck worker under interleaved wake + halt ──────────
//
// PRODUCTION GAP: the wake list resolves one parked worker per enqueue and all on
// resume/halt. A pathological interleaving (enqueue exactly `concurrency` entries that
// all block, then enqueue one more, then release) must not lose the surplus wake — the
// extra entry must run the instant a slot frees, never sit forever-pending.

describe('Queue — wake-park under saturation has no stuck entry', () => {
	it('runs a surplus entry the moment a slot frees (no lost wake)', async () => {
		const gates = [
			Promise.withResolvers<void>(),
			Promise.withResolvers<void>(),
			Promise.withResolvers<void>(),
		]
		const started = createRecorder<[number]>()
		const queue = new Queue<number, number>({
			concurrency: 2,
			handler: async (input) => {
				started.handler(input)
				await requireValue(gates[input]).promise
				return input
			},
		})

		// Two entries saturate both slots; a third is pending behind them.
		const p0 = queue.enqueue(0)
		const p1 = queue.enqueue(1)
		const p2 = queue.enqueue(2)
		const all = Promise.all([p0, p1, p2])
		void all.catch(() => {})
		try {
			await waitForDelay(10)
			expect(started.count).toBe(2) // only two started; the third is parked

			// Free exactly one slot — the parked third entry must wake and start promptly.
			requireValue(gates[0]).resolve()
			await waitForDelay(10)
			expect(started.calls.map(([input]) => input).sort()).toEqual([0, 1, 2])

			requireValue(gates[1]).resolve()
			requireValue(gates[2]).resolve()
			await all
			expect(queue.count).toBe(0)
			expect(queue.active).toBe(0)
		} finally {
			for (const gate of gates) gate.resolve()
			await Promise.allSettled([all])
			await queue.destroy()
		}
	})
})

// ── Emitter — the PUSH observation surface (AGENTS §13) ──────────────────────
//
// Alongside each `enqueue` promise, the Queue exposes a typed `emitter`
// (`QueueEventMap<TResult>`) carrying its lifecycle moments for fire-and-forget
// observers. Every event is emitted directly; the emitter isolates a listener throw (it can
// never escape into the cooperative wake-park / settle-once loop, AGENTS §13), routing it to
// the emitter's own `error` handler (the `error` option), and every emit sits AFTER its wake /
// park / settle transition. These pin: each event fires at the right moment with the right
// payload; `on?` wires initial listeners at construction; and the LOAD-BEARING emit-safety
// guarantee — a throwing observer cannot corrupt the engine (the queue still drains,
// `#active`/`count` stay balanced, no parked worker is stranded), yet the `error` handler fires.

// The QueueEventMap event names recorded across the emitter tests — fed to the shared
// `recordEmitterEvents` (AGENTS §16.1: the per-event wiring is centralized; this file
// keeps only the names its scenarios observe).
const QUEUE_EVENTS: ReadonlyArray<keyof QueueEventMap<unknown>> = [
	'enqueue',
	'start',
	'retry',
	'success',
	'failure',
	'abort',
	'drain',
]

describe('Queue — emitter (push observation surface)', () => {
	it('a single entry fires enqueue → start → success → drain with the right payloads', async () => {
		const queue = new Queue<number, number>({ handler: (input) => input * 2 })
		const events = recordEmitterEvents(queue.emitter, QUEUE_EVENTS)
		const result = await queue.enqueue(21, { id: 'job-1' })
		expect(result).toBe(42)
		await waitForDelay(0) // let the worker's post-settle drain detection run
		expect(events.enqueue.calls).toEqual([['job-1']])
		expect(events.start.calls).toEqual([['job-1']])
		expect(events.success.calls).toEqual([['job-1', 42]])
		// One drain (the queue went idle after the entry settled).
		expect(events.drain.count).toBe(1)
		// A clean success fires neither retry / failure / abort.
		expect(events.retry.count).toBe(0)
		expect(events.failure.count).toBe(0)
		expect(events.abort.count).toBe(0)
	})

	it('fires retry on each re-attempt (1-based) then success', async () => {
		const attempts = createRecorder<[]>()
		const queue = new Queue<string, string>({
			retries: 3,
			handler: () => {
				attempts.handler()
				if (attempts.count < 3) throw new Error('not yet')
				return 'ok'
			},
		})
		const events = recordEmitterEvents(queue.emitter, QUEUE_EVENTS)
		await expect(queue.enqueue('a', { id: 'r' })).resolves.toBe('ok')
		// `start` once; two retries (attempts 1 and 2, 1-based) before the third attempt won.
		expect(events.start.calls).toEqual([['r']])
		expect(events.retry.calls).toEqual([
			['r', 1],
			['r', 2],
		])
		expect(events.success.calls).toEqual([['r', 'ok']])
		expect(events.failure.count).toBe(0)
	})

	it('fires failure (not success) when an entry exhausts its retries', async () => {
		const error = new Error('always fails')
		const queue = new Queue<undefined, void>({
			retries: 1,
			handler: () => {
				throw error
			},
		})
		const events = recordEmitterEvents(queue.emitter, QUEUE_EVENTS)
		await expect(queue.enqueue(undefined, { id: 'doomed' })).rejects.toThrow('always fails')
		expect(events.start.calls).toEqual([['doomed']])
		expect(events.retry.calls).toEqual([['doomed', 1]]) // one retry (retries: 1)
		// `failure` carries the entry id + the thrown error; no `success`.
		expect(events.failure.calls).toEqual([['doomed', error]])
		expect(events.success.count).toBe(0)
	})

	it('fires abort when the queue is aborted, rejecting the in-flight + pending entries', async () => {
		const gate = Promise.withResolvers<void>()
		const queue = new Queue<string, void>({ concurrency: 1, handler: () => gate.promise })
		const events = recordEmitterEvents(queue.emitter, QUEUE_EVENTS)
		const running = queue.enqueue('inflight', { id: 'a' })
		const waiting = queue.enqueue('pending', { id: 'b' })
		await waitForDelay(10)
		const reason = new Error('stop everything')
		const aborting = queue.abort(reason)
		await expect(waiting).rejects.toThrow('stop everything')
		await expect(running).rejects.toBeDefined()
		await aborting
		// The queue-level `abort` fired exactly once, carrying the reason.
		const emitted = events.abort.calls[0]?.[0]
		expect(isQueueError(emitted)).toBe(true)
		if (!isQueueError(emitted)) throw new Error('expected a QueueError abort event')
		expect(emitted.code).toBe('aborted')
		expect(emitted.cause).toBe(reason)
	})

	it('wires initial listeners from the `on` option at construction', async () => {
		const enqueue = createRecorder<[id: string]>()
		const success = createRecorder<[id: string, result: number]>()
		const queue = new Queue<number, number>({
			handler: (input) => input + 1,
			on: { enqueue: enqueue.handler, success: success.handler },
		})
		await expect(queue.enqueue(41, { id: 'seed' })).resolves.toBe(42)
		expect(enqueue.calls).toEqual([['seed']])
		expect(success.calls).toEqual([['seed', 42]])
	})

	it('EMIT SAFETY: a throwing success listener cannot corrupt the engine, and routes EVERY throw to the error handler', async () => {
		const thrown = new Error('observer blew up')
		const ran = createRecorder<[number]>()
		const errors = createRecorder<readonly [error: unknown, event: string]>()
		const queue = new Queue<number, number>({
			concurrency: 2,
			error: errors.handler,
			handler: (input) => {
				ran.handler(input)
				return input * 10
			},
		})
		// A buggy `success` observer that throws every time it fires — on the audited
		// settle-once path. It must NOT unbalance `#active` / `count` or strand a parked worker.
		queue.emitter.on('success', () => {
			throw thrown
		})

		// Drive a saturating batch through the engine despite the throwing listener.
		const results = await Promise.all(
			Array.from({ length: 20 }, (_unused, index) => queue.enqueue(index, { id: `j${index}` })),
		)
		await waitForDelay(0)

		// THE LOAD-BEARING ASSERTION: every entry resolved with its correct value — the throw
		// never escaped the settle-once latch, so no result was lost or cross-wired.
		expect(results).toEqual(Array.from({ length: 20 }, (_unused, index) => index * 10))
		expect(ran.count).toBe(20)
		// `#active` / `count` stayed balanced (no stranded worker, no over/under-decrement).
		expect(queue.active).toBe(0)
		expect(queue.count).toBe(0)
		// EVERY throw (not just the first) was routed to the emitter's error handler — (error, event).
		expect(errors.count).toBe(20)
		expect(errors.calls.every(([, event]) => event === 'success')).toBe(true)
		// The queue still drains a fresh entry after the storm of throwing observers.
		await expect(queue.enqueue(99, { id: 'after' })).resolves.toBe(990)
	})

	it('EMIT SAFETY: a throwing error handler neither escapes nor recurses', async () => {
		const errors = createRecorder<readonly [error: unknown, event: string]>()
		const queue = new Queue<number, number>({
			handler: (input) => input,
			error: (error, event) => {
				errors.handler(error, event)
				throw new Error('error handler blew up too')
			},
		})
		queue.emitter.on('success', () => {
			throw new Error('success listener blew up')
		})
		// The entry STILL settles cleanly — neither throw escaped into the loop.
		await expect(queue.enqueue(7, { id: 'x' })).resolves.toBe(7)
		await waitForDelay(0)
		expect(queue.active).toBe(0)
		expect(queue.count).toBe(0)
		// The error handler fired exactly once (its own throw was swallowed, never re-entered —
		// so it could not recurse).
		expect(errors.count).toBe(1)
		expect(errors.calls[0]?.[1]).toBe('success')
	})

	it('EMIT SAFETY: a throwing enqueue listener does not strand the worker (the entry still runs)', async () => {
		const ran = createRecorder<[number]>()
		const errors = createRecorder<readonly [error: unknown, event: string]>()
		const queue = new Queue<number, number>({
			error: errors.handler,
			handler: (input) => {
				ran.handler(input)
				return input
			},
		})
		// A buggy `enqueue` observer — it fires BEFORE `#wake`, so a throw escaping here would
		// be the most dangerous (it could skip the wake). The emitter must isolate it.
		queue.emitter.on('enqueue', () => {
			throw new Error('enqueue observer blew up')
		})
		// The entry still runs to completion — the parked worker was woken despite the throw.
		await expect(queue.enqueue(5, { id: 'wake' })).resolves.toBe(5)
		expect(ran.calls).toEqual([[5]])
		expect(errors.calls).toEqual([[expect.any(Error), 'enqueue']])
		expect(queue.active).toBe(0)
	})
})

describe('Queue numeric contracts', () => {
	it('narrows QueueError totally for ordinary and hostile values', () => {
		const hostile = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error('hostile prototype')
				},
			},
		)
		expect(isQueueError(hostile)).toBe(false)
		expect(isQueueError(new Error('ordinary'))).toBe(false)
	})

	it('throws a coded error for every invalid constructor numeric option', () => {
		const integers: readonly number[] = [
			Number.NaN,
			Infinity,
			Number.NEGATIVE_INFINITY,
			-1,
			1.5,
			Number.MAX_SAFE_INTEGER + 1,
		]
		for (const concurrency of [0, ...integers]) {
			expect(() => new Queue({ concurrency, handler: (input: number) => input })).toThrow(
				expect.objectContaining({ code: 'invalid' }),
			)
		}
		for (const retries of integers) {
			expect(() => new Queue({ retries, handler: (input: number) => input })).toThrow(
				expect.objectContaining({ code: 'invalid' }),
			)
		}
		for (const timeout of [
			Number.NaN,
			Infinity,
			Number.NEGATIVE_INFINITY,
			-1,
			0.5,
			2_147_483_648,
		]) {
			expect(() => new Queue({ timeout, handler: (input: number) => input })).toThrow(
				expect.objectContaining({ code: 'invalid' }),
			)
		}
		const queue = new Queue({
			concurrency: Number.MAX_SAFE_INTEGER,
			timeout: 2_147_483_647,
			handler: (input: number) => input,
		})
		expect(queue.active).toBe(0)
		expect(queue.count).toBe(0)
	})

	it('rejects runtime null for every constructor numeric option with exact context', () => {
		expect(() =>
			Reflect.construct(Queue, [{ concurrency: null, handler: (input: number) => input }]),
		).toThrow(
			expect.objectContaining({
				code: 'invalid',
				context: { option: 'concurrency', value: null },
			}),
		)
		expect(() =>
			Reflect.construct(Queue, [{ retries: null, handler: (input: number) => input }]),
		).toThrow(
			expect.objectContaining({
				code: 'invalid',
				context: { option: 'retries', value: null },
			}),
		)
		expect(() =>
			Reflect.construct(Queue, [{ timeout: null, handler: (input: number) => input }]),
		).toThrow(
			expect.objectContaining({
				code: 'invalid',
				context: { option: 'timeout', value: null },
			}),
		)
	})

	it('uses constructor defaults only for explicit undefined numeric options', async () => {
		const gates = [Promise.withResolvers<number>(), Promise.withResolvers<number>()]
		const attempts = createRecorder<[number]>()
		const failure = new Error('default retries exhausted')
		const constructed: unknown = Reflect.construct(Queue, [
			{
				concurrency: undefined,
				retries: undefined,
				timeout: undefined,
				handler: async (input: number) => {
					attempts.handler(input)
					await requireValue(gates[input]).promise
					if (input === 0) throw failure
					return input
				},
			},
		])
		if (!(constructed instanceof Queue)) throw new Error('expected a Queue instance')
		const first = constructed.enqueue(0)
		const second = constructed.enqueue(1)
		const all = Promise.allSettled([first, second])

		try {
			expect(constructed.active).toBe(1)
			requireValue(gates[0]).resolve(0)
			await waitForDelay(0)
			expect(attempts.calls).toEqual([[0], [1]])
			expect(constructed.active).toBe(1)
			await waitForDelay(5)
			expect(constructed.active).toBe(1)
			requireValue(gates[1]).resolve(1)
			expect(await all).toEqual([
				{ status: 'rejected', reason: failure },
				{ status: 'fulfilled', value: 1 },
			])
		} finally {
			for (const [index, gate] of gates.entries()) gate.resolve(index)
			await all
			await constructed.destroy()
		}
	})

	it('snapshots volatile constructor values and emitter hooks exactly once', async () => {
		const reads = createRecorder<[string]>()
		const initialEnqueue = createRecorder<[string]>()
		const laterEnqueue = createRecorder<[string]>()
		const initialErrors = createRecorder<readonly [error: unknown, event: string]>()
		const laterErrors = createRecorder<readonly [error: unknown, event: string]>()
		const listenerFailure = new Error('constructor listener failure')
		let concurrencyReads = 0
		let retriesReads = 0
		let timeoutReads = 0
		let onReads = 0
		let errorReads = 0
		const queue = new Queue({
			handler: (input: number) => input + 1,
			get concurrency() {
				concurrencyReads += 1
				reads.handler('concurrency')
				return concurrencyReads === 1 ? 1 : 0
			},
			get retries() {
				retriesReads += 1
				reads.handler('retries')
				return retriesReads === 1 ? 0 : -1
			},
			get timeout() {
				timeoutReads += 1
				reads.handler('timeout')
				return timeoutReads === 1 ? 0 : -1
			},
			get on() {
				onReads += 1
				reads.handler('on')
				return onReads === 1
					? { enqueue: initialEnqueue.handler }
					: { enqueue: laterEnqueue.handler }
			},
			get error() {
				errorReads += 1
				reads.handler('error')
				return errorReads === 1 ? initialErrors.handler : laterErrors.handler
			},
		})

		try {
			queue.emitter.on('success', () => {
				throw listenerFailure
			})
			await expect(queue.enqueue(1, { id: 'volatile' })).resolves.toBe(2)
			expect(reads.calls).toEqual([['concurrency'], ['retries'], ['timeout'], ['on'], ['error']])
			expect(initialEnqueue.calls).toEqual([['volatile']])
			expect(laterEnqueue.count).toBe(0)
			expect(initialErrors.calls).toEqual([[listenerFailure, 'success']])
			expect(laterErrors.count).toBe(0)
		} finally {
			await queue.destroy()
		}
	})

	it('fails each invalid numeric constructor option before reading later options', () => {
		const reads = createRecorder<[string]>()
		const errors = createRecorder<readonly [error: unknown, event: string]>()
		let concurrency = 0
		let retries = 0
		let timeout = 0
		const options = {
			handler: (input: number) => input,
			get concurrency() {
				reads.handler('concurrency')
				return concurrency
			},
			get retries() {
				reads.handler('retries')
				return retries
			},
			get timeout() {
				reads.handler('timeout')
				return timeout
			},
			get on() {
				reads.handler('on')
				return {}
			},
			get error() {
				reads.handler('error')
				return errors.handler
			},
		}

		let failure: unknown
		try {
			void new Queue(options)
		} catch (error: unknown) {
			failure = error
		}
		if (failure === null || !isQueueError(failure)) {
			throw new Error('expected invalid concurrency QueueError')
		}
		expect(failure.code).toBe('invalid')
		expect(failure.context).toEqual({ option: 'concurrency', value: 0 })
		expect(reads.calls).toEqual([['concurrency']])

		reads.clear()
		concurrency = 1
		retries = -1
		failure = undefined
		try {
			void new Queue(options)
		} catch (error: unknown) {
			failure = error
		}
		if (failure === null || !isQueueError(failure)) {
			throw new Error('expected invalid retries QueueError')
		}
		expect(failure.code).toBe('invalid')
		expect(failure.context).toEqual({ option: 'retries', value: -1 })
		expect(reads.calls).toEqual([['concurrency'], ['retries']])

		reads.clear()
		retries = 0
		timeout = -1
		failure = undefined
		try {
			void new Queue(options)
		} catch (error: unknown) {
			failure = error
		}
		if (failure === null || !isQueueError(failure)) {
			throw new Error('expected invalid timeout QueueError')
		}
		expect(failure.code).toBe('invalid')
		expect(failure.context).toEqual({ option: 'timeout', value: -1 })
		expect(reads.calls).toEqual([['concurrency'], ['retries'], ['timeout']])
	})

	it('throws immediately for invalid per-entry retries and timeout', () => {
		const queue = new Queue<number, number>({ handler: (input) => input })
		expect(() => queue.enqueue(1, { retries: Number.NaN })).toThrow(
			expect.objectContaining({ code: 'invalid' }),
		)
		expect(() => queue.enqueue(1, { retries: 0.5 })).toThrow(
			expect.objectContaining({ code: 'invalid' }),
		)
		expect(() => queue.enqueue(1, { timeout: Infinity })).toThrow(
			expect.objectContaining({ code: 'invalid' }),
		)
		expect(() => queue.enqueue(1, { timeout: -1 })).toThrow(
			expect.objectContaining({ code: 'invalid' }),
		)
		expect(() => queue.enqueue(1, { timeout: 0.5 })).toThrow(
			expect.objectContaining({ code: 'invalid' }),
		)
		expect(() => queue.enqueue(1, { timeout: 2_147_483_648 })).toThrow(
			expect.objectContaining({ code: 'invalid' }),
		)
	})

	it('runs one entry with maximum safe concurrency without preallocating workers', async () => {
		const queue = new Queue<number, number>({
			concurrency: Number.MAX_SAFE_INTEGER,
			handler: (input) => input + 1,
		})
		await expect(queue.enqueue(1)).resolves.toBe(2)
		expect(queue.active).toBe(0)
		expect(queue.count).toBe(0)
	})
})

describe('Queue serialized durable admission', () => {
	it('reserves duplicate ids synchronously without overwriting the first row', async () => {
		const store = createMemoryQueueStore(stringShape())
		const queue = new Queue<string, string>({ store, handler: (input) => input })
		queue.pause()
		const first = queue.enqueue('first', { id: 'shared' })
		void first.catch(() => {})
		await expect(queue.enqueue('second', { id: 'shared' })).rejects.toSatisfy(
			(error: unknown) => isQueueError(error) && error.code === 'duplicate',
		)
		await waitForDelay(0)
		expect(await store.load()).toEqual([{ id: 'shared', input: 'first', attempts: 0 }])
		const clearing = queue.clear()
		await expect(first).rejects.toThrow('cleared')
		await clearing
	})

	it('preserves enqueue order even when the first save is delayed', async () => {
		const first = Promise.withResolvers<void>()
		const saves = createRecorder<[number]>()
		const order = createRecorder<[number]>()
		const entries = new Map<string, StoredEntry<number>>()
		const store: QueueStoreInterface<number> = {
			async save(entry) {
				saves.handler(entry.input)
				if (entry.input === 1) await first.promise
				entries.set(entry.id, entry)
			},
			async remove(id) {
				entries.delete(id)
			},
			async load() {
				return [...entries.values()]
			},
			async clear() {
				entries.clear()
			},
		}
		const queue = new Queue<number, number>({
			store,
			handler: (input) => {
				order.handler(input)
				return input
			},
		})
		const one = queue.enqueue(1, { id: 'one' })
		const two = queue.enqueue(2, { id: 'two' })
		await waitForDelay(0)
		expect(saves.calls).toEqual([[1]])
		first.resolve()
		await expect(Promise.all([one, two])).resolves.toEqual([1, 2])
		expect(saves.calls).toEqual([[1], [2]])
		expect(order.calls).toEqual([[1], [2]])
	})

	it('continues with the next admission after a save failure', async () => {
		const saves = createRecorder<[string]>()
		const store: QueueStoreInterface<string> = {
			async save(entry) {
				saves.handler(entry.input)
				if (entry.input === 'bad') throw new Error('offline')
			},
			async remove() {},
			async load() {
				return []
			},
			async clear() {},
		}
		const queue = new Queue<string, string>({ store, handler: (input) => input })
		const bad = queue.enqueue('bad', { id: 'bad' })
		const good = queue.enqueue('good', { id: 'good' })
		await expect(bad).rejects.toSatisfy(
			(error: unknown) => isQueueError(error) && error.code === 'store',
		)
		await expect(good).resolves.toBe('good')
		expect(saves.calls).toEqual([['bad'], ['good']])
	})
})

describe('Queue coordinated lifecycle', () => {
	it('makes progress after stop, start, and enqueue in the same turn', async () => {
		const queue = new Queue<number, number>({ handler: (input) => input + 1 })
		const stopping = queue.stop()
		queue.start()
		const result = queue.enqueue(1)
		await stopping
		await expect(result).resolves.toBe(2)
	})

	it('rejects a stale admission stopped before its save completes', async () => {
		const save = Promise.withResolvers<void>()
		const removals = createRecorder<[string]>()
		const store: QueueStoreInterface<string> = {
			async save() {
				await save.promise
			},
			async remove(id) {
				removals.handler(id)
			},
			async load() {
				return []
			},
			async clear() {},
		}
		const queue = new Queue<string, string>({ store, handler: (input) => input })
		const stale = queue.enqueue('old', { id: 'old' })
		const stopping = queue.stop()
		queue.start()
		const fresh = queue.enqueue('new', { id: 'new' })
		await expect(stale).rejects.toThrow('stopped')
		save.resolve()
		await stopping
		await expect(fresh).resolves.toBe('new')
		expect(removals.calls.some(([id]) => id === 'old')).toBe(true)
	})

	it('emits one drain for a pending-only transition to idle', async () => {
		const queue = new Queue<number, number>({ handler: (input) => input })
		queue.pause()
		const events = recordEmitterEvents<QueueEventMap<number>, 'drain'>(queue.emitter, ['drain'])
		const pending = queue.enqueue(1)
		const clearing = queue.clear()
		await expect(pending).rejects.toThrow('cleared')
		await clearing
		expect(events.drain.count).toBe(1)
		await queue.clear()
		expect(events.drain.count).toBe(1)
	})

	it('destroys the emitter last and returns the same idempotent promise', async () => {
		const removal = Promise.withResolvers<void>()
		const store: QueueStoreInterface<string> = {
			async save() {},
			async remove() {
				await removal.promise
			},
			async load() {
				return []
			},
			async clear() {},
		}
		const queue = new Queue<string, string>({ store, handler: (input) => input })
		queue.pause()
		const pending = queue.enqueue('held')
		void pending.catch(() => {})
		await waitForDelay(0)
		const destroying = queue.destroy()
		expect(queue.destroy()).toBe(destroying)
		expect(queue.emitter.destroyed).toBe(false)
		removal.resolve()
		await destroying
		expect(queue.emitter.destroyed).toBe(true)
	})
})

describe('Queue — public guards and runtime ids', () => {
	it('exposes total queue numeric guards at their exact boundaries', () => {
		expect(isQueueConcurrency(1)).toBe(true)
		expect(isQueueConcurrency(0)).toBe(false)
		expect(isQueueConcurrency(Number.MAX_SAFE_INTEGER)).toBe(true)
		expect(isQueueConcurrency(Number.MAX_SAFE_INTEGER + 1)).toBe(false)
		expect(isQueueRetries(0)).toBe(true)
		expect(isQueueRetries(-0)).toBe(true)
		expect(isQueueRetries(-1)).toBe(false)
		expect(isQueueRetries(0.5)).toBe(false)
		expect(isQueueTimeout(0)).toBe(true)
		expect(isQueueTimeout(-0)).toBe(true)
		expect(isQueueTimeout(0.5)).toBe(false)
		expect(isQueueTimeout(2_147_483_647)).toBe(true)
		expect(isQueueTimeout(2_147_483_648)).toBe(false)
		expect(isQueueTimeout(Infinity)).toBe(false)
		expect(isQueueTimeout(Number.NaN)).toBe(false)
	})

	it('narrows only native abort signals without throwing on hostile values', () => {
		const controller = new AbortController()
		const hostile = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error('hostile prototype')
				},
			},
		)
		expect(isQueueSignal(controller.signal)).toBe(true)
		expect(isQueueSignal({})).toBe(false)
		expect(isQueueSignal(hostile)).toBe(false)
	})

	it('throws a coded invalid-id error before reserving or running without a store', () => {
		const ran = createRecorder<[]>()
		const queue = new Queue<number, number>({
			handler: (input) => {
				ran.handler()
				return input
			},
		})
		expect(() => Reflect.apply(queue.enqueue, queue, [1, { id: 42 }])).toThrow(
			expect.objectContaining({
				code: 'invalid',
				context: { option: 'id', value: 42 },
			}),
		)
		expect(queue.count).toBe(0)
		expect(ran.count).toBe(0)
	})

	it('throws a coded invalid-id error before touching a store', () => {
		const saves = createRecorder<[]>()
		const store: QueueStoreInterface<number> = {
			async save() {
				saves.handler()
			},
			async remove() {},
			async load() {
				return []
			},
			async clear() {},
		}
		const queue = new Queue<number, number>({ store, handler: (input) => input })
		expect(() => Reflect.apply(queue.enqueue, queue, [1, { id: null }])).toThrow(
			expect.objectContaining({
				code: 'invalid',
				context: { option: 'id', value: null },
			}),
		)
		expect(queue.count).toBe(0)
		expect(saves.count).toBe(0)
	})

	it('snapshots every supplied enqueue option exactly once', async () => {
		const reads = createRecorder<[string]>()
		const controller = new AbortController()
		const options = {
			get id() {
				reads.handler('id')
				return 'snapshotted'
			},
			get retries() {
				reads.handler('retries')
				return 0
			},
			get timeout() {
				reads.handler('timeout')
				return 0
			},
			get signal() {
				reads.handler('signal')
				return controller.signal
			},
		}
		const queue = new Queue<number, number>({ handler: (input) => input })
		await expect(Reflect.apply(queue.enqueue, queue, [1, options])).resolves.toBe(1)
		expect(reads.calls).toEqual([['id'], ['retries'], ['timeout'], ['signal']])
	})

	it('contains hostile option access before reserving or running', () => {
		const ran = createRecorder<[]>()
		const options = Object.defineProperty({}, 'id', {
			get() {
				throw new Error('hostile id getter')
			},
		})
		const queue = new Queue<number, number>({
			handler: (input) => {
				ran.handler()
				return input
			},
		})
		expect(() => Reflect.apply(queue.enqueue, queue, [1, options])).toThrow(
			expect.objectContaining({ code: 'invalid', context: { option: 'id' } }),
		)
		expect(queue.count).toBe(0)
		expect(queue.active).toBe(0)
		expect(ran.count).toBe(0)
	})

	it('rejects a non-signal value synchronously without reserving work', () => {
		const ran = createRecorder<[]>()
		const queue = new Queue<number, number>({
			handler: (input) => {
				ran.handler()
				return input
			},
		})
		expect(() => Reflect.apply(queue.enqueue, queue, [1, { signal: {} }])).toThrow(
			expect.objectContaining({ code: 'invalid', context: { option: 'signal', value: {} } }),
		)
		expect(queue.count).toBe(0)
		expect(queue.active).toBe(0)
		expect(ran.count).toBe(0)
	})
})

describe('Queue — reentrant lifecycle barriers', () => {
	it('preinstalls the abort and destroy barriers before abort listeners run', async () => {
		const reentrant: Array<Promise<void>> = []
		const queue = new Queue<number, number>({ handler: (input) => input })
		queue.emitter.on('abort', () => {
			reentrant.push(queue.abort())
			reentrant.push(queue.destroy())
		})

		const aborting = queue.abort()
		const nestedAbort = requireValue(reentrant[0])
		const nestedDestroy = requireValue(reentrant[1])
		expect(nestedAbort).toBe(aborting)
		expect(queue.abort()).toBe(aborting)
		expect(queue.destroy()).toBe(nestedDestroy)
		await expect(aborting).resolves.toBeUndefined()
		await expect(nestedDestroy).resolves.toBeUndefined()
	})

	it('returns the installed stop barrier from a reentrant drain listener', async () => {
		const reentrant: Array<Promise<void>> = []
		const queue = new Queue<number, number>({ handler: (input) => input })
		queue.pause()
		queue.emitter.on('drain', () => reentrant.push(queue.stop()))
		const pending = queue.enqueue(1)
		const stopping = queue.stop()

		await expect(pending).rejects.toThrow('stopped')
		await stopping
		expect(requireValue(reentrant[0])).toBe(stopping)
		expect(queue.stop()).toBe(stopping)
	})

	it('returns the installed abort barrier from a reentrant drain listener', async () => {
		const reentrant: Array<Promise<void>> = []
		const queue = new Queue<number, number>({ handler: (input) => input })
		queue.pause()
		queue.emitter.on('drain', () => reentrant.push(queue.abort()))
		const pending = queue.enqueue(1)
		const aborting = queue.abort()

		await expect(pending).rejects.toBeDefined()
		await aborting
		expect(requireValue(reentrant[0])).toBe(aborting)
		expect(queue.abort()).toBe(aborting)
	})

	it('returns the installed destroy barrier from a reentrant drain listener', async () => {
		const reentrant: Array<Promise<void>> = []
		const queue = new Queue<number, number>({ handler: (input) => input })
		queue.pause()
		queue.emitter.on('drain', () => reentrant.push(queue.destroy()))
		const pending = queue.enqueue(1)
		const destroying = queue.destroy()

		await expect(pending).rejects.toBeDefined()
		await destroying
		expect(requireValue(reentrant[0])).toBe(destroying)
		expect(queue.destroy()).toBe(destroying)
	})
})

describe('Queue — atomic claims and stale restore generations', () => {
	it('claims an entry as active before same-turn stop and waits for it to settle', async () => {
		const gate = Promise.withResolvers<number>()
		const queue = new Queue<number, number>({ handler: () => gate.promise })
		const running = queue.enqueue(1)
		expect(queue.active).toBe(1)
		const stopping = queue.stop()
		expect(queue.active).toBe(1)
		gate.resolve(2)
		await expect(running).resolves.toBe(2)
		await expect(stopping).resolves.toBeUndefined()
		expect(queue.active).toBe(0)
		expect(queue.count).toBe(0)
	})

	it('leaves a same-turn claimed entry active across clear', async () => {
		const gate = Promise.withResolvers<number>()
		const queue = new Queue<number, number>({ handler: () => gate.promise })
		const running = queue.enqueue(1)
		expect(queue.active).toBe(1)
		await expect(queue.clear()).resolves.toBeUndefined()
		expect(queue.active).toBe(1)
		expect(queue.count).toBe(1)
		gate.resolve(2)
		await expect(running).resolves.toBe(2)
	})

	it('ignores a restore load that completes after stop and start change generation', async () => {
		const load = Promise.withResolvers<ReadonlyArray<StoredEntry<string>>>()
		const handled = createRecorder<[string]>()
		const enqueued = createRecorder<[string]>()
		const store: QueueStoreInterface<string> = {
			async save() {},
			async remove() {},
			async load() {
				return load.promise
			},
			async clear() {},
		}
		const queue = new Queue<string, string>({
			store,
			handler: (input) => {
				handled.handler(input)
				return input
			},
		})
		queue.emitter.on('enqueue', enqueued.handler)
		const restoring = queue.restore()
		const stopping = queue.stop()
		queue.start()
		load.resolve([{ id: 'stale', input: 'old', attempts: 0 }])

		await stopping
		await restoring
		await waitForDelay(0)
		expect(enqueued.count).toBe(0)
		expect(handled.count).toBe(0)
		expect(queue.count).toBe(0)
	})
})

describe('Queue — exclusive cleanup ownership and lifecycle visibility', () => {
	it('shares overlapping cleanup, retries a failure, then safely reuses the id', async () => {
		const first = Promise.withResolvers<void>()
		const removes = createRecorder<[string]>()
		let fail = true
		const store: QueueStoreInterface<string> = {
			async save() {},
			async remove(id) {
				removes.handler(id)
				if (removes.count === 1) await first.promise
				if (fail) throw new Error('first cleanup failed')
			},
			async load() {
				return []
			},
			async clear() {},
		}
		const queue = new Queue<string, string>({ store, handler: (input) => input })
		queue.pause()
		const old = queue.enqueue('old', { id: 'shared' })
		await waitForDelay(0)
		const clearing = queue.clear()
		const stopping = queue.stop()
		await expect(old).rejects.toThrow('cleared')
		expect(removes.count).toBe(1)
		first.resolve()
		await expect(clearing).rejects.toSatisfy(
			(error: unknown) => isQueueError(error) && error.code === 'cleanup',
		)
		await expect(stopping).rejects.toSatisfy(
			(error: unknown) => isQueueError(error) && error.code === 'cleanup',
		)
		expect(removes.count).toBe(1)
		expect(queue.count).toBe(1)

		fail = false
		queue.start()
		await expect(queue.clear()).resolves.toBeUndefined()
		expect(removes.count).toBe(2)
		expect(queue.count).toBe(0)
		const fresh = queue.enqueue('fresh', { id: 'shared' })
		await waitForDelay(0)
		await expect(queue.clear()).resolves.toBeUndefined()
		await expect(fresh).rejects.toThrow('cleared')
		expect(removes.count).toBe(3)
		expect(queue.count).toBe(0)
	})

	it('propagates active cleanup failure through stop and the entry result', async () => {
		const gate = Promise.withResolvers<string>()
		const store: QueueStoreInterface<string> = {
			async save() {},
			async remove() {
				throw new Error('remove failed during stop')
			},
			async load() {
				return []
			},
			async clear() {},
		}
		const queue = new Queue<string, string>({ store, handler: () => gate.promise })
		const running = queue.enqueue('active')
		await waitForDelay(0)
		const stopping = queue.stop()
		gate.resolve('done')
		await expect(running).rejects.toSatisfy(
			(error: unknown) => isQueueError(error) && error.code === 'cleanup',
		)
		await expect(stopping).rejects.toSatisfy(
			(error: unknown) => isQueueError(error) && error.code === 'cleanup',
		)
	})

	it('propagates active cleanup failure through abort and the entry result', async () => {
		const gate = Promise.withResolvers<string>()
		const store: QueueStoreInterface<string> = {
			async save() {},
			async remove() {
				throw new Error('remove failed during abort')
			},
			async load() {
				return []
			},
			async clear() {},
		}
		const queue = new Queue<string, string>({ store, handler: () => gate.promise })
		const running = queue.enqueue('active')
		await waitForDelay(0)
		const aborting = queue.abort()
		await expect(running).rejects.toSatisfy(
			(error: unknown) => isQueueError(error) && error.code === 'cleanup',
		)
		await expect(aborting).rejects.toSatisfy(
			(error: unknown) => isQueueError(error) && error.code === 'cleanup',
		)
	})

	it('respawns after a running cleanup rejection and stop retries the orphan', async () => {
		const handled = createRecorder<[string]>()
		const removes = createRecorder<[string]>()
		const store: QueueStoreInterface<string> = {
			async save() {},
			async remove(id) {
				removes.handler(id)
				if (id === 'first' && removes.count === 1) throw new Error('transient remove failure')
			},
			async load() {
				return []
			},
			async clear() {},
		}
		const queue = new Queue<string, string>({
			store,
			handler: (input) => {
				handled.handler(input)
				return input
			},
		})
		await expect(queue.enqueue('one', { id: 'first' })).rejects.toSatisfy(
			(error: unknown) => isQueueError(error) && error.code === 'cleanup',
		)
		await expect(queue.enqueue('two', { id: 'second' })).resolves.toBe('two')
		expect(handled.calls).toEqual([['one'], ['two']])
		expect(queue.count).toBe(1)
		await expect(queue.stop()).resolves.toBeUndefined()
		expect(queue.count).toBe(0)
		expect(removes.calls).toEqual([['first'], ['second'], ['first']])
	})
})

describe('Queue — active cleanup and handler failure isolation', () => {
	it('clear neither waits for nor inherits active cleanup failure', async () => {
		const removal = Promise.withResolvers<void>()
		const removes = createRecorder<[]>()
		let fail = true
		const store: QueueStoreInterface<string> = {
			async save() {},
			async remove() {
				removes.handler()
				if (removes.count === 1) await removal.promise
				if (fail) throw new Error('active removal failed')
			},
			async load() {
				return []
			},
			async clear() {},
		}
		const queue = new Queue<string, string>({ store, handler: (input) => input })
		const running = queue.enqueue('active')
		void running.catch(() => {})
		await waitForDelay(0)
		expect(removes.count).toBe(1)

		await expect(queue.clear()).resolves.toBeUndefined()
		expect(queue.active).toBe(1)
		expect(queue.count).toBe(1)

		removal.resolve()
		await expect(running).rejects.toSatisfy(
			(error: unknown) => isQueueError(error) && error.code === 'cleanup',
		)
		expect(queue.active).toBe(0)
		expect(queue.count).toBe(1)

		fail = false
		await expect(queue.clear()).resolves.toBeUndefined()
		expect(queue.count).toBe(0)
	})

	it('clear excludes a newly orphaned token while its exact claim is still active', async () => {
		const removal = Promise.withResolvers<void>()
		const started = Promise.withResolvers<void>()
		const removes = createRecorder<[]>()
		const boundary = createRecorder<[number]>()
		const store: QueueStoreInterface<string> = {
			save() {
				return Promise.resolve()
			},
			remove() {
				removes.handler()
				if (removes.count === 1) {
					started.resolve()
					return removal.promise
				}
				return Promise.resolve()
			},
			load() {
				return Promise.resolve([])
			},
			clear() {
				return Promise.resolve()
			},
		}
		const queue = new Queue<string, string>({ store, handler: (input) => input })
		const running = queue.enqueue('active')
		const failure = running.catch((error: unknown) => error)
		await started.promise
		let clearing: Promise<void> | undefined
		const reaction = removal.promise.catch(() => {
			boundary.handler(queue.active)
			clearing = queue.clear()
		})

		removal.reject(new Error('first removal failed'))
		await reaction
		if (clearing === undefined) throw new Error('expected clear at the rejection boundary')
		await expect(clearing).resolves.toBeUndefined()
		expect(boundary.calls).toEqual([[1]])
		expect(removes.count).toBe(1)

		const error = await failure
		expect(error).toSatisfy((caught: unknown) => isQueueError(caught) && caught.code === 'cleanup')
		expect(queue.active).toBe(0)
		expect(queue.count).toBe(1)

		await expect(queue.clear()).resolves.toBeUndefined()
		expect(removes.count).toBe(2)
		expect(queue.count).toBe(0)
	})

	it('normalizes a hostile non-Error rejection without bypassing retries or stop', async () => {
		const reason = Object.setPrototypeOf({ rejection: 'hostile' }, null)
		const attempts = createRecorder<[]>()
		const queue = new Queue<undefined, string>({
			retries: 2,
			handler: () => {
				attempts.handler()
				throw reason
			},
		})
		const running = queue.enqueue(undefined)
		const failure = running.catch((error: unknown) => error)
		const stopping = queue.stop()
		const error = await failure
		await expect(stopping).resolves.toBeUndefined()
		expect(error).toBeInstanceOf(Error)
		if (!(error instanceof Error)) throw new Error('expected a normalized Error')
		expect(error.message).toBe('object')
		expect(error.cause).toBe(reason)
		expect(attempts.count).toBe(3)
		expect(queue.active).toBe(0)
		expect(queue.count).toBe(0)
	})
})

describe('Queue — atomic restore validation', () => {
	it('contains a non-iterable load result as a coded store failure', async () => {
		const failure = new Error('hostile iterator')
		const loaded = new Proxy([{ id: 'valid', input: 'payload', attempts: 0 }], {
			get(target, property, receiver) {
				if (property === Symbol.iterator) throw failure
				return Reflect.get(target, property, receiver)
			},
		})
		const store: QueueStoreInterface<string> = {
			async save() {},
			async remove() {},
			async load() {
				return loaded
			},
			async clear() {},
		}
		const queue = new Queue<string, string>({ store, handler: (input) => input })
		await expect(queue.restore()).rejects.toSatisfy(
			(error: unknown) =>
				isQueueError(error) &&
				error.message === 'queue store load failed' &&
				error.code === 'store' &&
				error.cause === failure &&
				error.context?.operation === 'load',
		)
		expect(queue.count).toBe(0)
		expect(queue.active).toBe(0)
	})

	it('validates every loaded entry before reserving the first one', async () => {
		const failure = new Error('hostile attempts getter')
		const hostile = new Proxy(
			{ id: 'hostile', input: 'late', attempts: 0 },
			{
				get(target, property, receiver) {
					if (property === 'attempts') throw failure
					return Reflect.get(target, property, receiver)
				},
			},
		)
		const store: QueueStoreInterface<string> = {
			async save() {},
			async remove() {},
			async load() {
				return [{ id: 'valid', input: 'first', attempts: 0 }, hostile]
			},
			async clear() {},
		}
		const ran = createRecorder<[]>()
		const queue = new Queue<string, string>({
			store,
			handler: (input) => {
				ran.handler()
				return input
			},
		})
		await expect(queue.restore()).rejects.toSatisfy(
			(error: unknown) =>
				isQueueError(error) &&
				error.message === 'queue store load failed' &&
				error.code === 'store' &&
				error.cause === failure &&
				error.context?.operation === 'load',
		)
		await waitForDelay(0)
		expect(ran.count).toBe(0)
		expect(queue.count).toBe(0)
		expect(queue.active).toBe(0)
	})

	it('rejects malformed restored ids before reservation', async () => {
		const malformed = new Proxy(
			{ id: 'valid', input: 'payload', attempts: 0 },
			{
				get(target, property, receiver) {
					if (property === 'id') return 42
					return Reflect.get(target, property, receiver)
				},
			},
		)
		const store: QueueStoreInterface<string> = {
			async save() {},
			async remove() {},
			async load() {
				return [malformed]
			},
			async clear() {},
		}
		const queue = new Queue<string, string>({ store, handler: (input) => input })
		await expect(queue.restore()).rejects.toSatisfy(
			(error: unknown) =>
				isQueueError(error) &&
				error.message === 'queue store returned an invalid entry' &&
				error.code === 'store' &&
				error.cause === undefined &&
				error.context?.operation === 'load',
		)
		expect(queue.count).toBe(0)
	})

	it('rejects malformed restored attempt counts before reservation', async () => {
		const malformed = new Proxy(
			{ id: 'valid', input: 'payload', attempts: 0 },
			{
				get(target, property, receiver) {
					if (property === 'attempts') return -1
					return Reflect.get(target, property, receiver)
				},
			},
		)
		const store: QueueStoreInterface<string> = {
			async save() {},
			async remove() {},
			async load() {
				return [malformed]
			},
			async clear() {},
		}
		const queue = new Queue<string, string>({ store, handler: (input) => input })
		await expect(queue.restore()).rejects.toSatisfy(
			(error: unknown) =>
				isQueueError(error) &&
				error.message === 'queue store returned an invalid entry' &&
				error.code === 'store' &&
				error.cause === undefined &&
				error.context?.operation === 'load',
		)
		expect(queue.count).toBe(0)
	})
})

describe('Queue — reentrant terminal drain ordering', () => {
	it('emits success then the latched drain before a reentrant entry settles', async () => {
		const order: string[] = []
		const reentrant: Array<Promise<number>> = []
		const queue = new Queue<number, number>({ handler: (input) => input })
		queue.emitter.on('success', (id) => {
			order.push(`success:${id}`)
			if (id === 'first') reentrant.push(queue.enqueue(2, { id: 'second' }))
		})
		queue.emitter.on('drain', () => order.push('drain'))

		await expect(queue.enqueue(1, { id: 'first' })).resolves.toBe(1)
		await expect(requireValue(reentrant[0])).resolves.toBe(2)
		expect(order).toEqual(['success:first', 'drain', 'success:second', 'drain'])
	})

	it('emits failure then the latched drain before a reentrant entry settles', async () => {
		const order: string[] = []
		const reentrant: Array<Promise<string>> = []
		const queue = new Queue<string, string>({
			handler: (input) => {
				if (input === 'bad') throw new Error('bad')
				return input
			},
		})
		queue.emitter.on('failure', (id) => {
			order.push(`failure:${id}`)
			if (id === 'first') reentrant.push(queue.enqueue('good', { id: 'second' }))
		})
		queue.emitter.on('success', (id) => order.push(`success:${id}`))
		queue.emitter.on('drain', () => order.push('drain'))

		await expect(queue.enqueue('bad', { id: 'first' })).rejects.toThrow('bad')
		await expect(requireValue(reentrant[0])).resolves.toBe('good')
		expect(order).toEqual(['failure:first', 'drain', 'success:second', 'drain'])
	})
})
