// The base setup module (`tests/setup.ts`) declares no export: it is loaded first by every
// project purely for its side-effect-free placement in `setupFiles`, and holds no
// environment-agnostic helper of its own in this workspace. Its observable contract is that
// loading it adds nothing to the namespace.
//
// Control: swapping the expected member list from `[]` to `['placeholder']` must fail this
// case, proving the assertion is not vacuously true.
import * as setup from './setup.js'
import { describe, expect, it } from 'vitest'

describe('base setup module', () => {
	it('exports no member', () => {
		expect(Object.keys(setup)).toEqual([])
	})
})
