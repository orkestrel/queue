/**
 * Create the queue failure for an aborted or expired attempt.
 *
 * @param expired - Whether the attempt deadline expired
 * @returns The queue's documented attempt failure
 *
 * @example
 * ```ts
 * import { createAttemptError } from '@src/core'
 *
 * createAttemptError(false).message // 'attempt aborted'
 * createAttemptError(true).message // 'attempt timed out'
 * ```
 */
export function createAttemptError(expired: boolean): Error {
	return new Error(expired ? 'attempt timed out' : 'attempt aborted')
}
