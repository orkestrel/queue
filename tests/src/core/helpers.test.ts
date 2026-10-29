import { describe, expect, it } from 'vitest'
import { isString } from '@orkestrel/contract'
import { captureError } from '@orkestrel/test'
import { isQueueConcurrency, isQueueError, readOption, validateOption } from '@src/core'

// src/core/helpers.ts — the two option leaves the constructor and `enqueue` share.
// `readOption` owns the read boundary; `validateOption` owns the guard boundary.

describe('readOption', () => {
	it('returns the value a supplied option holds', () => {
		expect(readOption({ retries: 2 }, 'retries', 'queue retries could not be read')).toBe(2)
	})

	it('returns undefined for an absent options object', () => {
		expect(readOption(undefined, 'id', 'queue entry id could not be read')).toBeUndefined()
	})

	it('returns undefined for an omitted option', () => {
		expect(readOption({}, 'timeout', 'queue timeout could not be read')).toBeUndefined()
	})

	it('reads the property exactly once', () => {
		const reads: string[] = []
		const options = Object.defineProperty({}, 'id', {
			get() {
				reads.push('id')
				return 'job-1'
			},
		})
		expect(readOption(options, 'id', 'queue entry id could not be read')).toBe('job-1')
		expect(reads).toEqual(['id'])
	})

	it('contains a throwing getter as a coded invalid failure carrying its cause', () => {
		const cause = new Error('hostile id getter')
		const options = Object.defineProperty({}, 'id', {
			get() {
				throw cause
			},
		})
		const failure = captureError(() =>
			readOption(options, 'id', 'queue entry id could not be read'),
		)
		if (!isQueueError(failure)) throw new Error('expected a QueueError')
		expect(failure.message).toBe('queue entry id could not be read')
		expect(failure.code).toBe('invalid')
		expect(failure.context).toEqual({ option: 'id' })
		expect(failure.cause).toBe(cause)
	})
})

describe('validateOption', () => {
	it('returns the value its guard accepts, narrowed', () => {
		const concurrency: number = validateOption(
			4,
			isQueueConcurrency,
			'concurrency',
			'queue concurrency must be a positive safe integer',
		)
		expect(concurrency).toBe(4)
	})

	it('throws a coded invalid failure carrying the option and the refused value', () => {
		const failure = captureError(() =>
			validateOption(0, isQueueConcurrency, 'concurrency', 'queue concurrency must be positive'),
		)
		if (!isQueueError(failure)) throw new Error('expected a QueueError')
		expect(failure.message).toBe('queue concurrency must be positive')
		expect(failure.code).toBe('invalid')
		expect(failure.context).toEqual({ option: 'concurrency', value: 0 })
	})

	it('refuses undefined rather than treating absence as valid', () => {
		const failure = captureError(() =>
			validateOption(undefined, isString, 'id', 'queue entry id must be a string'),
		)
		if (!isQueueError(failure)) throw new Error('expected a QueueError')
		expect(failure.code).toBe('invalid')
		expect(failure.context?.option).toBe('id')
	})

	it('reports a hostile refused value without dereferencing it', () => {
		const hostile = Object.defineProperty({}, 'toString', {
			get() {
				throw new Error('hostile toString getter')
			},
		})
		const failure = captureError(() =>
			validateOption(hostile, isString, 'id', 'queue entry id must be a string'),
		)
		if (!isQueueError(failure)) throw new Error('expected a QueueError')
		expect(failure.context?.value).toBe(hostile)
	})
})
