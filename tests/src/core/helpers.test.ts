import { describe, expect, it } from 'vitest'
import { createAttemptError } from '@src/core'

describe('createAttemptError', () => {
	it('creates the documented abort failure', () => {
		expect(createAttemptError(false)).toEqual(new Error('attempt aborted'))
	})

	it('creates the documented timeout failure', () => {
		expect(createAttemptError(true)).toEqual(new Error('attempt timed out'))
	})
})
