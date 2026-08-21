# Test

> The test helpers the fleet kept rewriting, published once. They read as two families, one pair
> outside both, and a browser journey layer beside them.
>
> **What a test records.** A call recorder, a captured throw, a drained async source, a JSON copy, a
> required value, and a real delay. Each turns what the code under test did into a value you can
> assert on.
>
> **What a test owns and must give back.** A temporary directory, a cleanup list, and a loopback
> server, each carrying `destroy()`. Each one takes something from the host.
>
> `resolveRoot` and `readInventory` are the pair outside both families: together they read the real
> tree a test checks itself against. Neither records anything, and neither owns anything to give
> back.
>
> `createHostileValues` sits outside them too, on the input side: it is what a test feeds its guards,
> a corpus whose every member makes a naive reader throw.
>
> The journey layer drives a real interface by role and accessible name through the installed
> Vitest provider, and generates the capture portfolio from the same journeys.
>
> A helper ships here only when enough packages had already written their own; [Limits](#limits)
> states that rule, what it excluded, and the one door the journey layer came through instead. This
> package holds one implementation of each and ships as a `devDependency`. Nothing here runs in
> production code. Source: [`src/core`](../src/core), [`src/browser`](../src/browser), and
> [`src/server`](../src/server).
>
> It has **zero runtime dependencies**, and no exported type here names an `@orkestrel/*` type. A
> dependency on `@orkestrel/emitter` would install a second copy of it beside the one a consumer
> already pins, and the compiler reads two copies as two distinct types. A foreign type in a
> signature fails the other way, rejecting the consumer's own local value inside the consumer's own
> repository. Rule 9 holds both.

## Install

```bash
npm install --save-dev @orkestrel/test
```

`@orkestrel/test` is the host-independent core. `@orkestrel/test/server` is the Node face — the
filesystem helpers and the pure leaves they are built from. `@orkestrel/test/browser` is the
journey layer, which drives a real browser through the installed Vitest provider. Core touches
neither `node:*` nor the DOM, so a browser test project imports it unchanged.

The browser face ships ES only. It is built on `vitest/browser`, which is an ES-only module, so no
CommonJS consumer can reach it and no `.d.cts` is emitted for it.

## Surface

Fifty-two exports: thirty-nine values and thirteen types, across three environments.

```ts
import { createRecorder, createTeardown, waitForDelay } from '@orkestrel/test'
import { createScratch } from '@orkestrel/test/server'

// What a test owns: one cleanup list, and a temporary directory seeded with the input under test.
const teardown = createTeardown()
const scratch = createScratch({ files: { 'input.txt': 'hello' } })
teardown.add(() => scratch.destroy())

// What a test records: a real callback rather than a spy — hand `handler` to the code under test.
const recorder = createRecorder<[path: string]>()
loader.on('read', recorder.handler)

loader.watch(scratch.path)
await waitForDelay(10) // let a real host timer elapse

recorder.count // how many reads arrived
recorder.calls // the arguments of each, oldest first

await teardown.destroy() // gives every owned resource back, newest first
```

### Core

Imported from `@orkestrel/test`.

#### Types

| Type                | Kind      | Shape                                                                                                                                                                                                                                                                                    |
| ------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RecorderInterface` | interface | `{ calls, count, handler }` plus `clear` — the recorded calls of one callback.                                                                                                                                                                                                           |
| `TeardownInterface` | interface | `{ count }` plus `add` / `destroy` — the cleanup one test registers as it goes.                                                                                                                                                                                                          |
| `TeardownHandler`   | type      | `() => void \| Promise<void>` — the work one registered entry performs.                                                                                                                                                                                                                  |
| `JSONValue`         | type      | `string \| number \| boolean \| null \| readonly JSONValue[] \| { readonly [key: string]: JSONValue }`.                                                                                                                                                                                  |
| `JSONSafe`          | type      | `JSONSafe<T>` — `T` with each member JSON preserves kept, and each member it drops or reshapes outside its declared type mapped to `never`: `undefined`, an opaque `object` member, and a symbol-keyed member. `unknown` still passes through, so `Record<string, unknown>` is accepted. |

Each interface's `readonly` data members are the row above; its call-signature members are listed
under [Methods](#methods).

#### Helpers

| API             | Kind     | Signature                                                   | Summary                                                     |
| --------------- | -------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| `waitForDelay`  | function | `(ms?: number) => Promise<void>`                            | Waits for a real host timer; defaults to `0`.               |
| `captureError`  | function | `(thunk: () => unknown) => unknown`                         | Runs a synchronous thunk and returns whatever it threw.     |
| `requireValue`  | function | `<T>(value: T \| null \| undefined, message?: string) => T` | Narrows away `null` and `undefined` by throwing.            |
| `collect`       | function | `<T>(source: AsyncIterable<T>) => Promise<readonly T[]>`    | Drains an async iterable into an array, in iteration order. |
| `collectStream` | function | `<T>(stream: ReadableStream<T>) => Promise<readonly T[]>`   | Drains a readable stream into an array, in read order.      |
| `roundTripJSON` | function | `<T>(value: T & JSONSafe<T>) => T`                          | Copies a JSON value; throws on a non-finite number.         |
| `resolveRoot`   | function | `(meta: ImportMeta) => URL`                                 | The URL one directory above the calling module's own file.  |

#### Factories

| API                   | Kind     | Signature                                                          | Summary                                                     |
| --------------------- | -------- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `createHostileValues` | function | `() => readonly unknown[]`                                         | Six fresh hostile values for proving that a guard is total. |
| `createRecorder`      | function | `<TArgs extends readonly unknown[]>() => RecorderInterface<TArgs>` | A recorder whose `handler` appends each call, in order.     |
| `createTeardown`      | function | `() => TeardownInterface`                                          | A cleanup list that runs newest-first when it is destroyed. |

### Browser

Imported from `@orkestrel/test/browser`. Every acting verb here resolves its own target from a role
and an accessible name and drives it through the installed Vitest provider, and none of them takes
an element, a component instance, or a selector for the thing it acts on. That is what keeps a
journey a description of what a person does rather than of what the markup happens to be. `render`
takes markup and creates a node. Three readers take a node — `readRows`, `style`, and `contrast` —
and each reads a node the caller already has rather than acting on a target it was handed.

#### Types

| Type                 | Kind      | Shape                                                                                                                                               |
| -------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CaptureVariant`     | interface | `{ name, width, height, apply? }` — one theme-and-viewport pair, and the document change it needs first.                                            |
| `PortfolioOptions`   | interface | `{ states, variants, variant, directory, enabled? }` — the registry, the matrix, this run's variant, where it writes, and whether it writes at all. |
| `PortfolioInterface` | interface | `{ variant, states, paths, files }` plus `place` — one run's registry and what it placed.                                                           |

#### Constants

| API                | Kind  | Signature           | Summary                                                                  |
| ------------------ | ----- | ------------------- | ------------------------------------------------------------------------ |
| `ACCESSIBLE_ROLES` | const | `readonly string[]` | The sixteen interactive roles a bare accessible name is searched across. |

#### Helpers

| API                     | Kind     | Signature                                                                               | Summary                                                                                                                                     |
| ----------------------- | -------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveAccessible`     | function | `(name: string) => HTMLElement` / `(role: string, name: string) => HTMLElement`         | One visible, focus-reachable control, scrolled into view once before reachability is measured.                                              |
| `resolveRendered`       | function | `(first: string, second?: string) => HTMLElement`                                       | The same resolver without the viewport requirement; the acting verbs use it.                                                                |
| `isOutsideViewport`     | function | `(rectangle: DOMRectReadOnly) => boolean`                                               | Whether a measured rectangle lies wholly outside the viewport.                                                                              |
| `clickAccessible`       | function | `(name: string) => Promise<void>` / `(role: string, name: string) => Promise<void>`     | Trusted activation of one resolved control.                                                                                                 |
| `clickAccessibleWithin` | function | `(region: string, role: string, name: string) => Promise<void>`                         | Trusted activation inside one named region, matching the control's name loosely.                                                            |
| `clickDisclosure`       | function | `(name: string) => Promise<void>`                                                       | Trusted activation of a native `<summary>`, which carries no role locators accept.                                                          |
| `typeAccessible`        | function | `(name: string, text: string) => Promise<void>`                                         | Focus, select all, delete, then real keystrokes, with the provider's key syntax escaped.                                                    |
| `fillAccessible`        | function | `(name: string, text: string) => Promise<void>`                                         | Replaces a value in one operation, for text too long to type.                                                                               |
| `pressKeys`             | function | `(keys: string) => Promise<void>`                                                       | A provider keyboard sequence sent to whatever holds focus.                                                                                  |
| `traverseAccessible`    | function | `(name: string) => Promise<HTMLElement>`                                                | Forward Tab alone, until focus lands on the re-resolved target.                                                                             |
| `readPerception`        | function | `(name: string) => string`                                                              | The normalized `innerText` of exactly one visible named region, dialog, table, panel, or alert.                                             |
| `readPage`              | function | `() => string`                                                                          | The normalized `innerText` of the whole page.                                                                                               |
| `readFocus`             | function | `() => string \| undefined`                                                             | The focused HTML element's rendered text (`''` included); `undefined` for a non-HTML focus; the whole page's text when nothing holds focus. |
| `readValue`             | function | `(role: string, name: string) => string`                                                | The value a resolved input, textarea, or select renders.                                                                                    |
| `waitForFrame`          | function | `() => Promise<void>`                                                                   | One `requestAnimationFrame`, to settle pending paint work.                                                                                  |
| `render`                | function | `(markup: string) => HTMLDivElement`                                                    | Trusted fixture markup in a container attached to the document.                                                                             |
| `contrast`              | function | `(element: Element) => number`                                                          | The WCAG 2.x ratio, compositing every translucent layer onto the first opaque one.                                                          |
| `readCascade`           | function | `() => ReadonlySet<string>`                                                             | Every class token the stylesheets loaded into this document define.                                                                         |
| `readRows`              | function | `(root: ParentNode, selector: string) => readonly string[]`                             | One line per matched element, built from its text nodes rather than from `textContent`.                                                     |
| `style`                 | function | `(element: Element, property: string) => string`                                        | One resolved CSS property, read from the real browser.                                                                                      |
| `expandCaptures`        | function | `(states: readonly string[], variants: readonly CaptureVariant[]) => readonly string[]` | The registry times the variants, as `<state>--<variant>.png` names.                                                                         |

#### Factories

| API               | Kind     | Signature                                           | Summary                                                      |
| ----------------- | -------- | --------------------------------------------------- | ------------------------------------------------------------ |
| `createPortfolio` | function | `(options: PortfolioOptions) => PortfolioInterface` | The capture registry one run places its screenshots through. |

`resolveAccessible` counts a match as reachable only when every condition holds: it is connected; it
passes a visibility check honouring opacity and CSS; its box has non-zero width and height; its
`tabIndex` is at least zero; it matches neither `:disabled` nor `[aria-disabled="true"]`; and it has
no `[inert]` ancestor. A wholly off-viewport match is scrolled into view once and measured again, so
a control a person can scroll to is reachable and one that stays outside is not. The bare-name form
searches `ACCESSIBLE_ROLES`; the two-argument form searches exactly the role it is given, which is
how a name a tab shares with its own panel is disambiguated.

`resolveRendered` applies the same conditions and skips the viewport requirement. It is what every
acting verb resolves through, so a click does not fail on a target the act itself scrolls into view.
It is exported because a journey that needs a target before it is on screen needs the same rule
rather than a second reading of it.

`clickAccessibleWithin` matches the region's name exactly and the control's name loosely. That
combination is what a person does with a repeated short verb such as `Add`, or with a line whose
rendered status completes its accessible name: the region supplies the context, and the name only
has to be recognisable inside it.

`traverseAccessible` charges a step only when focus actually lands on an element, ends when focus
revisits one — that is a complete cycle of the tab order — and re-resolves the target by name on
every step, because a framework may replace the node between resolution and focus arrival. Its hard
cap is three times the page's candidate count plus ten, including disabled controls and elements
with `tabindex="-1"`, so a page whose focus never settles fails instead of hanging.

`contrast` resolves a transparent or translucent background through the element's ancestors: every
painted layer from the element up to the first opaque one composites top-over-bottom onto that
opaque base, so a 3% surface tint reads as a tint over what shows through it rather than as a
full-strength paint. A translucent foreground then resolves against that effective background before
luminance is measured. It refuses a stack where nothing from the element upwards paints, rather than
assuming a white canvas, and it refuses a detached element, whose computed foreground color does not
exist.

`createPortfolio` refuses an unregistered variant name at creation, so a run cannot write a filename
naming a combination it did not render. A portfolio left un-`enabled` is the ordinary run: `place`
resizes nothing, writes nothing, and records nothing, so a journey calls it unconditionally. An
enabled `place` applies the variant, resizes the viewport only when it is not already that size,
writes `<directory>/<state>--<variant>.png` through the provider, and records the path the provider
reports writing. `states` and `paths` hand out snapshots, so a list read before a placement stays
what it was.

The filename law is injective within one run: one variant is selected, and every filename is
`<state>--<variant>.png`. A duplicate filename therefore implies a duplicate placement, which
`place` already refuses. Any future naming change that breaks this injectivity must reintroduce a
collision refusal before writing.

### Server

Imported from `@orkestrel/test/server`.

#### Types

| Type                | Kind      | Shape                                                                                                                |
| ------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| `ScratchInterface`  | interface | `{ path }` plus `write` / `read` / `has` / `names` / `ensure` / `link` / `remove` / `destroy` — one owned directory. |
| `ScratchIdentity`   | interface | `{ device, inode, birth }` — the three fields that together name one allocation on its host.                         |
| `ScratchOptions`    | interface | `{ parent?: string, prefix?: string, files?: Readonly<Record<string, string>> }`.                                    |
| `LoopbackInterface` | interface | `{ url, port }` plus `destroy` — one server on an owned ephemeral loopback port.                                     |
| `InventoryOptions`  | interface | `{ extensions?: readonly string[], exclude?: readonly string[] }`.                                                   |

#### Constants

| API                           | Kind  | Shape               | Summary                                                                              |
| ----------------------------- | ----- | ------------------- | ------------------------------------------------------------------------------------ |
| `REMOVE_TREE_MAX_ATTEMPTS`    | const | `number`            | The attempts `removeTree` makes before rethrowing a retryable removal error.         |
| `REMOVE_TREE_RETRY_DELAY_MS`  | const | `number`            | The synchronous delay, in milliseconds, `removeTree` waits between attempts.         |
| `REMOVE_TREE_RETRYABLE_CODES` | const | `readonly string[]` | The removal error codes `removeTree` retries; every other code rethrows immediately. |

#### Helpers

| API                | Kind     | Signature                                                                                                           | Summary                                                                          |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `readInventory`    | function | `(root: URL \| string, targets: readonly string[], options?: InventoryOptions) => Readonly<Record<string, string>>` | Named files and walked directories, keyed by root-relative path in sorted order. |
| `resolveContained` | function | `(root: string, target: string) => string \| undefined`                                                             | The absolute target below `root`, or `undefined` when it escapes.                |
| `isExcluded`       | function | `(key: string, exclusions: readonly string[]) => boolean`                                                           | Whether an exclusion names the key or one of its ancestors.                      |
| `matchesIdentity`  | function | `(current: ScratchIdentity, allocation: ScratchIdentity) => boolean`                                                | Whether two identities name the same allocation.                                 |
| `removeTree`       | function | `(path: string) => void`                                                                                            | Remove a directory tree, retrying a briefly-held handle before rethrowing.       |

`resolveContained` is the one lexical containment check, and `readInventory` and `createScratch`
both call it. It resolves the target against the root — relative or absolute — and returns
`undefined` when the result is not below it. An absolute target inside the root resolves, so a
caller hands it the path it already has rather than making it root-relative first. It is exported
because a consumer writing its own filesystem fixture needs the same check and would otherwise write
another copy of it.

`@orkestrel/scaffold` publishes `resolveContainedPath`, one word away, and the two are not the same
predicate. This one is lexical only and dependency-free. That one is lexical plus physical — it also
refuses a link that leaves the root and a dangling link whose raw target contains a `..` segment —
and it lives in a build tool. A test helper with zero runtime dependencies does not take a runtime
dependency on the scaffolding tool to obtain a path predicate. If that difference ever stops holding,
delete `resolveContained` and import `resolveContainedPath` from `@orkestrel/scaffold`, which this
package already carries as a `devDependency`, rather than adding a third variant.

`isExcluded` is the exclusion rule itself, and `readInventory` applies it to a named target and a
walked entry alike. An exclusion matches whole segments of a root-relative key, so it drops the key
it names and every key below it, and it leaves a sibling whose name merely starts the same way. It
takes exclusions already normalized: `readInventory` normalizes the spellings its `exclude` option
accepts before calling it, so a caller applying the rule to its own keys normalizes its own list. It
is exported because a consumer walking its own tree wants that rule rather than a second reading of
what `exclude` means.

`matchesIdentity` is the comparison `destroy()` makes before it removes anything: whether the
identity read from the allocated path now is the identity recorded when the directory was allocated.
All three fields are compared because none of them alone identifies an allocation. A device is
shared by every directory on one filesystem, an index node is reused once its directory is removed,
and a creation time repeats within the host's timestamp resolution. It is exported so a fixture that
manages its own directory can make the same check rather than trusting a path.

#### Factories

| API              | Kind     | Signature                                        | Summary                                                              |
| ---------------- | -------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| `createScratch`  | function | `(options?: ScratchOptions) => ScratchInterface` | Allocates a directory below `parent` the caller owns and destroys.   |
| `createLoopback` | function | `(server: Server) => Promise<LoopbackInterface>` | Binds a caller-supplied server to `127.0.0.1` on a host-picked port. |

A refused `ScratchOptions` key leaves nothing behind, by two different mechanisms. `parent` and
`prefix` are checked before `mkdtempSync` runs, so a refused value allocates nothing. `files` is
seeded after the directory exists, so a refused key removes the directory that was just made and
rethrows.

`parent` is the existing directory the allocation is created in, and defaults to the host temporary
directory; allocation throws when it is missing, is a symbolic link, or is not a directory. `prefix`
starts the generated directory name, and defaults to `orkestrel-test-`; allocation throws when it
contains `/` or `\`, which is what stops a prefix steering the allocation out of its parent. Nothing
else is refused: a fragment carrying no separator is one path segment, so `release-0..2-` allocates.
`files` seeds files on allocation, keyed by path below the scratch directory; allocation removes the
directory it just made and rethrows when a key escapes or the host refuses a write.

`createLoopback` takes a `node:net` `Server` — `node:http`'s and `node:https`'s both extend it — and
never constructs one. It listens on port `0` at `127.0.0.1`, waits for the `listening` event, and
reads the assigned port off `address()`, throwing
`Loopback address must have a numeric port; found <address>` when that address carries none. Rule 11
states what `destroy()` drops, what `url` does and does not spell, and why this package never
reserves a port number.

## Methods

The call-signature members of each behavioral interface. Their `readonly` data members stay in the
[Surface](#surface) rows above.

#### `RecorderInterface`

| Method  | Returns | Behavior                                                                     |
| ------- | ------- | ---------------------------------------------------------------------------- |
| `clear` | `void`  | Truncates the recorded calls in place; the recorder stays usable afterwards. |

#### `TeardownInterface`

| Method    | Returns         | Behavior                                                                                                                                                                                                                                 |
| --------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`     | `void`          | Registers one handler. Registration order is what `destroy()` reverses, so the newest registration is undone first.                                                                                                                      |
| `destroy` | `Promise<void>` | Runs every registered handler newest-first, awaiting each before the next, and empties the list. Every handler runs even after an earlier one fails; one failure rethrows by identity and several throw an `AggregateError`. Idempotent. |

#### `LoopbackInterface`

| Method    | Returns         | Behavior                                                                                                                                                                                                                                                                                               |
| --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `destroy` | `Promise<void>` | Drops every live connection on a server that carries `closeAllConnections`, stops listening, and releases the port; a plain `net.Server` has no such method, so it waits for its open sockets to end. Idempotent: the first call's promise is handed to every later one, and a closed server resolves. |

#### `PortfolioInterface`

| Method  | Returns                        | Behavior                                                                                                                                                                                                               |
| ------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `place` | `Promise<string \| undefined>` | Places one registered state: applies the variant, resizes the viewport when it differs, writes the screenshot, records it, and returns the written path. `undefined` and no record at all when the run is not enabled. |

#### `ScratchInterface`

| Method    | Returns               | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `write`   | `void`                | Writes a file at a path lexically contained by the directory, creating missing parents. Throws on an escaping path, and on a root that is missing, a link, or not a directory.                                                                                                                                                                                                                                                                                                                                                                                           |
| `read`    | `string \| undefined` | Reads a file, or `undefined` when no file can be read, including through a link whose target is missing and after the allocation is gone. Throws `Scratch path is a directory: <target>` on a directory, and throws on an escaping path and on a root that is a link or not a directory. Reading follows links, so a link the host cannot resolve, such as a cycle, surfaces the host's own error.                                                                                                                                                                       |
| `has`     | `boolean`             | Whether the entry at a contained path is present, without following its final link, so a link whose target is missing still reports `true`. `false` once the allocated directory itself is gone. Throws on an escaping path, and on a root that is a link or not a directory.                                                                                                                                                                                                                                                                                            |
| `names`   | `readonly string[]`   | The entry names directly inside a lexically contained directory, sorted, without their parent paths — the allocated directory itself when the target is omitted. Throws on an escaping path, on a target that is missing or is not a directory, and on a root that is missing, a link, or not a directory.                                                                                                                                                                                                                                                               |
| `ensure`  | `string`              | Creates a directory at a lexically contained path and every missing parent, and returns that lexical path. It is the one member that produces an empty directory, because `write` always creates a file. Idempotent on a directory that already exists. Throws when the target exists and is not a directory, on an escaping path, and on a root that is missing, a link, or not a directory.                                                                                                                                                                            |
| `link`    | `void`                | Creates a symbolic link at a contained path, creating its missing parents. The source is link text rather than a checked path, so it may point outside the directory. Throws on an escaping path, on a root that is missing, a link, or not a directory, and when the host refuses the link — `EEXIST` when something already occupies the path.                                                                                                                                                                                                                         |
| `remove`  | `void`                | Removes the entry at a lexically contained path: a file, an empty directory, or a directory and its whole subtree. A missing target is a no-op rather than an error, so a caller removing something it created conditionally does not guard first. It acts at the final segment rather than through it, so removing a link removes the link and leaves its destination standing. Throws on an escaping path, on a target naming the allocation itself — lexically, or through an intermediate symbolic link — and on a root that is missing, a link, or not a directory. |
| `destroy` | `void`                | Removes the directory this call allocated, and only that: it removes the entry at the allocated path while `matchesIdentity` holds against the allocation, and removes nothing when it does not. Idempotent.                                                                                                                                                                                                                                                                                                                                                             |

An empty target names the allocation root. `ensure('')` returns the root path, `has('')` reports
`true`, and `names('')` lists the root. `write('', …)` surfaces the host's `EISDIR` and `link('', …)`
its `EEXIST`, because the root is a directory that already exists. The host code is the accurate
answer there, so this package adds no refusal of its own.

`remove` is the exception, and it refuses: `remove('')`, `remove('.')`, and `remove` of the absolute
root all throw `Scratch directory is not a removable target: <target>`. Every other member reads the
root as harmless or as a question about the allocation, and only `remove` would read it as an
instruction to delete one — which is what an empty computed path produces. Ending the allocation is
`destroy()`'s job. What the refusal buys is that the degenerate argument is loud: the empty computed
path is this member's most destructive input, and it throws rather than acting. It buys no more than
that. A directory that has replaced the allocation at the same path is not protected by it —
`remove('x')` still removes `<replacement>/x`, exactly as `write`, `ensure`, and `link` still act
inside one.

### Traversal

Every member that takes a target resolves that target's **intermediate** segments through a symbolic
link inside the allocation and acts at the destination. `write`, `read`, `has`, `names`, `ensure`,
`link`, and `remove` all do this, so a lexically contained path can read, list, create, write, and
remove outside the allocation. That is the contract rather than a hole in it: containment here is
lexical, `link` is the member that creates such a link, and the [threat model](#threat-model) names
who else creates one.

`remove` carries the one physical exception, and it is narrow. It reads the final entry it reaches
with `lstat` and refuses when that entry carries the allocation's identity, so a target that arrives
back at the allocation through an intermediate link throws instead of emptying it. A sibling reached
through that same link is still removed. The exception stops at the allocation itself and is
deliberately not narrowed further, because narrowing it further would be the per-segment walk this
package declines to do.

The **final** segment is where `has`, `link`, and `remove` differ from the rest. `has` reads it with
`lstat` rather than following it, so `has('gate')` reports the link itself and stays `true` after
whatever `gate` pointed at is removed. `link` acts at the final segment rather than through it, so a
second `link('gate', …)` surfaces the host's `EEXIST` instead of creating a link inside the
destination. `remove` acts there too, so `remove('gate')` unlinks `gate` and leaves the directory it
pointed at standing; following the link would instead remove a whole tree outside the allocation
through one contained path. `write`, `read`, `names`, and `ensure` act at what a final-segment link
points at, so `ensure` against a dangling final link throws the host's `ENOENT` and creates nothing
at the destination.

`ensure` returns the lexical path it was given rather than the destination, so `ensure('gate/made')`
returns `<allocation>/gate/made` while the directory is made wherever `gate` points, and
`ensure('gate')` returns `<allocation>/gate` and leaves the directory it points at alone.

## Voices

Every message `src/browser` throws. Keep them distinct: a journey asserts the one it means, and
absent, present-but-gated, and ambiguous are three different findings about an interface.

| Voice                                                                                 | Thrown by               |
| ------------------------------------------------------------------------------------- | ----------------------- |
| `No interactive element has the accessible name "<name>"`                             | `resolveRendered`       |
| `Interactive target "<name>" is not visible and focus-reachable`                      | `resolveRendered`       |
| `Interactive target "<name>" is ambiguous across <n> elements`                        | `resolveRendered`       |
| `Interactive target "<name>" could not be resolved`                                   | `resolveRendered`       |
| `Interactive target "<name>" is unreachable after scrolling`                          | `resolveAccessible`     |
| `Interactive target "<name>" is not reachable inside "<region>"`                      | `clickAccessibleWithin` |
| `Interactive target "<name>" is ambiguous across <n> elements inside "<region>"`      | `clickAccessibleWithin` |
| `Interactive target "<name>" could not be resolved inside "<region>"`                 | `clickAccessibleWithin` |
| `Native disclosure "<name>" is not visible and focus-reachable`                       | `clickDisclosure`       |
| `Native disclosure "<name>" is ambiguous across <n> elements`                         | `clickDisclosure`       |
| `Native disclosure "<name>" could not be resolved`                                    | `clickDisclosure`       |
| `Interactive target "<name>" is not reachable through forward Tab traversal: <trail>` | `traverseAccessible`    |
| `Named region "<name>" is not visible`                                                | `readPerception`        |
| `Named region "<name>" is ambiguous across <n> elements`                              | `readPerception`        |
| `Named region "<name>" could not be resolved`                                         | `readPerception`        |
| `Interactive target "<name>" does not carry a value`                                  | `readValue`             |
| `Computed foreground color is unavailable`                                            | `contrast`              |
| `Computed background color is unavailable`                                            | `contrast`              |
| `Computed background channel is unavailable`                                          | `contrast`              |
| `Capture variant "<name>" is not registered`                                          | `createPortfolio`       |
| `Capture state "<state>" is not registered`                                           | `place`                 |
| `Capture state "<state>" is already placed`                                           | `place`                 |

Five of them are narrowing rather than findings, and no input reaches them. `could not be resolved`
appears four times and `Computed background channel is unavailable` once. In each case, a preceding
length check does not narrow the later lookup under `noUncheckedIndexedAccess`, so the branch gives
the value its type.

## Contract

These hold across `src/core`, `src/browser`, `src/server`, and this guide.

1. **Doc ↔ source bijection.** Every `## Surface` row is a real export, and every export is a row —
   exhaustive in both directions, name and kind together. The same suite anchors three further
   comparisons to source rather than to the guide: the barrel exposes exactly what the modules
   declare, `## Methods` documents exactly the interfaces that carry call signatures, and every name
   a `ts` fence imports from this package is a real export. Deleting a documented section therefore
   fails rather than passing with nothing left to check.
   [`tests/guides.test.ts`](../tests/guides.test.ts) proves all of it, and builds its own file
   inventory with this package's `readInventory` and `resolveRoot`.
2. **`clear()` truncates.** It empties the backing array rather than replacing it, so a `calls`
   reference captured before the call reads as empty after it. Capture `calls` after the last
   `clear()` you care about, or read `count` instead.
3. **`captureError` converts a synchronous throw into a value.** It returns the thrown value
   exactly, including `null` and `undefined`, and it never throws for a thunk that completed. Two
   limits come with that. A thunk that throws `undefined` is indistinguishable from one that
   completed, because both return `undefined`; assert on a thrown value's identity, not on its
   absence. And an `async` thunk never throws synchronously — it returns a rejected promise — so
   `captureError` returns `undefined` and the rejection escapes unhandled. It converts; it decides
   nothing. The variant that throws when nothing was thrown is an assertion, and it is not published
   here.
4. **`requireValue` tests presence, not truth.** `0`, `''`, and `false` pass through unchanged; only
   `null` and `undefined` throw. It exists because `!` and `as` are banned, so a throwing narrowing
   helper is the sanctioned way to reach a value's non-nullable type.
5. **`roundTripJSON` bounds its parameter by `JSONSafe<T>`, and throws rather than returning `null`
   quietly.** The parameter is `T & JSONSafe<T>` rather than `T extends JSONValue`, because a
   `JSONValue` constraint rejects every `interface`: TypeScript grants an implicit index signature
   to a type alias and never to an interface, and interfaces are what this fleet's public types are.
   The projection accepts an interface-typed value, keeps `T` as the return type, and refuses a
   `Date`, a `Map`, or any method-bearing type at the member that carries it. Three more members
   meet `never` for one reason: the copy would not carry what the type claims. Serialization drops a
   member typed `undefined` from an object and rewrites it to `null` in an array, so
   `{ a: undefined }` and a top-level `undefined` are both refused at the call. `JSON.stringify`
   never enumerates a symbol-keyed member, so the copy arrives without it. And a member declared as
   the opaque `object` type projects over no members at all, so a `Date` under it would copy back as
   a string, off the type the member declares. One member type does pass through: `unknown`, so
   `Record<string, unknown>` is accepted and what its values hold is a runtime question rather than
   a typed one. The bound is not enough on its own either: `NaN`, `Infinity`, and `-Infinity` are
   numbers, they satisfy it, and `JSON.stringify` turns each of them into `null`. So the helper
   rejects a non-finite number at any depth with `JSON values must contain finite numbers`, and the
   copy's type claim holds for every value it does return. The replacer alone would not close it: a
   `JSON.rawJSON` value carries text `JSON.stringify` emits without inspecting, so
   `JSON.rawJSON('1e400')` passes the replacer untouched and parses back as `Infinity`. The helper
   therefore checks the parsed graph as well, and both doors report the same message. One
   normalization remains and is not an error: `-0` serializes as `0`, so the copy is `0`.
6. **`readInventory` refuses links.** A target is a file or a directory. A named file is read and
   keyed whatever `extensions` says, which is what lets one call take a package's root files and its
   source tree together; a named directory is walked under the filter. It throws when the root or a
   named target is a symbolic link, when the root is not a directory, when a target is neither a file
   nor a directory, or when a target resolves outside the root. A missing target surfaces the host's
   own `ENOENT` rather than a message from this package. It skips a symlink met while walking rather
   than following it. A target may be written relative to the root or as an absolute path inside it,
   and one that escapes is refused either way.

   A link in the **middle** of a named target is the fourth refusal, and the only one that reaches
   it: the symbolic-link check reads the final segment, which such a link is not. The named target is
   resolved with `realpath` and refused when the real path leaves the root, so
   `readInventory(root, ['link/file.txt'])` with `link` pointing outside throws
   `Target outside root: link/file.txt`. When that link stays inside the root the target resolves,
   and the entry is keyed by its **real** path rather than by the path the caller named.

   An exclusion applies to a named target as well as a walked entry, so exclusion beats naming:
   `readInventory(root, ['src/core/index.ts'], { exclude: ['src/core'] })` returns `{}`. A
   `tsconfig` reader expects the more specific entry to win, the way a `files` entry survives
   `exclude`; here the more specific entry is the one that disappears. Express an exception with a
   second call that names the kept file and passes no exclusion, and merge the two maps. An
   exclusion is normalized before the rule applies: a leading `./` and a trailing `/` are stripped,
   and `''` and `'.'` both name the root, so either drops every key. Keys are root-relative and
   separated by `/` whatever the host separator is. The suite runs on POSIX, where `/` is already
   the separator, so it proves the key shape and not the conversion. The map is built by inserting
   the keys in sorted order. Read back, non-integer keys hold that order. Integer-like keys do not,
   because a plain object enumerates them numerically first: four files named `0`, `2`, `10`, and
   `a.txt` insert as `0`, `10`, `2`, `a.txt` and enumerate as `0`, `2`, `10`, `a.txt`. Returning a
   `ReadonlyMap` would keep the order and break the structural match with `@orkestrel/guide`'s
   `SourceOptions.files` that the whole helper is shaped for, so the guarantee narrows instead. Case
   is the host's decision, not this package's: whether two names differing only in case are one file
   varies by filesystem, so the suite probes the running host and asserts what the probe returned
   instead of assuming either answer.

7. **`createScratch` refuses a lexical escape, not a symbolic link.** It allocates with
   `mkdtempSync` below `parent`, which creates the directory at POSIX mode `0700`. The suite asserts
   that mode unguarded, so it is proven on POSIX and unproven on a host that emulates permission
   bits. Every member that takes a target — `write`, `read`, `has`, `names`, `ensure`, `link`, and
   `remove` — throws when that target lexically escapes the allocated directory, and a failed seed
   removes the directory before rethrowing. `remove` adds one refusal the others do not need: a
   target naming the allocation itself, lexically or through an intermediate symbolic link. The
   lexical half compares paths. The physical half reads only the final entry with `lstat` and
   compares it with `matchesIdentity`; it walks no path segments and follows no final link. That is
   the comparison `destroy()` makes, so it carries the same birth-time limit stated for `destroy()`
   below. `link` checks its target and not its source, so a contained link may point anywhere.
   `createScratch` does not walk the path's segments for symbolic links: that is sandbox behavior
   and this is not a sandbox. So a lexically contained path can still act outside the allocation,
   and only one that lands back on the allocation itself is refused; [Traversal](#traversal) states
   what each member does with a link it meets, and the [threat model](#threat-model) says who
   creates one.

   `names` sorts, and the suite discriminates a dropped `.sort()`. Two filenames written from raw
   bytes give `readdirSync` the reverse of sorted order: `0x80` is an invalid UTF-8 lead byte, so
   that name reaches JavaScript as `U+FFFD` and sorts after `é`, while on disk `0x80` sorts before
   `é`'s leading `0xc3`. The suite asserts the host's order, the sorted order, and that the two
   differ, so it fails rather than going quiet if that population ever stops discriminating.

   That population carries a limit, and it is Node's rather than this package's. A name the host
   refuses to decode reaches JavaScript as `U+FFFD`, and that string re-encodes to the three bytes
   `EF BF BD`, which are not the bytes on disk. So the string `names()` hands back never addresses
   the entry it came from: `has` on it reports `false`, and `remove(names()[i])` removes nothing and
   throws nothing, because a missing target is a no-op. The silence is the cost — a caller looping
   over `names()` to clear a directory leaves such a file behind and reads success. Reach that file
   with a `Buffer` path through `node:fs` directly.

   `destroy()` is idempotent, and identity is what makes it safe rather than location: it removes
   the entry at the allocated path only while `matchesIdentity` holds against the allocation. A
   replacement directory left at that path is not removed, and an allocation moved elsewhere is not
   removed at all. That comparison never consulted the host temporary directory, so it holds
   unchanged wherever `parent` puts the allocation. Two limits sit beside the `0700` one. The check
   reads the entry and then removes the path as two steps, so an allocation swapped between them is
   removed anyway; whoever swaps it runs as the same uid, which is the population the threat model
   already declines to defend against. And birth time is the host's to supply. This host supplies a
   real one — the allocation's `birthtimeMs` does not move when files are written into it, while its
   `ctimeMs` does — so `destroy()` is sound here. Where a host has none, libuv reports `ctime` in its
   place, the first seeded write moves it, and `destroy()` takes its early return. It returns `void`,
   so that refusal is indistinguishable from success and the allocation leaks silently.

8. **A destroyed allocation answers presence and refuses action.** `read` returns `undefined` and
   `has` returns `false`; `write`, `names`, `ensure`, `link`, and `remove` throw
   `Scratch directory does not exist`. The split follows the return type: a member whose return type
   carries absence answers with it, and a member whose return type does not, refuses. `names` asks a
   question and changes nothing, and it refuses anyway, because `readonly string[]` has no value
   meaning gone. `write`, `ensure`, and `link` are why the refusal is written out rather than left to
   the host: each calls `mkdirSync` with `recursive`, which recreates every missing parent, so
   without the check any of the three would rebuild the allocation root and leave a destroyed
   fixture looking alive. `remove` is written out for the opposite reason: `rmSync` with `force`
   does not throw on a path that is not there, so without the check it would report success against
   a fixture that is gone.
9. **Zero runtime dependencies, and no foreign type in a signature.** `dependencies` is empty and
   stays empty. No exported signature names an `@orkestrel/*` type, so no consumer can be handed a
   two-copies type failure by installing this package.
10. **`createTeardown` runs newest-first, and every handler runs.** `destroy()` takes the registered
    handlers in reverse registration order and awaits each one before starting the next, so a
    handler that undoes what a later registration depends on runs after it. A handler that throws or
    rejects does not stop the run: every remaining handler still runs, and the failures are raised
    at the end. Exactly one failure is rethrown by identity, so a test can assert on the value it
    threw. Several are wrapped in an `AggregateError` whose `errors` are in run order — newest
    first — rather than in registration order. `destroy()` empties the list before it starts, so a
    handler registered while the run is in progress stays registered for the next call rather than
    joining this one, and `count` read from inside a running handler counts only those late
    registrations. A repeated `destroy()` runs nothing that already ran, which is what makes it
    idempotent. The list registers no Vitest hook itself: the consumer writes
    `afterEach(() => teardown.destroy())` once, in its own setup. That one line is the price of the
    zero-dependency contract, because registering the hook here would take a runtime dependency on
    the test runner and rule 9 forbids one.
11. **`createLoopback` binds a server the caller made.** The caller constructs its own unstarted
    server and keeps every protocol handler on it; this package supplies the bind and the release
    and nothing else. It listens on port `0` at `127.0.0.1`, so the host assigns the port and the
    address is always IPv4 loopback — never `::1`, which a host resolving `localhost` can hand back
    instead, and never a fixed port a parallel worker may already hold. `port` is that assigned
    number, read off `address()`. `url` is `http://127.0.0.1:<port>` with no trailing slash, and the
    scheme is spelled `http` unconditionally, so a TLS server's origin is `port` plus a scheme the
    caller writes itself. `destroy()` drops every live connection before it closes, so a keep-alive
    client cannot hold the port past the test that opened it; the drop reaches the `node:http` and
    `node:https` servers that carry `closeAllConnections`. A plain `node:net` server has no such
    method to call, so `destroy()` waits for its open sockets to end. It is idempotent — the first
    call's promise is returned to every later one — and a server already closed underneath it
    resolves rather than throwing. The package never reserves a port number and releases it for the
    caller to rebind; [Limits](#limits) states why that shape is refused.
12. **`createHostileValues` is a growing totality corpus with a negative control.** Each call
    returns a frozen array of fresh values: a self-cycle, a revoked proxy, proxies that throw from
    `get`, `ownKeys`, and `getPrototypeOf`, and a null-prototype record. Every member makes a naive
    reader throw. Each has a direct probe for that failure. The negative control keeps an inert value
    from entering the corpus under a hostile name. A total guard survives every member without
    throwing. Whether it accepts or refuses one is that guard's own contract. Membership may grow in
    a release, so consumers loop over the whole array, assert their guard's expected answer per
    index, and attribute each failure by that index instead of naming or counting members locally.
13. **The journey layer resolves its own targets, and imports almost nothing.** No helper in
    `src/browser` accepts an element, a component instance, or a selector for the target it acts on:
    each finds its own from a role and an accessible name, which is what stops a journey drifting
    into a description of the markup. `render` takes markup and creates a node. `readRows`, `style`,
    and `contrast` take a node, and they are readers of a node the caller already has rather than
    verbs that act on a target.
    The whole environment imports `vitest/browser` and DOM globals and nothing else — no `src/core`
    import, no framework, no `node:*`, and no `import.meta.env`, so whether a run writes captures is
    the consumer's decision through `PortfolioOptions.enabled` rather than an environment variable
    this package reads. `vitest` is a peer dependency, so the provider the layer drives is the one
    the consumer already installed, and rule 9's empty `dependencies` is untouched.

### Threat model

The two filesystem helpers make different promises, because they work on different directories.
Read rule 7 against the `createScratch` paragraphs below and rule 6 against the `readInventory` one.

`createScratch` allocates its own directory with `mkdtempSync` at POSIX mode `0700`, and the suite
asserts that mode on POSIX, the only host CI runs. The mode keeps another uid out. It does not keep
out a sibling test worker or the code under test, because both run as the same uid, and they are the
population that would create a link here. Its containment check is lexical: it refuses a relative
path that escapes the allocated directory, which is the accident that actually happens — a test
writing `../foo`. It does not walk the path's segments for symbolic links, because per-segment
walking is sandbox behavior and this is not a sandbox.

So a link inside the allocation was created by the test process or by the code the test drives, and
handing `scratch.path` to the code under test is the ordinary use of this helper. `link` is this
package's own entry in that population: it creates a symbolic link on request, it refuses only an
escaping target, and its source may name anything. [Traversal](#traversal) states what each member
does with a link it meets, and a contained path reaching outside the allocation through one is the
result. This helper does not defend against that.

`parent` adds one limit, and it is visibility. An allocation under the host temporary directory is
seen by nothing in the repository. An allocation under a path inside a package tree is seen by
everything that walks that tree while it exists — `tsc`, the formatter, the linter, the policy
sweep, and the test runner's own globs. Set `parent` to a path those tools already ignore, or leave
it unset and take the host temporary directory. `destroy()` is unaffected either way, because it
matches on identity rather than on where the allocation sits.

`readInventory` walks a directory the caller supplies, usually a real checkout the test did not
create, so it does refuse links. It keeps four separate refusals: it throws on a symlinked root,
throws on a symlinked named target, throws on a named target whose real path leaves the root through
a link in the middle, and skips a symlink met while walking. They are four decisions rather than one
rule, and each is its own check at the door it guards.

Neither helper stops hard links. A hard link is an ordinary directory entry: `lstat` reports a
regular file, so `readInventory` reads the outside inode and `createScratch` writes through it.
Detecting that would need inode bookkeeping on every entry, and it would buy nothing, because
anyone able to create a hard link where the test process writes already writes there. So no
hard-link detection is added, and the boundary is documented instead.

## Limits

This package ships what the fleet repeats, not everything the fleet has.

`src/browser` came through a different door, and it is the only one. The threshold below discovers a
candidate by counting copies that already exist, which is the right instrument for a helper each
package wrote for itself. The journey layer is not that: it is the contract
`orkestrel-human-journey` requires every browser workspace to implement, and a workspace that writes
its own copy of it writes a slightly different resolver, a slightly different set of failure voices,
and a journey that reads as if it proved something it did not. Publishing it once is what keeps
those implementations identical, so it ships at one member rather than three. Nothing else enters
this way: a helper that merely happens to touch the DOM is measured by the threshold like everything
else, and two of them are refused below.

The membership rule is a threshold a candidate must clear to be **considered**. It is never a
guarantee of shipping. A candidate is considered when it has **three or more members that are not
all inside one dependency cluster, or five or more members regardless** — where a cluster is a set
of packages one of which runtime-depends on another. Two related packages sharing a helper is one
team's convention, not a fleet pattern. A candidate that clears the threshold can still be excluded,
and several below are. The threshold is therefore necessary and not sufficient: a candidate that
fails it is excluded, and a candidate that clears it either ships or appears below with the second
reason that excluded it.

A member is one implementation group carried by one package, under whatever name that package
spells it and whether it exports the helper or declares it inside a test file. Repeated calls routed
through one shared implementation stay one member. Counts are of those groups, so the first column
names the group rather than an export: **nothing in this section is importable**, and the only names
you can install are in [Surface](#surface). The widest group that did ship is `captureError` at 13.

Count a repeated set at the level a consumer uses it. A set of adversarial values fed through one
totality loop is one implementation for counting, whether the package builds that set beside the
loop or spells the same assertions out one by one. Its individual values are not separate members.

Everything below was counted this round over the fleet's 42 readable trees. The two private
repositories were read by the parallel campaign whose evidence the hostile guard-input row cites, so
the population is the full 44. A count that moves reopens its row. The Rule column says which half
of the rule decided a candidate: it **fails** the threshold, or it **clears** it and the reason says
whether it ships or names the second reason that excluded it. Each row is revisited when its count
or its second reason changes.

| Candidate                                                                                                             | Members  | Rule   | Why                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------- | -------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A recorder map over an emitter's events, with its map, event-map, subscriber, and totality types                      | 13       | Clears | A published signature cannot import the consumer's event map, and an indexed access is not an inference site, so the map would have to be passed explicitly at 219 call sites — 18 of which read a property off a call argument and would hard-error with `as` and `!` banned. `createRecorder`, the kernel all 13 local copies are built from, ships instead.  |
| Hostile guard-input sets                                                                                              | 3        | Clears | `form`, `table`, and `supervisor` each feed one adversarial set through total readers. The set ships as `createHostileValues`; its six members do not become six factories, and every member carries a naive-reader negative control.                                                                                                                           |
| Raw invocation — `invokeRaw`                                                                                          | 3        | Clears | Native `Reflect.apply` already makes the call at a deliberately untyped boundary, and each caller pairs it with the domain guard that narrows what came back. A published version has to declare a return type for a call it cannot see the target of, so it would claim a type nothing proved.                                                                 |
| Condition polling — wall-clock predicate loops                                                                        | 3        | Clears | Three independent members, so the count carries it. It is excluded because publishing it contradicts the no-polling architecture law: a loop that re-reads a predicate against the wall clock is the busy wait that law bans, and shipping one from the fleet's own test package would sanction it everywhere. Park the wait on the event or signal that fires. |
| Deep nesting beyond a guard's cap                                                                                     | 2        | Fails  | `table` builds a record chain and `supervisor` builds nested arrays. Two independent members stay below the threshold, and a shared factory would need a container selector that changes the construction algorithm.                                                                                                                                            |
| Canonical wire fixpoint assertions                                                                                    | 2        | Fails  | `form` and `table` each serialize, parse untrusted JSON, serialize again, and compare exact bytes. Two independent members stay below the threshold. The shape would still remain consumer-local if the count cleared, because it is an assertion over consumer codecs rather than a reusable test mechanism.                                                   |
| Numeric corpora, hostile-key tables, and deep-freeze                                                                  | 2–3 each | Fails  | Every remaining group sits inside the guard-and-evaluator cluster, so no group reaches three independent members. A numeric corpus or a hostile-object table is test policy — what a given suite decided to check — rather than a reusable mechanism, and covering the variants would need a mode argument.                                                     |
| Every browser helper — a DOM element builder, and the three helpers `database` and `indexeddb` share under five names | 2 each   | Fails  | Each candidate has two members, and the `database` / `indexeddb` pair is one cluster. `src/browser` now exists, so the build target, scoped tsconfig, barrel, and Playwright project no longer count against them. The count still does, and neither is part of the journey layer that opened the environment.                                                  |
| A hand-driven timer — `terminal`, `toolbox`                                                                           | 2        | Fails  | Two members, and `toolbox` runtime-depends on `terminal`, so they are one cluster twice over. Its shape is also `@orkestrel/terminal`'s published `TimerHandler`, which a copy here would redeclare unversioned.                                                                                                                                                |
| A hand-driven clock — `mcp`, `middleware`                                                                             | 2        | Fails  | Two members. Two is below the threshold under either half of the rule, and the two packages are independent, so no reading of it admits them. This shipped in the first draft as `createClock` and `ClockInterface` on taste alone, and is struck: a rule taste can override is not a rule. Both packages keep their local clocks until a third appears.        |
| A reserve-then-release port picker                                                                                    | 2        | Fails  | Two members. The shape is refused on its own account as well: it binds a port, closes it, and hands the number to a child that binds it again, and the window between that close and that rebind is a race another process on the host can win. Have the child bind `0` and report back the port it was given.                                                  |
| A bounded retry — `retryUntil`                                                                                        | 2        | Fails  | Two members, and only the count excludes it. It is not timer polling — it retries a real operation a bounded number of times rather than re-reading a predicate — so the no-polling law does not reach it, and a third independent member reopens this row on the count alone.                                                                                  |
| An abort-signal wait — `waitForAbort`                                                                                 | 2        | Fails  | Two members, which is below the threshold under either half of the rule. The count excluded it before any question about its shape was reached.                                                                                                                                                                                                                 |
| Abort-signal instrumentation                                                                                          | 2        | Fails  | Two members, read the same way as `waitForAbort` above and excluded for the same reason. Both rows are revisited when either count moves.                                                                                                                                                                                                                       |

The rule also ruled three names `ScratchInterface` publishes, and each is checkable against the same
numbers. `ensure` has 5 members, so it clears on count alone. `names` has 4, which is below five, so
it clears the three-member half instead: three of those four are mutually independent. `link` has 3,
mutually independent, and clears that half the same way. `has` renames the `exists` this interface
already carried, so it was never a candidate. `path`, `write`, `read`, and `destroy` are what an
owned directory is rather than candidates measured against the rule, so they carry no count.

`remove` ships at 2 members and the threshold did not decide it. The threshold decides whether a
helper is extracted from the fleet at all; `remove` is a member of an entity that already ships,
which makes it a question of coherence instead. `write`, `ensure`, and `link` each create something,
and nothing took one of them back short of `destroy()`.

Three smaller candidates clear the threshold and are excluded anyway. An error-recording wrapper has
11 members, and in 10 of them it is a five-line delegate to the recorder that already ships. A
deferred gate has 8 declarations across two names, and native `Promise.withResolvers` supersedes
every one of them. A shared random seed has 4 members and is a bare literal.

The rest fail the threshold on count: element and text requiring (2 each, and redundant under
`noUncheckedIndexedAccess`), unique naming (2, hidden module state), socket flushing (2, an
unjustified constant), the throwing variant of `captureError` (1), pattern requiring (1), and
settlement waiting (1). Every product-specific peer, protocol fixture, and domain builder stays in
the package that owns it.

## Patterns

### Record calls without a spy

A recorder is a real callback, so the code under test is driven exactly as a consumer drives it.
`clear()` truncates in place, which is what lets a captured reference stay correct.

```ts
import { createRecorder } from '@orkestrel/test'

const recorder = createRecorder<[id: string, size: number]>()
recorder.handler('a', 1)
recorder.handler('b', 2)
recorder.count // 2
recorder.calls // [['a', 1], ['b', 2]]

const captured = recorder.calls
recorder.clear()
recorder.count // 0
captured.length // 0 — the same array, truncated
recorder.handler('c', 3)
recorder.count // 1 — still usable
```

### Capture a throw, then assert on it

Assert on what came back, not on the fact that something came back. `undefined` is both "nothing was
thrown" and "`undefined` was thrown", and the helper cannot tell you which.

```ts
import { captureError } from '@orkestrel/test'

const thrown = captureError(() => JSON.parse('{'))
thrown instanceof SyntaxError // true

captureError(() => 'fine') // undefined — the thunk completed
captureError(() => {
	throw undefined
}) // undefined — the same result, from a thunk that threw

// An async thunk returns a rejected promise instead of throwing, so nothing is captured
// and the rejection escapes. Await the call and catch it yourself.
```

### Narrow without `!` or `as`

```ts
import { requireValue } from '@orkestrel/test'

requireValue(0) // 0
requireValue('') // ''
requireValue(false) // false
requireValue(undefined) // throws Error: Value is required
requireValue(null, 'port is required') // throws Error: port is required
```

### Drain an async source

```ts
import { collect, collectStream } from '@orkestrel/test'

async function* letters() {
	yield 'a'
	yield 'b'
}

await collect(letters()) // ['a', 'b']

const stream = new ReadableStream<number>({
	start(controller) {
		controller.enqueue(1)
		controller.enqueue(2)
		controller.close()
	},
})

await collectStream(stream) // [1, 2]
```

### Copy a JSON value

```ts
import { captureError, roundTripJSON } from '@orkestrel/test'

// An interface, not a type alias: the bound is a projection rather than an index signature, so an
// interface-typed value copies and keeps its own type.
interface Snapshot {
	readonly name: string
	readonly tags: readonly string[]
}

const original: Snapshot = { name: 'a', tags: ['x'] }
const copy: Snapshot = roundTripJSON(original)
copy // { name: 'a', tags: ['x'] }
copy.tags === original.tags // false — fresh references all the way down

// roundTripJSON(new Date()) — does not compile; a member JSON cannot carry is typed `never`.

roundTripJSON(-0) // 0 — JSON has no negative zero
captureError(() => roundTripJSON({ a: [{ b: NaN }] }))
// Error: JSON values must contain finite numbers — at any depth, rather than a silent null
```

### Prove a guard is total

Every member makes a naive reader throw. A total guard survives every member without throwing.
Whether it accepts or refuses one is that guard's own contract. Run the whole corpus, attribute a
throw or wrong answer to the loop index, and compare with the answer that guard's contract requires
for that member.

The fence is the body of a parameterized consumer test. `guard` is the total guard under test, and
`expected` is its readonly list of required answers in corpus order.

```ts
import { expect } from 'vitest'
import { createHostileValues } from '@orkestrel/test'

const values = createHostileValues()
expect(expected.length).toBe(values.length)

for (const [index, value] of values.entries()) {
	let accepted: boolean | undefined
	expect(() => {
		accepted = guard(value)
	}, `hostile value ${index}`).not.toThrow()
	expect(accepted, `hostile value ${index}`).toBe(expected[index])
}
```

The corpus is the positive proof input. Keep a negative control for every member too: perform the
naive read that member is meant to break and prove it throws. Without that control, an inert value
can make the totality loop look stronger without exercising another hostile boundary.

### Prove a wire fixpoint

A wire fixpoint proves that a consumer's parser and serializer reproduce canonical bytes after the
wire has crossed an untrusted JSON boundary. This is **not** `roundTripJSON`: that helper makes a
typed JSON copy and returns the copied value. No wire-fixpoint export exists, because the comparison
is the consumer's assertion over its own codecs. In this consumer-test fence, `schema` is the local
fixture and `parseSchema` and `serializeSchema` are its local codecs.

```ts
import { expect } from 'vitest'
import { requireValue } from '@orkestrel/test'

const wire = JSON.stringify(serializeSchema(schema))
const received = requireValue(parseSchema(JSON.parse(wire)))

expect(JSON.stringify(serializeSchema(received))).toBe(wire)
```

### Read a source inventory

The pairing `resolveRoot` and `readInventory` is what a guides-parity suite needs: the workspace
root from `import.meta`, then the file map. Rule 6 states what an exclusion matches; the last call
below is the part that surprises people.

```ts
import { resolveRoot } from '@orkestrel/test'
import { readInventory } from '@orkestrel/test/server'

// From tests/guides.test.ts, one directory up is the workspace root.
const root = resolveRoot(import.meta)

Object.keys(readInventory(root, ['src/core'], { extensions: ['.ts'] }))
// ['src/core/factories.ts', 'src/core/helpers.ts', 'src/core/index.ts', 'src/core/types.ts']

// A named file is included whatever `extensions` says, so one call takes the root files a suite
// needs and the source tree it walks.
Object.keys(readInventory(root, ['package.json', 'src/core'], { extensions: ['.ts'] }))
// ['package.json', 'src/core/factories.ts', 'src/core/helpers.ts', 'src/core/index.ts',
//  'src/core/types.ts']

Object.keys(
	readInventory(root, ['src/core'], {
		extensions: ['.ts'],
		exclude: ['src/core/index.ts'],
	}),
)
// ['src/core/factories.ts', 'src/core/helpers.ts', 'src/core/types.ts']

// A directory key takes every key below it.
Object.keys(readInventory(root, ['src'], { extensions: ['.ts'], exclude: ['src/server'] }))
// ['src/core/factories.ts', 'src/core/helpers.ts', 'src/core/index.ts', 'src/core/types.ts']

// An exclusion also applies to a target you name, so naming one file below an excluded directory
// does not reinstate it.
readInventory(root, ['src/core/index.ts'], { extensions: ['.ts'], exclude: ['src/core'] })
// {} — take the exception in a second call, and merge the two maps
```

### Own a temporary directory

```ts
import { createScratch } from '@orkestrel/test/server'

const scratch = createScratch({ prefix: 'guide-', files: { 'src/index.ts': 'export {}\n' } })

scratch.read('src/index.ts') // 'export {}\n'
scratch.has('src') // true
scratch.read('src') // throws Error: Scratch path is a directory: src
scratch.read('missing.ts') // undefined
scratch.write('../escape.ts', '') // throws Error: Path outside scratch directory: ../escape.ts

// `ensure` is how you get an empty directory, because every `write` creates a file.
scratch.ensure('empty')
scratch.names() // ['empty', 'src']
scratch.names('empty') // []

// `parent` puts the allocation somewhere other than the host temporary directory.
const child = createScratch({ parent: scratch.path, prefix: 'child-' })
scratch.names().length // 3 — 'empty', 'src', and the child allocation
child.destroy()
scratch.names().length // 2 — the child removed itself and nothing else

// `link` creates the symbolic link the threat model names, and `read` follows it.
scratch.link('alias.ts', `${scratch.path}/src/index.ts`)
scratch.read('alias.ts') // 'export {}\n'

// A link pointing out of the allocation is resolved through, so a contained path acts outside it.
const outside = createScratch({ prefix: 'outside-' })
scratch.link('gate', outside.path)
scratch.ensure('gate/made') // `${scratch.path}/gate/made` — the lexical path, not the destination
outside.names() // ['made'] — the directory was made under `outside.path`
scratch.names('gate') // ['made'] — the same entries, listed through the link

// `link` acts at the final segment rather than through it, so `gate` is occupied.
scratch.link('gate', outside.path) // throws Error: EEXIST: file already exists

// `has` reads the final segment without following it, and `read` follows it.
scratch.link('dangling', 'missing.ts')
scratch.has('dangling') // true — the link is there
scratch.read('dangling') // undefined — what it points at is not

// `remove` takes one contained entry and acts at the final segment, so a link goes and whatever it
// pointed at stays. A missing target is a no-op.
scratch.remove('dangling')
scratch.has('dangling') // false
scratch.remove('missing.ts') // no throw — there was nothing there
scratch.remove('src') // the directory and everything under it
scratch.names() // ['alias.ts', 'empty', 'gate']

scratch.destroy()
scratch.destroy() // no-op — destroy is idempotent
outside.has('made') // true — destroy unlinks `gate` and leaves what it pointed at
outside.destroy()
```

### Give everything back in one hook

Register the cleanup where you take the resource, then let one hook run all of it. The list reverses
registration order, so each handler runs while what it depends on is still standing.

```ts
import { afterEach, it } from 'vitest'
import { createTeardown } from '@orkestrel/test'

const teardown = createTeardown()

// This package registers no hook of its own, so the consumer writes this line once.
afterEach(() => teardown.destroy())

it('runs its cleanup newest-first', async () => {
	const order: string[] = []
	teardown.add(() => {
		order.push('opened first')
	})
	teardown.add(async () => {
		await Promise.resolve()
		order.push('opened second')
	})
	teardown.count // 2

	await teardown.destroy()
	order // ['opened second', 'opened first'] — reversed, and each awaited before the next
	teardown.count // 0 — the list is empty, so the hook above then runs nothing
})
```

### Answer a real request on a loopback port

```ts
import { createServer } from 'node:http'
import { createLoopback } from '@orkestrel/test/server'

// The server is yours, so every route, header, and status stays yours.
const server = createServer((_request, response) => {
	response.end('ok')
})

const loopback = await createLoopback(server)

loopback.url === `http://127.0.0.1:${loopback.port}` // true — IPv4 loopback, no trailing slash
loopback.port > 0 // true — the host picked it; this package neither picks nor reserves a number

const response = await fetch(loopback.url)
await response.text() // 'ok'

await loopback.destroy() // drops any live connection, then closes
await loopback.destroy() // undefined — destroy is idempotent
server.listening // false
```

### Refuse an escaping path in your own fixture

`readInventory` and `createScratch` refuse an escape with this predicate. Reach for it when a
fixture of your own resolves a caller-supplied path below a root.

```ts
import { createScratch, resolveContained } from '@orkestrel/test/server'

const scratch = createScratch({ files: { 'src/index.ts': 'export {}\n' } })
const root = scratch.path

resolveContained(root, 'src/index.ts') // `${root}/src/index.ts`
resolveContained(root, `${root}/src/index.ts`) // `${root}/src/index.ts` — absolute and inside
resolveContained(root, '../escape.ts') // undefined — lexically outside
resolveContained(root, `${root}/../escape.ts`) // undefined — absolute and outside
resolveContained(root, '/etc/passwd') // undefined — absolute and outside

scratch.destroy()
```

### Drive an interface the way a person does

Every verb finds its own target, so a journey names what a person names. Nothing here takes an
element, and nothing dispatches a constructed event.

```ts
import {
	clickAccessible,
	clickAccessibleWithin,
	readPerception,
	readValue,
	traverseAccessible,
	typeAccessible,
} from '@orkestrel/test/browser'

await typeAccessible('Runs', '3')
readValue('textbox', 'Runs') // '3' — the value the control renders, not the state behind it

// Role first when a bare name answers for more than one element. A tab and its own panel collide
// by construction, because the panel is labelled by the tab.
await clickAccessible('tab', 'Drafts')

// Region first when a short verb repeats, or when a rendered status completes the name.
await clickAccessibleWithin('Ledger', 'button', 'Monthly income')

// Focus arrives the way the interface offers it. Nothing calls element.focus().
await traverseAccessible('Evaluate')

readPerception('Run') // one visible named region, whitespace collapsed, hidden-but-read text kept
```

### Place a capture portfolio

The registry is declared once, the run renders one variant, and the same expansion answers both
"what should exist" and "what did".

```ts
import { createPortfolio, expandCaptures } from '@orkestrel/test/browser'

const states = ['start-empty', 'answer-ideal']
const variants = [
	{ name: 'light-1440', width: 1440, height: 1000 },
	{
		name: 'dark-390',
		width: 390,
		height: 844,
		apply: () => document.documentElement.setAttribute('data-theme', 'dark'),
	},
]

const portfolio = createPortfolio({
	states,
	variants,
	variant: 'dark-390',
	directory: '../../../tmp/capture/states',
	// This example is an enabled capture run. A real suite can supply its own gate here.
	enabled: true,
})

expandCaptures(states, variants).length // 4 — the registry times the variants
portfolio.files // the same four names, so a proof compares one expansion against the disk

// Placed from inside the journey that reached the state, right after the assertion that proves it.
await portfolio.place('start-empty')
// A run that omits `enabled` returns undefined here, resizes nothing, and records nothing.

portfolio.place('answer-partial') // rejects: Capture state "answer-partial" is not registered
```

### Practices

- **Adopt one helper at a time.** Replace a package's local recorder, then its delay, then its
  temporary directory. Nothing here re-exports another package's symbol, so each swap is
  independent.
- **Take the cleanup list before the resources.** `createTeardown` is what makes the rest of the
  owned family safe to reach for, because one hook then releases everything the test took.
- **Import by environment.** Reach for `@orkestrel/test` first; drop to `@orkestrel/test/server`
  only for the filesystem helpers, and to `@orkestrel/test/browser` only inside a browser test
  project.
- **Let the journey layer be the only door.** A journey that works around a missing helper by
  reaching for a selector is a layer defect. Add the capability here instead.
- **Keep the helper out of the assertion.** `captureError` converts a throw into a value and
  `requireValue` converts absence into a throw; the test still does the asserting.
- **Let `readInventory` refuse.** A symlinked root or an escaping target is an error, not a
  filtered result, so a misconfigured walk fails loudly instead of returning a short map.
- **Reach for `parent` only when the allocation must be somewhere named.** The default keeps it out
  of the repository, and a path inside a package tree is walked by every tool that reads that tree.

## Tests

Each entry names the rules its file proves. The test names carry the cases.

- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — rules 3, 4, and 5, plus
  `waitForDelay` against a real elapsed interval and `resolveRoot` against the calling file.
  `collect` and `collectStream` drain an empty and an ordered source, and the stream's reader lock is
  released afterwards. `roundTripJSON` carries the longest list: a copy of a flat and a nested
  interface-typed value with fresh references, a record of `unknown` values, the projection's `never`
  at an opaque `object` member and at a symbol-keyed one, the non-finite refusal at every depth and
  through `JSON.rawJSON`, the `-0` normalization, and a large array and object copied without
  exceeding the host's argument limit.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — rules 2, 10, and 12.
  `createRecorder` records typed tuples in call order, and truncates a `calls` array the test
  captured before the `clear()`. `createTeardown` takes newest-first order across synchronous and
  asynchronous handlers, a synchronous throw and an asynchronous rejection each rethrown by identity
  with every remaining handler still run, both together aggregated in run order, a handler added
  during a run kept for the next call, the count reset before the handlers run, and a `destroy()`
  that is called empty and called twice. `createHostileValues` proves all six naive-reader failures,
  frozen and fresh membership, and one total guard's benign and hostile answers with loop-index
  attribution.
- [`tests/src/browser/helpers.test.ts`](../tests/src/browser/helpers.test.ts) — rule 13 across the
  layer, in real Chromium against constructed markup. The resolver takes a bare name, a role that
  disambiguates a tab from its own panel, a name no element carries, a name carried only by a role
  outside `ACCESSIBLE_ROLES`, and the disabled, hidden, and inert matches that are present but
  gated; `resolveAccessible` takes a target scrolled into view and one fixed outside the viewport
  that stays there. Each acting verb takes its happy path and every voice it owns, including both
  region-scoped refusals and both native-disclosure ones. `traverseAccessible` takes a Tab-reachable
  target; as the cap control, a lone target whose own focus handler blurs it, so focus never lands
  and the cap fails with an empty trail; and, as the cycle control, the same self-blurring target
  behind a reachable decoy, so the traversal completes one cycle and reports the decoy in its trail.
  `contrast` takes a translucent surface composited onto the opaque layer beneath it, a fully opaque
  stack over two different ancestors as the control from outside that population, a stack where
  nothing paints, and a detached element whose computed foreground does not exist. `expandCaptures`
  takes the exact expected file list rather than a count, and both empty inputs.
- [`tests/src/browser/factories.test.ts`](../tests/src/browser/factories.test.ts) — the portfolio's
  three refusals, its disabled gate, and its one write. Creation refuses an unregistered variant
  name; a run that is not
  enabled applies nothing, writes nothing, and records nothing; an enabled run applies the variant,
  resizes the viewport, writes a real file through the provider, records it, and hands out snapshots
  rather than its own lists; and it refuses an unregistered state and a second placement of one
  state.
- [`tests/src/server/helpers.test.ts`](../tests/src/server/helpers.test.ts) — rule 6, and each pure
  leaf against its own inputs. `resolveContained` takes contained relative and absolute targets and
  both spellings of an escape. `matchesIdentity` takes a triple matching in every field and one
  differing in each. `isExcluded` takes a key, an ancestor, the root, and a sibling that only looks
  like a match. `readInventory` takes key order, extension filtering, exclusion at the named door and
  at the walked one with its spellings normalized to one rule, its four link refusals with a
  contained intermediate link as the control on the fourth, a root-level `__proto__` file, and the
  host's own case behavior probed rather than assumed.
- [`tests/src/server/factories.test.ts`](../tests/src/server/factories.test.ts) — rules 7, 8, and 11.
  `createLoopback` takes a real `fetch` answered from its own origin, a live keep-alive connection
  dropped by `destroy()` with a second server then binding the released port, a repeated `destroy()`
  handed the same promise before either call settles, ten parallel instances landing on distinct
  ports, a plain `node:net` server bound and closed, and a server already listening when it was
  handed over, refused. For `createScratch`, the ungrouped cases take the `0700` mode, nested
  seeding, the cleanup after a failed seed, the lexical refusals, the empty target's answers, and
  `has`, `write`, `read`, `names`, `ensure`, `link`, and `remove` each refused at a symbolic-link
  root and at a file root; `destroy()` is idempotent, leaves a replacement directory standing, and
  leaves a moved allocation alone. Then one group per subject.
  `destruction` takes `write`, `read`, `has`, `names`, `ensure`, `link`, and `remove` after
  `destroy()`, with `write`, `ensure`, and `link` also proven not to rebuild the allocation root, and
  `remove` proving its root and escape refusals answer before the destroyed-allocation one.
  `names` takes its sorted output, including the population that discriminates a dropped `.sort()`.
  `ensure` takes an empty directory, every missing parent, and a repeated call. `link` takes
  traversal through a planted link, the final segment `has` reports rather than follows, and the
  `EEXIST` an occupied final segment throws. `remove` takes eleven cases: a file beside a kept
  sibling, an empty directory, a populated subtree, a missing target, an ancestor link back to the
  allocation with every seeded file read back afterwards, a final link whose destination is read back
  afterwards, a sibling directory reached through that same ancestor link, an escaping target with
  the file outside left intact, the root refused in all three spellings, a foreign directory swapped
  onto the allocated path that `remove('')` refuses, and that same swap under `destroy()`, which
  removes nothing either. `parent` and `prefix` take their own refusals.
- [`tests/guides.test.ts`](../tests/guides.test.ts) — rule 1: the `## Surface` ↔ source bijection,
  the barrel ↔ source bijection, the behavioral-interface ↔ `## Methods` bijection and each group's
  members, the fence imports, and link resolution for this guide.

## See also

- [`README.md`](README.md) — the guides index.
- `AGENTS.md` at the workspace root — the rules this package's own source and tests follow.
