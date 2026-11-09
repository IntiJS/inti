---
name: fix-package
description: >-
  Change an existing package of this monorepo safely: a bug fix, a new option or export, a
  rename. Use when the user asks to fix, change, extend or refactor anything under
  packages/<name>/ (core, an adapter, genui, cloudflare, cli, mcp, create-inti), or reports a
  bug in one of them.
---

# Fix or change a package

1. **Read first.** `AGENTS.md` (setup, constraints, import paths), the package's `README.md`, its
   `src/` and its `tests/`. For an adapter also its page under `apps/docs/src/content/docs/adapters/`.
2. **Reproduce.** For a bug, write a `bun:test` test in `packages/<name>/tests/` that fails before
   changing code. If the behaviour is listed in `tests.feature` / `tests.json`, keep its
   `verifiedBy` path true (`packages/core/tests/specs.test.ts` checks it).
3. **Rules that must hold.**
   - No package imports or depends on `@intijs/ee`, the planned commercial add-on that lives
     elsewhere (`packages/core/tests/ee-boundary.test.ts`).
   - CMS credentials and model keys stay server-only; nothing reads them with a `PUBLIC_` prefix.
   - Writes return `{ success: false, error }` instead of throwing and refuse `__proto__`,
     `constructor` and `prototype` in a field path. Filtering blocks never renumbers `meta.index`:
     the editor addresses every write by it.
   - In production, writes are refused unless a plugin with `resolveActor` / `beforeWrite` decides
     who is editing. Do not add a path around it.
   - Editors compose from declared block types only: no free-form CSS or HTML.
   - No backwards-compatibility shims: change the code and its callers.
4. **Build order.** A package compiles against the `dist/` of the ones it depends on: core →
   genui → cloudflare → cli → adapters → mcp (`npm run build`). After changing core, rebuild
   it before testing anything that imports it.
5. **Docs stay true.** Update the package `README.md`, `AGENTS.md` (import paths, naming, setup),
   `README.md`, `llms.txt` and the docs site in the same change, in English. Add a
   `CHANGELOG.md` entry if users will notice it.
6. **Check.**
   ```bash
   npm run build:core && npm run build -w <package name>
   bun test packages/<name>
   npm test
   ```
   Then the end-to-end check that covers the area, if any: `node scripts/astro-compat.mjs <5|6|7>`
   (setup, core), `node scripts/create-inti-check.mjs` (create-inti), `npm run test:genui`,
   `npm run test:cloudflare`, `npm run test:wordpress` or `npm run test:kitsuden` (Docker). Under
   load, rerun a failing file alone before concluding it is broken.

Report what changed and any check you could not run. Do not commit unless the user asks.
