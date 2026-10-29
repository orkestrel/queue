import { describe, expect, it } from 'vitest'
import { isQueueError, QueueError } from '@src/core'
import { createCallableQueueContext, QueueContextFixture } from '../../setup.js'

describe('queue error context types', () => {
	it('accepts a class-instance context', () => {
		const error = new QueueError('failure', { code: 'invalid' })
		Object.defineProperty(error, 'context', { value: new QueueContextFixture() })
		expect(isQueueError(error)).toBe(true)
	})

	it('accepts a callable context', () => {
		const error = new QueueError('failure', { code: 'invalid' })
		Object.defineProperty(error, 'context', { value: createCallableQueueContext() })
		expect(isQueueError(error)).toBe(true)
	})
})
