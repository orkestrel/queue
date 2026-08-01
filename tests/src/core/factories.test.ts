import { describe, expect, it } from 'vitest'
import { stringShape } from '@orkestrel/contract'
import { createMemoryDriver } from '@orkestrel/database'
import {
	createDatabaseQueueStore,
	createMemoryQueueStore,
	createQueue,
	DatabaseQueueStore,
	MemoryQueueStore,
	Queue,
} from '@src/core'

// src/core/factories.ts — each factory constructs its corresponding concrete queue entity.
// Behavioral contracts remain in each entity's canonical suite.

describe('createQueue', () => {
	it('constructs the concrete Queue entity', async () => {
		const queue = createQueue<number, number>({ handler: (input) => input + 1 })
		expect(queue).toBeInstanceOf(Queue)
		await queue.destroy()
	})
})

describe('createDatabaseQueueStore', () => {
	it('constructs the concrete DatabaseQueueStore entity', () => {
		const store = createDatabaseQueueStore(stringShape(), createMemoryDriver())
		expect(store).toBeInstanceOf(DatabaseQueueStore)
	})
})

describe('createMemoryQueueStore', () => {
	it('constructs the concrete MemoryQueueStore entity', () => {
		const store = createMemoryQueueStore(stringShape())
		expect(store).toBeInstanceOf(MemoryQueueStore)
	})
})
