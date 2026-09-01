import { describe, expect, it } from 'vitest'
import { isStoredEntry } from '@src/core'

// src/core/validators.ts — `isStoredEntry` is the single test for what a `StoredEntry`
// is, shared by `Queue.restore` and `MemoryQueueStore.save`. The three numeric guards
// are exercised through the queue's own boundary suite.

describe('isStoredEntry', () => {
	it('accepts a well-formed entry', () => {
		expect(isStoredEntry({ id: 'job-1', input: 'task', attempts: 0 })).toBe(true)
	})

	it('accepts an undefined input, which the entry type admits', () => {
		expect(isStoredEntry({ id: 'job-1', input: undefined, attempts: 3 })).toBe(true)
	})

	it('accepts an entry carrying a member the type does not declare', () => {
		expect(isStoredEntry({ id: 'job-1', input: 'task', attempts: 0, extra: true })).toBe(true)
	})

	it('refuses a non-string id', () => {
		expect(isStoredEntry({ id: 1, input: 'task', attempts: 0 })).toBe(false)
	})

	it('refuses a missing input member', () => {
		expect(isStoredEntry({ id: 'job-1', attempts: 0 })).toBe(false)
	})

	it('refuses a negative, fractional, or non-numeric attempt count', () => {
		expect(isStoredEntry({ id: 'job-1', input: 'task', attempts: -1 })).toBe(false)
		expect(isStoredEntry({ id: 'job-1', input: 'task', attempts: 0.5 })).toBe(false)
		expect(isStoredEntry({ id: 'job-1', input: 'task', attempts: Number.NaN })).toBe(false)
		expect(isStoredEntry({ id: 'job-1', input: 'task', attempts: '0' })).toBe(false)
	})

	it('refuses a value that is not a plain record', () => {
		expect(isStoredEntry(null)).toBe(false)
		expect(isStoredEntry(undefined)).toBe(false)
		expect(isStoredEntry('job-1')).toBe(false)
		expect(isStoredEntry([])).toBe(false)
	})

	it('contains a throwing accessor instead of letting it escape', () => {
		const hostile = Object.defineProperty({ input: 'task', attempts: 0 }, 'id', {
			get() {
				throw new Error('hostile id getter')
			},
			enumerable: true,
		})
		expect(isStoredEntry(hostile)).toBe(false)
	})

	it('refuses a cyclic value without recursing', () => {
		const cyclic: Record<string, unknown> = { id: 'job-1', attempts: 0 }
		cyclic.self = cyclic
		expect(isStoredEntry(cyclic)).toBe(false)
	})
})
