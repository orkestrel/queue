// ── Environment-agnostic base setup ───────────────────────────────────────────
//
// Loaded first by every test project (`vite.config.ts` `setupFiles[0]`). Holds ONLY
// helpers with no `node:*` / DOM dependency, so it is safe for `src:core` alike.
//
// This package repeats none of the fleet-wide helpers: they live in `@orkestrel/test`
// and every suite imports them from there. The emitter recorder bundles this module
// used to declare are `createRecorders` and `RecorderMap` in that package.
