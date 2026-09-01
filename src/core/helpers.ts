import type { Guard } from '@orkestrel/contract'
import type { QueueEntryOptions, QueueOption } from './types.js'
import { QueueError } from './errors.js'

/**
 * Reads one named option from a caller-supplied entry options object.
 *
 * @remarks
 * The property is read exactly once, inside a boundary that contains a throwing
 * getter. An absent options object reads nothing and yields `undefined`.
 *
 * @param options - The caller's own entry options, or `undefined`
 * @param option - The option key to read
 * @param message - The failure description the thrown error carries
 * @returns The value the property held, or `undefined` when no options object was supplied
 * @throws {QueueError} Thrown when reading the property throws, coded `invalid` with the
 *   option in its context.
 *
 * @example
 * ```ts
 * readOption({ retries: 2 }, 'retries', 'queue retries could not be read') // 2
 * ```
 */
export function readOption(
	options: QueueEntryOptions | undefined,
	option: keyof QueueEntryOptions,
	message: string,
): unknown {
	try {
		return options?.[option]
	} catch (error: unknown) {
		throw new QueueError(message, {
			code: 'invalid',
			cause: error,
			context: { option },
		})
	}
}

/**
 * Validates one already-read queue option against its guard.
 *
 * @param value - The option value to check
 * @param guard - The total guard the value must satisfy
 * @param option - The option key the failure context reports
 * @param message - The failure description the thrown error carries
 * @returns The same value, narrowed by the guard
 * @throws {QueueError} Thrown when the guard refuses the value, coded `invalid` with the
 *   option and the refused value in its context.
 *
 * @example
 * ```ts
 * validateOption(4, isQueueConcurrency, 'concurrency', 'queue concurrency must be positive') // 4
 * ```
 */
export function validateOption<TValue>(
	value: unknown,
	guard: Guard<TValue>,
	option: QueueOption,
	message: string,
): TValue {
	if (guard(value)) return value
	throw new QueueError(message, {
		code: 'invalid',
		context: { option, value },
	})
}
