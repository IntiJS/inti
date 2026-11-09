---
name: new-adapter
description: >-
  Add a CMS adapter to this repository, from package scaffold to passing tests and true docs.
  Use when the user asks to "add an adapter", "support <CMS>", "write @intijs/adapter-<cms>",
  or to make a read-only adapter (Contentful, Sanity) write back.
---

# New adapter

Read `AGENTS.md` first ("Writing an adapter", "Naming convention", "Drafts and undo"), then
`packages/core/src/adapters/index.ts` (`IntiAdapter`, `WritableAdapter`, `DraftableAdapter`,
`ListableAdapter`, `SearchableAdapter` and their `is*Adapter` guards) and the existing adapter
closest to the new CMS:

| The CMS stores a page's blocks as | Copy the shape of |
|---|---|
| One array field on the page (repeater, dynamic zone) | `packages/adapter-strapi`, `packages/adapter-wordpress` |
| One row per block, with its own id | `packages/adapter-kitsuden` |
| Files in a folder or a git repository | `packages/adapter-keystatic` |
| Read only | `packages/adapter-contentful`, `packages/adapter-sanity` |

1. **Package.** Create `packages/adapter-<cms>/` with the same files as
   `packages/adapter-strapi`: `package.json` (name `@intijs/adapter-<cms>`, version `0.1.0`, the
   same `scripts`, `files`, `repository.directory`, `publishConfig`, and `@intijs/core` as a
   **peer** dependency `^0.1.0`), `tsconfig.json`, `LICENSE` (MIT), `README.md`, `src/index.ts`,
   `tests/`. `dist/` is never committed.
2. **Read.** `export class <Cms>Adapter extends IntiAdapter<RawPage>`; implement `parsePage` and
   `fetchPageBySlug`. Map the native identifier to the Inti block type and keep
   `meta.documentId` and `meta.index`: the editor addresses every write by them. Hidden or
   scheduled blocks go into `meta.visible`, `visibleFrom`, `visibleUntil`; filtering never
   renumbers `meta.index`. Normalize SEO into `page.seo` (see `packages/adapter-strapi/src/seo.ts`).
   Implement `introspect()` if the CMS publishes its schema: `inti sync` generates types from it.
3. **Write (optional).** `implements WritableAdapter`, `readonly writable = true as const`,
   `updateBlockField(documentId, blockIndex, field, value)`: `blockIndex` `-1` is a page-level
   field, `field` is a dot-path, and `__proto__`, `constructor` and `prototype` segments are
   refused in the adapter too (the action and the MCP tool check them, but direct callers do
   not; see `packages/adapter-kitsuden/src/index.ts`). Return `{ success: false, error }` instead of throwing. Add `updateBlock`,
   `moveBlock`, `insertBlock(s)`, `removeBlock`, `duplicateBlock`, `DraftableAdapter` and
   `ListableAdapter` only where the CMS API supports them; the MCP server advertises only what
   the adapter implements. Credentials are read on the server only, never `PUBLIC_*`.
4. **Wiring.** `resolveAdapter` already imports `@intijs/adapter-<name>` for `INTI_ADAPTER=<name>`.
   For `INTI_<CMS>_*` variables add a `case` in `packages/core/src/server/write-adapter.ts`
   (otherwise it gets the generic `INTI_ENDPOINT` / `INTI_TOKEN`) and document them in
   `.env.example`. Add `build:adapter-<cms>` to the root `package.json` and to `build:adapters`.
   A `create-inti` option (`packages/create-inti/lib/generate.js` and its tests) is a separate step:
   ask before adding it.
5. **Tests.** `tests/*.test.ts` with `bun:test`, mocking `fetch` with fixtures of the CMS's
   real responses (see `packages/adapter-strapi/tests/write-back.test.ts`): parsing, naming,
   every write method, a refused write, and a prototype-polluting path.
6. **Docs, in English.** The package `README.md`; `apps/docs/src/content/docs/adapters/<cms>.mdx`;
   the adapter and package tables in `README.md`; the naming table, import paths and repository
   layout in `AGENTS.md`; `llms.txt`; an entry in `CHANGELOG.md`. Say read-only if it is.
7. **Check.**
   ```bash
   npm run build:core && npm run build -w @intijs/adapter-<cms>
   bun test packages/adapter-<cms>
   npm test
   npm run build
   ```

Never write a CMS token into a file, a fixture or a test. Do not commit unless the user asks.
