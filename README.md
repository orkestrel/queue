# @orkestrel/reason

A zero-dependency, synchronous, deterministic **reasoning engine**: declarative,
JSON-serializable **definitions** are evaluated against **subjects** (plain
data records) to produce traceable **results**. Four strategies behind one
dispatch surface — `quantitative` (factor-based numeric scoring), `logical`
(rule-based boolean deduction with forward / backward chaining), `symbolic`
(algebraic equation solving by variable isolation), `inferential` (fact
derivation with unification variables and proof trees) — each a
`ReasonerInterface` registered on the thin `Reason` orchestrator, with three
injectable operators (`Evaluator` / `Transformer` / `Aggregator`) doing the
shared arithmetic. Every result is a fresh object carrying `success`, a
human-readable `trace`, and accumulated `errors`; nothing mutates its inputs.
Environment-agnostic — no I/O, no browser or server assumptions. Part of the
`@orkestrel` line.

## Install

```sh
npm install @orkestrel/reason
```

## Requirements

- Node.js >= 24
- ESM-only (no CommonJS build)

## Usage

```ts
import {
	createQuantitativeReasoner,
	createReason,
	factorGroup,
	fieldFactor,
	quantitativeDefinition,
	staticFactor,
} from '@orkestrel/reason'

const reason = createReason({ reasoners: [createQuantitativeReasoner()] })

const definition = quantitativeDefinition('risk', 'Risk score', [
	factorGroup('drivers', 'sum', [
		fieldFactor('age', 'age'), // reads subject.age, parseNumber-coerced
		staticFactor('floor', 10), // a fixed contribution
	]),
])

const result = reason.reason({ age: 25 }, definition) // one subject → one result
if (result.reasoning === 'quantitative') result.value // 35 — narrow by the discriminant
result.trace // the step-by-step account of how the value came to be
```

`reason` dispatches by `definition.reasoning` — pass an ARRAY of subjects and
the batch overload maps them in order to an equal-length result array.
Results are a discriminated union (`reasoning` names the axis): narrow with
the discriminant and read the strategy-specific payload (`value` /
`conclusion` / `solutions` / `derived`).

## Guide

For the full surface — the orchestrator, the four reasoners, the three
operators, the definitions & subjects capability layer, the two workspace
builders (`DefinitionBuilder` / `SubjectBuilder`), validators, errors, and the
observation surface — see [`guides/src/reason.md`](guides/src/reason.md).

## Package

Published as a single typed entry point per the `exports` field in
`package.json`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
