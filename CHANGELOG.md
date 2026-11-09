# Changelog

All notable changes to Inti.js will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — beta

First public release. Inti is in beta: its APIs may still change before 1.0.

### Everything in the repository is MIT

- **New `@intijs/core/team`.** Shared block patterns (`createMemoryPatternStore`, `createFilePatternStore`, `createCustomPatternStore`, `restrictPatternWrites`) and the multi-instance realtime backplane (`createValkeyBackplane`) moved here from `@intijs/ee`. Register them with `getPatternStore` and `getRealtimeBackplane` on any plugin; no license is involved.
- **`@intijs/ee` left this repository.** Roles, the audit log and SSO are kept for a future commercial add-on in a separate repository. Nothing here imports or depends on it (`packages/core/tests/ee-boundary.test.ts`), and every package in this repository is checked to be MIT.

### Kitsuden: the contract is English (needs Kitsuden 0.9)

Breaking for game pages. `@intijs/adapter-kitsuden` speaks the `games` and `games-editorial` contracts **v2** (`SUPPORTED_CONTRACTS`: `page-builder` 1, `games` 2, `games-editorial` 2), so it writes to game pages of Kitsuden 0.9 or later only; against 0.8 those writes stop with `KitsudenIncompatibleError` before anything is written, and page-builder writes keep working.

- Editorial layer keys: `titulo` → `title`, `descripcion` → `description`, `oculto` → `hidden`, `orden` → `order`. `updateBlockField` / `updateBlock` on a game block edit `title` and `description`; `removeBlock` sends `{ hidden: true }`. The adapter writes English only; reads still accept a 0.8 key when the English one is absent, so an un-migrated game row hides and sorts like its site.
- Routes: `PATCH /api/games/:id/blocks/:blockId/editorial` and `PUT /api/games/:id/blocks/order` (were `/bloques/:bloqueId/editorial` and `/bloques/orden`).
- `GET /api/version` is read as `{ product, version, contracts }`; the 0.8 names `producto` and `contratos` are still accepted. `KitsudenVersionResponse` uses the English names.
- Renamed exports: `CONTRATOS_ADMITIDOS` → `SUPPORTED_CONTRACTS`, `ContratoDeKitsuden` → `KitsudenContract`, `KON_DE_CONTRATO` → `CONTRACT_KON`, `VERSION_DEL_ADAPTADOR` → `ADAPTER_VERSION`, `PREFIJO_JUEGO` → `GAME_PREFIX`, `esDocumentoDeJuego` → `isGameDocument`, `bloquesDeJuegoVisibles` → `visibleGameBlocks`, `ERROR_CREAR_BLOQUE_DE_JUEGO` → `GAME_BLOCK_INSERT_ERROR`, `VocabularioDeKitsuden` → `KitsudenVocabulary`. `KitsudenGameEditorial` has `title`, `description`, `hidden`, `order`.
- The contract fixture is `packages/adapter-kitsuden/tests/contract/reference-responses.json` (`{ kitsuden, contracts, cases: [{ name, contract, template, method, path, request, status, body }] }`), a copy of Kitsuden's `packages/shared/contracts/inti/reference-responses.json`; its tests are `contract.test.ts` and `compatibility.test.ts`. The agent scope is `content:edit`.

### Kitsuden: drafts, references, and a real instance

`scripts/kitsuden-check.mjs` runs a disposable Kitsuden in Docker and walks every page write, reading results back from the API, and compares real responses with the contract fixture. Drafts use `POST /pages/:id/clone`; publishing keeps the page's id, slug and homepage flag. The API returns hidden and scheduled blocks to nobody, not even with a token, so publishing leaves them where they were.

The generation vocabulary now carries rich text, objects, lists and numeric limits. Media fields are omitted unless a source is given, including strings like `mediaId`, so a model cannot invent an image id; link fields are validated as URLs. The contract test looks for the canonical fixture in `../kitsuden` as well as `../cms`.

### `@intijs/adapter-keystatic`

Edit Keystatic content on the page, in a local folder or through GitHub, where each edit is a commit and a conflicting change is rejected. Keystatic has no write API, so it writes the files directly; its tests read every write back with the official reader. Also `npm create inti -- --cms keystatic`.

### `@intijs/cloudflare`, optional

D1 for content, measurement, patterns and the composition cache; Durable Objects for editing rooms over hibernating WebSockets and for limits shared between instances; R2 for media, checked by their bytes; Workers AI as a provider; Image Transformations for `<IntiImage>`. `scripts/cloudflare-check.mjs` runs a real project in `workerd`. Core gained the `getWriteAdapter` plugin hook, because a Worker cannot resolve an adapter by name, and `registerImageService`. `createVisitorComposer` gained `limiter` and `cache`.

### Field paths can no longer reach `Object.prototype`

`updateBlockField` and the MCP tool reject `__proto__`, `constructor` and `prototype` in a dot-path. A write with such a path would have polluted the prototype in adapters that walk the path.

### Tested against a real WordPress, which found real bugs

`scripts/wordpress-check.mjs` runs WordPress in Docker with Flexible Content (Secure Custom Fields, which implements the ACF API) and walks every write, plus a `create-inti` project in production. The fetch-mocked tests had hidden all of this:

- **Any page with an image could not be saved.** ACF reads images and relations as objects and only accepts ids on write, and saving one field resends the whole array, so WordPress answered 400. `normalizeAcfForWrite` converts them using the schema WordPress itself publishes.
- **`inti-bridge` wrote to the wrong repeater row**, rejected `cta.label`, and reported success for a field that does not exist. It now resolves the exact meta name from the ACF definition. The adapter detects the plugin on its own, so this hit anyone who installed it.
- **The first save after a pause failed** with "fetch failed": Apache closes idle connections after 5 s. Connection drops are retried once; writes send final state, so this is safe.
- **Projects from `create-inti` answered 404 on every page** when the CMS variables arrived at startup (Docker, most platforms) instead of at build. Generated code now reads them with `env()`.

### Drafts and undo

Edit a working copy that visitors cannot see, then publish or discard it (`DraftableAdapter`, `readDraftPage`, implemented for WordPress and the local store). Text edits can be undone with the toast button or Ctrl/Cmd+Z.

### `@intijs/genui`: generative UI, MIT

The schema, validation and generator moved here from `@intijs/ee`, which re-exports them and keeps roles and audit. New: rich fields (`richtext`, `url`, `list`, `object`, `media`, `relation`), `fromData` references so a price never comes from the model, content validation (URL schemes, rebuilt rich text), block-by-block streaming, and `createVisitorComposer` for use during a visit. The default model is now `claude-opus-5-5`, with server-side refusal fallbacks.

The editor's composer used to send block types without their fields, so a generated block could only ever be empty. It now sends them and previews proposals on the page with the real components (`/api/inti/generate`, `/api/inti/preview`). Nothing is written until the editor accepts.

### Personalization, with or without AI

`adaptPage` picks between versions of a zone declared with `inti_slot` and `inti_audience`, on the server and with no JavaScript. Rules, visitor preferences, consent-gated behaviour, a stable control group, `computeLift`, "view as" for editors, and `getDeciders` / `getExperimentStore` plugin hooks. Crawlers always get the default.

### MCP: drafts, batches and a vocabulary

`inti_insert_blocks`, `inti_create_draft`, `inti_publish_draft`, `inti_discard_draft`, and `inti_get_vocabulary` with `INTI_MCP_VOCABULARY`, which also validates what an agent inserts. Now tested end to end over stdio with the official client. MCP writes do not pass through `beforeWrite` plugins; the documentation said otherwise.

### Installed from git, the build no longer dies on the `#` in pnpm's folder name

Installed with `#<commit>&path:/packages/core`, pnpm stores the package in a folder whose name contains `#`. Astro turns the entrypoints that the integration injects (`/api/inti/search`, `/api/inti/sync`) into paths and parses them as URLs, so the `#` was read as a fragment and `astro build` failed with ENOENT on a truncated path. When the resolved path contains `#`, the integration now writes a one-line re-export of each route into `<root>/.astro/inti/` and injects that file instead (`routeEntry()` in `packages/core/src/integration/index.ts`). Found by building the Kitsuden starter with `INTI=true` against Inti installed from git.

### The Kitsuden adapter says which kon is off

When `/api/version` does not declare a contract the write needs, the usual cause is that the kon serving it is disabled (Kitsuden only announces the contracts of mounted kons). The error now names that kon (`CONTRACT_KON`: `kon-blocks` for `page-builder`, `kon-games` for `games` and `games-editorial`) instead of only asking to update Kitsuden. Kitsuden checks that both sides map contracts to the same kons.

### A refused write answers 403, not 500

Astro turns any plain `Error` thrown by an action handler into a 500. A write refused by the default production rule or by a `beforeWrite` plugin (for example an anonymous write against the Kitsuden starter) therefore reached the editor as "server error". The write actions now throw `ActionError` with code `FORBIDDEN`, so the response is `403` with the plugin's reason. `checkWriteAccess()` (`@intijs/core/server`) returns the decision without throwing; `assertWriteAccess()` is unchanged for CLI/MCP. Covered by `packages/core/tests/actions-forbidden.test.ts`.

### Installable from git

`dist/` is still not committed. Every publishable package has a `prepare` script (`scripts/prepare-package.mjs`) that compiles it when pnpm installs it from git with `#<commit>&path:/packages/<name>`, building `@intijs/core` first for the adapters. It does nothing during `npm install` at the monorepo root (`npm run build` builds in order there) or with `INTI_SKIP_PREPARE=1`. See README → Installation.

### Repository metadata

Every `package.json` has `author`, `homepage`, `repository` and `bugs` pointing at `github.com/intijs/inti`. The README presents Inti as a generic layer with WordPress and Kitsuden as first-class adapters, adds a "With Kitsuden" section and states which code is MIT and which is not (`packages/ee`); `packages/core/tests/ee-boundary.test.ts` fails if an MIT package imports or depends on `@intijs/ee`.

### Packages are published under `@intijs`

The `@inti` scope on npm is registered to someone else (it exists with no public packages), so `@inti/*` could not be published. Every package, import and document now uses `@intijs/*` — `@intijs/core`, `@intijs/adapter-wordpress`, and so on. The scaffolder keeps its unscoped name: `npm create inti`.

### `npm create inti` works

The previous scaffolder could not produce a working project in any combination. It offered three templates that did not exist (`blog`, `ecommerce`, `torneo`), adapters that did not exist (`@inti/adapter-gremius`, removed; `@inti/realtime`, never written), and its only real template imported a `ContentAdapter` that `@intijs/core` does not export, so the page crashed on load. It offered neither WordPress nor Kitsuden, generated no Astro adapter, actions, block registry or `BlockRenderer`, and answered "yes" to overwriting a non-empty directory by deleting it.

It was rewritten from AGENTS.md. It asks for the CMS —WordPress, Kitsuden, Strapi, or none— and generates the documented setup with a starter block named the way that CMS names it. With no CMS it ships sample content that can be edited immediately. It runs without prompts (`--cms`, `--yes`, `--no-install`) when there is no terminal, and it never deletes anything: a non-empty target directory is an error.

`scripts/create-inti-check.mjs`, now a CI job, runs it from its packed tarball for every CMS and builds each project. For the local store it goes all the way: in dev the page loads with the editor and an edit reaches disk; in production the visitor gets no JavaScript and no editor, a missing page is a `404`, and an anonymous write is refused.

Running it end to end surfaced two bugs on the way:

- **`LocalAdapter` dropped the stored `seo`.** A page with its own title and description was published with the page title and no meta description.
- **The Strapi adapter had no way to read a page** — only to parse one. The quickstart said "the same flow works for Strapi", but there was nothing to call. It now has `fetchPageBySlug`, like WordPress and the local store.

### The documented setup did not build

AGENTS.md, the quickstart, the README and the deployment guide configured Astro without `output: 'server'`. With the default static output, the documented `[...slug].astro` route fails with `GetStaticPathsRequired`. The compatibility matrix did not catch it because its fixture differed from the docs — it set `output: 'server'` and used `index.astro`. Every documented config now sets it, the quickstart explains why, and the matrix fixture uses the documented route.

### Security

- **Write actions now fail closed in production.** Astro actions are public HTTP endpoints, so they exist in production whether or not the editor UI is shown — hiding the UI (which Inti already did outside development) never closed the endpoint. A `POST /_actions/inti.updateBlockField` could therefore rewrite the CMS using the server's credentials, and Astro's `security.checkOrigin` does not prevent this: it stops cross-site requests from a browser, not direct calls that set their own `Origin`.

  Outside development, if no registered plugin declares `beforeWrite` or `resolveActor`, every write action is now rejected with an error explaining how to fix it. This covers `updateBlockField`, `updateBlock`, `moveBlock`, `insertBlock`, `insertBlocks`, `removeBlock`, `duplicateBlock`, the pattern actions, and `generateBlocks` (which spends the operator's own AI credits).

  The condition is *"someone is deciding"*, not *"someone is authenticated"* — a `beforeWrite` that deliberately allows anonymous writes is a legitimate configuration and is not overridden. An unrecognised environment counts as production. Set `INTI_ALLOW_ANONYMOUS_WRITES=1` to opt out explicitly; it logs a warning. See [Securing writes](https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/guides/securing-writes.md).

  Development behaviour is unchanged.

- **The editor and the realtime channel require an editor session in production.** `/api/inti/sync` accepted unauthenticated `GET` and `POST`, so anyone could listen to edits in progress or push fake changes to connected editors; `/api/inti/search` queried the CMS with the server's credentials. Both now return `401` without a session, and `POST /api/inti/sync` only accepts `application/json`. `VisualBridgeAuto`/`InlineEditor` with `enabled={true}` and `BlockRenderer` with `editable={true}` no longer ship the editor (toolbar, panels, embedded block JSON, hidden blocks) to visitors without a session, and never into prerendered HTML.

  A session exists when a `resolveActor` plugin returns an actor (called with the new `operation: 'session'`) or `INTI_ALLOW_ANONYMOUS_WRITES=1` is set. A `beforeWrite`-only plugin is not enough here. The rule is exported as `resolveEditorSession` from `@intijs/core/server`. Development behaviour is unchanged.

- **Editor sessions now actually open in production.** Verified against a built server, the rule above denied *every* request, editors included, for two independent reasons. It failed closed, so nothing leaked, but no editor could use Inti on a published site — not even through `@intijs/ee`'s SSO.
  - **The plugin registry existed twice.** Users register through `@intijs/core/plugins`, which resolves to `dist/`; the `.astro` components and injected routes load from `src/` and import the registry by relative path. Each copy had its own array, and the built server bundle contained two `plugins = []`: the session check read the empty one. The registry now lives on `globalThis`, as the component registry already did. The same split meant `@intijs/ee`'s Valkey backplane never reached `/api/inti/sync`.
  - **Plugins were documented in `src/actions/index.ts`, which Astro loads lazily** — on the first action request. Until then no plugin exists, so the editor never renders, and without the editor nobody can trigger that first action. Writes were unaffected (the action loads the module before running). Plugins now go in `src/middleware.ts`, which loads before any request; the security guide, AGENTS.md and the `@intijs/ee` README say so, and Inti logs a one-time warning in production when an editor session is requested and no plugin declares `resolveActor`.

  Verified on a production build: with the plugin in middleware, the very first request from an editor gets the editor and a `200` from `/api/inti/search`, while an anonymous visitor gets neither and a `401`.

### Fixed — The editor, verified end to end in a browser

Until this release the full editing loop —double-click, edit, Enter, Astro action, adapter, disk— had never been run in a real browser. Doing so turned up the following, each reproduced before being fixed.

- **`astro dev` showed Vite's full-screen error overlay on top of every page.** The integration registered a dev toolbar app with `entrypoint: './visual-bridge/dev-toolbar.js'`, a file that does not exist, as a relative path Vite cannot resolve from the toolbar's virtual module. The overlay swallowed every click, so inline editing —which only runs in dev— was unusable in any project using `inti()`. Nothing caught it because the compatibility matrix only ran `astro build`. The registration is gone; the editor has its own UI.

- **Editing a nested block's text overwrote the parent's field.** Field binding walked every block wrapper in document order and the first binding won, so a field inside a nested `BlockRenderer` was bound to the *outer* block. Editing a child card's `title` sent `{"documentId":"home","blockIndex":0,"field":"title","value":"…"}` — the child's text written into the parent's `title`, reported as saved. Confirmed by removing the fix and capturing the request. Fields now bind to their closest wrapper, and wrappers with no CMS document are not offered for editing at all, rather than opening an edit mode that can never save.

- **A selected block could no longer be edited.** The selection highlight sits on top of the block and declares `pointer-events: none`, but `#inti-visual-bridge > * { pointer-events: auto }` wins on specificity, so after clicking a block its highlight swallowed the double-click on its own fields. This is why editing seemed to work only sometimes, depending on click order.

- **With no CMS configured, the editor never appeared** — so the "try it before connecting anything" flow in the quickstart did not work. The bridge required an admin URL or endpoint, which the local store does not have. Separately, whether inline editing was offered came from a hard-coded list of CMS names that left out Kitsuden entirely. Both now derive from the server-side write adapter: if it can write, editing is offered. With neither `INTI_ADAPTER` nor `inti.config.ts`, the bridge now assumes the local store, as the server already did — before, that case still left the editor off.

- **Every page load in the canonical setup reported "✕ The page has no title".** Without the `page` prop, `BlockRenderer` audited a page with no title. It now skips metadata checks when it was not given the page — an unknown title is not a missing one, and a false error teaches people to ignore the audit.

- **`clientDirective` in the registry never had an effect, and cannot.** Astro only hydrates statically imported components; applying `client:*` to one loaded with `import()` fails with `NoMatchingImport` (verified on Astro 7). The option is deprecated and `BlockRenderer` now warns with the exact fix: put the directive inside the block, on a static import — verified to produce a real island even when the block itself is lazy-loaded.

- **`import { defineConfig } from '@intijs/core'` returned `undefined`.** It was only exported from `@intijs/core/index`. Because `VisualBridgeAuto` loads `inti.config.ts` inside a try/catch, the whole file was silently ignored. It is now exported from the package root through a dependency-free module. `integration.d.ts` had also drifted from `integration.js` (it did not declare `intiStyles` or the integration's options) and now re-exports the generated declarations instead of being maintained by hand.

- **A block palette could not be combined with `VisualBridgeAuto`.** The editor reads only the first `InlineEditor` on the page, which was the bridge's own, palette-less one. `VisualBridgeAuto` now takes `blockTypes`. Passing `options.features` also no longer drops every other default feature.

### Changed — Types instead of a fetch SDK, and no dead weight for visitors

- **`inti sync` no longer generates `inti-sdk.ts`.** Its functions requested `${endpoint}/api/<collection>` with a Bearer token, an API none of the supported CMSs have, so they could not work against WordPress, Kitsuden or Strapi. Content is read with the adapter. If an old `inti-sdk.ts` sits in the output directory, `sync` warns instead of deleting a user file.
- **The generated `inti.types.ts` did not compile.** Any `media` field produced a reference to `MediaAsset`, which the file neither declared nor imported — and every Kitsuden page has one (`ogImageId`), so it failed for every Kitsuden project. The generator's tests asserted the broken output literally (`coverImage?: MediaAsset`), which is why it went unnoticed. They now compile the generated file with `tsc --strict` and also check that the compiler *rejects* what it should. Dates were typed `Date` although they arrive as ISO strings, so `date.getTime()` compiled and crashed at runtime: they are now `string`. Media is `IntiMedia`, an id or an object, which is what CMSs actually return.
- **`IntiTypedBlock`**: a union of a page's blocks discriminated by `type`. Narrowing on `block.type` types `block.data`; a field from another block type, or a `type` the CMS does not have, is a compile error. Collections carry a new `blockType` with the `IntiBlock.type` the adapter assigns, since a collection's TypeScript name cannot be mapped back. Kitsuden describes its whole palette; WordPress now describes the Flexible Content layouts present in its sample page, honouring `blockTypeMap` — before, it only described post types, so no WordPress block could be typed.
- **The schema cache mixed up WordPress sites.** Its key was `adapter + introspectionEndpoint`, and adapters configured through `endpoint` all landed on `WordPress:default`: two sites in one process —the MCP server pointed at several, a multi-site build— got the first one's schema for five minutes. The key now covers the full configuration.
- **Removed the multi-framework islands system.** It could not work for anyone: its renderer was not exported, the browser looked components up in a registry that only ever existed on the server, and the server rendered a loading spinner instead of the content. Astro's own `client:*`, placed inside a block, does this — see the directives guide.
- **Visitors now receive no JavaScript from Inti.** The integration injected two scripts into every page: a "shared state manager" nothing read, and a `console.log` for localhost. Together they were all the JS on a page without the editor — 657 bytes to every visitor, doing nothing. The `visualBridge` integration option only controlled them and is deprecated; it never disabled the editor (`<VisualBridgeAuto enabled={false} />` does).
- **Tailwind 4 was not detected.** `intiStyles()` looked for a `tailwind.config.*`, which Tailwind 4 —the current major— does not have, so it switched UnoCSS on alongside Tailwind. It now also checks the dependencies, and gives the version-appropriate hint for including Inti's components (`@source` on v4).
- **The specs at the repository root describe what Inti does**, and cannot drift again. `tests.feature` and `tests.json` described a fetch SDK, `Bun.serve()`, WebSocket previews and client directives set from the registry — none of which exist. Every scenario now names the test that verifies it, `tests.json` scenarios with `testLogic` are executed as written, and `packages/core/tests/specs.test.ts` fails on a missing verification, a path that does not exist or a `testLogic` that does not hold.
- **The compatibility matrix now checks production too.** After building and running `astro dev`, it starts the production server and asserts what a visitor gets: no module scripts, nothing from the editor, hidden blocks and unregistered blocks absent, images with `srcset`, and `401` from `/api/inti/search`. Re-injecting a page script makes it fail.

### Added — Images

- **Responsive images now work with no configuration.** `IntiImage` only produced a `srcset` when `configureImageService()` had been pointed at an external transformation endpoint; `getImageService()` throws otherwise, the component caught it, and the result was a plain `<img>` serving the original at every screen size — no `srcset`, no modern format. On a product grid that outweighs all the JavaScript on the page.

  With no service configured it now delegates to Astro's built-in `astro:assets`, which generates the `srcset` and converts to WebP. Verified end-to-end against Astro 7: four candidates with proportional heights, `f=webp`, `sizes` honoured, dimensions on the tag, and `fetchpriority="high"` on the first block. A configured `ImageService` still takes precedence, so existing setups are unchanged.

  `responsive` now defaults to `true`. Candidate widths are capped at the source width — a candidate larger than the original adds bytes, not sharpness — and when no dimensions are declared, `inferSize` reads them from the source instead of assuming 800×600, which was itself a cause of the layout shift the component exists to prevent.

  A remote CMS image needs its domain in `image.domains` or `image.remotePatterns`. When it is missing, Astro refuses and Inti now warns in dev with the exact config line and the domain in question, because Astro's own error does not say where the URL came from.

- `IntiImage.astro` was not reachable from any package export: the exports map had `./astro/*` and `./visual-bridge/*` but no `./image/*`, so the documented component could not be imported. Added `@intijs/core/image/*`. The compatibility matrix now renders an `IntiImage` on all three Astro majors, so this stays covered.

### Added — Kitsuden

- **Scheduled block visibility is now honoured.** Kitsuden rows carry `isVisible`, `visibleFrom` and `visibleUntil`, and they were typed but never read: a block hidden in the CMS, or scheduled for next week, rendered anyway — and therefore reached the HTML, the structured data, `llms.txt` and the search index. Publishing a promotion before its date is not a layout glitch; it is a commercial promise the client had not made yet.

  Adapters normalise visibility into `meta` (`visible`, `visibleFrom`, `visibleUntil`) and `BlockRenderer` filters on it in production while still rendering hidden blocks in the editor, marked `data-inti-block-hidden` — a block you cannot see is a block you cannot switch back on. `@intijs/core/blocks` exports `isBlockVisible`, `visibleBlocks`, `hiddenBlocks` and `hiddenReason` to apply the same rule elsewhere.

  Filtering never renumbers `meta.index`: that index is how the editor and the actions address a block in the CMS, so renumbering would make an edit after a hidden block land on the wrong one. An unparseable date is ignored rather than treated as a constraint — hiding live content over a malformed field is a worse regression than showing it, and `visible` remains the authoritative switch.

- **Blocks are ordered by `sortOrder`.** `parsePage` used array order, and so did the write path that resolves an index to a row. Both were wrong in the same way, which is why nothing had broken yet: order came down to whatever the API happened to return. Both now sort, together — sorting only one would have made editing block N write to a different block, with no error and a "saved" toast. There is a test asserting that `parsePage`'s index and the write path's index resolve to the same row id.

- **`generatorBlockTypes()`** maps the native palette (`GET /block-types`, which ships field schemas) into the vocabulary EE's AI generation expects. This is the practical advantage over WordPress, where the vocabulary has to be inferred from ACF: here the CMS declares it, so the model has less room to invent. `media`, `relation`, `date` and `datetime` fields are deliberately dropped — an invented media id is a broken reference, and a date is an editorial decision — and `enum` fields with options become closed variants, which compile to a JSON Schema enum. Reuses the existing palette cache.

- **The composer could insert block types Kitsuden rejects.** `meta.label` carried the row's display name (`"Cover"`) where WordPress puts the native identifier (`hero_banner`); the composer offers the blocks it sees on the page using `label` as the native type, so inserting one failed with *"not in this CMS palette"*. It now carries the native `type`.

- **Kitsuden has its own environment variables**, `INTI_KITSUDEN_ENDPOINT`, `INTI_KITSUDEN_TOKEN` and optional `_MOUNT_PATH` / `_STATUS` / `_MEDIA_PRESET`, like WordPress and Strapi. Before, the write path only read the generic `INTI_ENDPOINT` / `INTI_TOKEN` (still accepted), while the documentation used three other spellings — so a site configured from the docs rendered but could not save.

### Added — CI

- **Astro compatibility is now enforced, not asserted.** `@intijs/core` declares `astro: ^5 || ^6 || ^7` in `peerDependencies`, but that was verified once by hand — a claim nothing checks breaks silently. `scripts/astro-compat.mjs` packs the workspace with `npm pack`, installs it into a clean project outside the monorepo, and builds the full setup from AGENTS.md (integration, `astro:actions`, `registerBlocks`, `BlockRenderer`, `VisualBridgeAuto`, `IntiSeo`, `IntiStructuredData`, the WordPress adapter). CI runs it as a matrix over Astro 5, 6 and 7; `npm run test:astro-compat 7` runs it locally.

  Installing by `file:` would not work: npm links the packages back to the monorepo and the project resolves `astro` from the root instead of the major under test. The Node adapter is pinned per major (5→`@9`, 6→`@10`, 7→`@11`) because npm does not backtrack across majors to satisfy its peer range.

  All three majors build today. Astro 7.3.8 is the current latest; the repo develops on 5.17.3.

- **The matrix now runs `astro dev` too.** After building, it starts the dev server, loads the page and walks the module graph the browser would request — static and dynamic imports — failing on any response ≥ 400 or any "Internal server error" in the log. Re-introducing the broken dev toolbar app makes it fail with `500 /@id/__x00__astro:toolbar:internal`, which is the check this release needed. On Windows the project now lives at its real path: `tmpdir()` returns the 8.3 short form, and with the root in that form Vite never served `/@vite/client`.

- The fixture imports `inti.config.ts` with `defineConfig` from the package root, so losing that export breaks the build instead of being silently ignored.

### Changed — Documentation and repository

- **The docs homepage told readers to run `curl -fsSL https://inti.new | bash`.** That domain is not registered: anyone could have bought it and served a script to every reader who copied the command. The homepage now installs exactly as the quickstart does, and was rewritten around the product — the visual editing layer — which it previously did not mention.
- **Eight examples across seven pages used `<BlockRenderer block={block} />`.** The component takes `blocks` (an array); copying any of them crashed the page. Several pages also taught writing a local `BlockRenderer`, which lacks the wrappers the editor needs, the audit and visibility filtering. The `BlockRenderer` reference was rewritten from the actual component, including how to render nested content so it stays editable.
- Documented features that do not exist were removed: `sync` flags (`--force`, `--watch`, `--types-only`, `--sdk-only`, `--output`, `--verbose`), a schema cache with `--offline`, `beforeSync`/`afterSync` hooks, and `IntiConfig.codegen`. The only flag, `--config`, was advertised by the CLI's own help but never read; it now is.
- `inti sync` generates `inti.types.ts`, not `inti.d.ts` as every page said.
- `installation` and `configuration` no longer describe the pre-adapter setup. `configuration` now covers what the quickstart links it for — the block palette, variants and patterns — and the `inti.config.ts` fields that something actually reads.
- The "Content Layer 2.0" page and tagline, and the "Content Mesh" overview, described a positioning the project left behind. Removed or rewritten.
- **Root `Dockerfile` and `docker-compose.yml` deployed an app that no longer exists**, and with no `.dockerignore` they would have copied a stale `dist/` into the image. Replaced by a deployment guide whose Dockerfile was built and run against a real Inti project on Astro 7: the page serves, `<IntiImage>` emits WebP `srcset`, `sharp` works in the container, anonymous writes are refused and the process does not run as root.
- Removed the leftovers of the project's previous incarnation at the repository root — `src/` (including an old adapter and duplicate copies of `BlockRenderer.astro`), `astro.config.mjs`, `server.ts`, `tsconfig.json` — none of which anything referenced, plus a `bun.lock` that diverged from the npm lockfile CI uses.

### Added — Commerce SEO

- **`Product` structured data with offers.** `type: 'Product'` was accepted by `buildStructuredData` but the builder emitted no commerce fields at all — no `offers`, `price`, `availability`, `sku`, `brand`, or `aggregateRating`. Google requires `offers` (with price, currency, and availability) or a rating for Product rich results, so the option produced output that validated superficially and earned nothing.

  `buildProductSchema` (`@intijs/core/seo`) now emits the full node, and `buildStructuredData` accepts `product` / `currency` options that make the product the graph's main entity. Multiple offers collapse into an `AggregateOffer` with `lowPrice`/`highPrice` — but only when the prices actually differ. `aggregateRating` is omitted when there are no reviews rather than published as a zero average, which Google rejects. Numeric prices are formatted to two decimals so the JSON-LD matches what the page renders.

  `auditProductSchema` reports what is missing for a rich result, including the currency — which WooCommerce does not return with the product and is therefore the usual omission.

- **`productFromWooCommerce`** (`@intijs/adapter-wordpress`): maps a `wc/v3` product response to that schema, including variations as a price range, `global_unique_id` as GTIN, and native WooCommerce brands. `mapStockStatus` returns `undefined` for unrecognised values rather than assuming availability — advertising "In stock" for a sold-out product gets the page flagged for incorrect structured data. `isIndexableProduct` filters the drafts and catalog-hidden products the API still serves.

  This is a translation layer, not an adapter: products are read straight from the Astro page that renders them, since the adapter contract exists for the editing layer and products are not visually edited.

### Fixed

- **Inserting a pattern is no longer partial on failure.** The composer issued one `insertBlock` request per block, so a failure on block 3 of 5 left the published page holding half a pattern and the editor holding a "partially inserted" toast. There is now a single `insertBlocks` action, backed by an optional `insertBlocks` method on `WritableAdapter` that the WordPress, Strapi, and local adapters implement as one read-modify-write. Adapters without it fall back to sequential inserts that roll back what was already written, and say exactly what remains if the rollback itself fails.

  Permissions are evaluated **per block, before anything is written**, reusing the `insertBlock` operation so existing policies apply unchanged. A pattern cannot smuggle in a block type a policy forbids by bundling it with allowed ones — if any block is denied, none are written.

- `LocalAdapter` was not reachable from any package export. Added the `@intijs/core/adapters/local` subpath. It is deliberately not re-exported from `@intijs/core/adapters`, which is imported by client code and must stay free of `node:fs`.

- **The documentation site built zero pages.** `src/content.config.ts` was missing, so Starlight's `/[...slug]` route found no entries and the build emitted a single `404.html` — successfully, with no error. The site now builds all 21 pages and a sitemap. `site` was also missing from the docs Astro config, which is what the sitemap needs to emit URLs at all.

- **Every repository and documentation link pointed nowhere.** Packages declared `github.com/intijs/inti`, the docs config `github.com/tuorg/inti`, the WordPress companion plugin `github.com/inti-js/inti` — none of those exist, and neither does the `intijs.dev` domain used for documentation links, including the one in the security error that tells developers how to protect their write endpoint. Some README links were broken twice over, pointing at pages (`/docs/forms`, `/docs/islands`, `/docs/realtime`…) that the documentation never had.

  Everything now points at `github.com/intijs/inti`, and documentation links go to the page sources in the repository, which GitHub renders and which exist as soon as the code is pushed. README links only reference pages that exist.

### Added

- **Inline editing with write-back**: double-click any text on your Astro page, edit it, and the change is written back to your CMS via the adapter's `WritableAdapter` contract.
- **WordPress adapter** (`@intijs/adapter-wordpress`): full read + write-back via WP REST API + ACF Flexible Content. Gutenberg mode included for simple text blocks.
- **Strapi adapter** (`@intijs/adapter-strapi`): read + write-back via Strapi v4/v5 dynamic zones.
- **Contentful adapter** (`@intijs/adapter-contentful`): read-only adapter for Contentful Delivery API.
- **Sanity adapter** (`@intijs/adapter-sanity`): read-only adapter for Sanity GROQ queries.
- **Visual page composer**: block toolbar (add, duplicate, delete, settings), palette drawer, auto-generated settings panel from block data, pattern save/load.
- **Block drag & drop**: grab a handle, reorder blocks visually, write-back the new order.
- **Relation picker**: `data-inti-relation` attribute opens a search panel to reassign relations inline.
- **Companion WordPress plugin** (`inti-bridge.php`): atomic ACF patches via `update_sub_field()`, eliminating race conditions. Optional — REST fallback if absent.
- **Multi-tab sync** (dev): edits broadcast over Vite HMR WebSocket; other tabs auto-refresh.
- **Typed blocks**: `inti sync` introspects the CMS schema and generates TypeScript types.
- **BlockRenderer**: lazy-loaded component registry for rendering CMS blocks as Astro components.
- **Local adapter**: with no CMS configured, writes go to a local JSON file (`.inti/content.json`) so inline editing can be tried before connecting anything. It is a convenience for getting started, not a CMS — Inti has no admin UI and no database of its own.
- **MCP server** (`@intijs/mcp`): exposes the write path as [Model Context Protocol](https://modelcontextprotocol.io) tools so AI agents can read and edit CMS content. 8 tools, advertised per adapter capability, with `INTI_MCP_READONLY=1` to drop all writes.
- **Plugin API** (`@intijs/core/plugins`): `beforeWrite` / `afterWrite` / `resolveActor` / `getPatternStore` hooks around every write action, so external packages can intercept writes without core depending on them. With no plugins registered, behaviour is unchanged.
- **Pattern actions** (`listPatterns`, `savePattern`, `deletePattern`): server-side pattern storage when a plugin provides a store; the composer falls back to `localStorage` otherwise.
- **Enterprise structure** (`packages/ee/`): Chatwoot-style open-core — MIT core, commercial enterprise features. First features implemented:
  - **Roles & permissions** — per-field, per-block-type and per-document rules with deny-wins evaluation and a `default` fallback.
  - **Audit log** — records who changed what and when, including failed attempts, with pluggable sinks (memory, JSONL file, or custom).
  - **Team patterns** — block patterns shared across the team instead of living in one browser's `localStorage`. Writes to the file-backed store are serialized so concurrent saves don't overwrite each other, and writes can be restricted by role.
  - **Production realtime** — Valkey pub/sub backplane so editors on different app instances see each other's changes. Any Redis-protocol client works; the client is injected rather than depended on.
  - **AI block generation** — an editor describes a section and gets a proposal composed from the developer's declared block vocabulary. The vocabulary is compiled into a JSON Schema where each type is a `const` and each variant a closed enum, so an invented block type is not representable in the output; the result is validated again afterwards in case a custom provider ignores the schema. Bring your own key (`@anthropic-ai/sdk` is an optional, lazily-loaded dependency, and any `AiProvider` works), and it never leaves the server. The composer shows an **✨ AI** tab only when a generator is configured, and nothing reaches the CMS until the editor accepts the proposal.
  - **SSO via OIDC** — authorization code flow with PKCE, ID token verification against the IdP's JWKS, and IdP groups mapped to Inti roles. Rejects `alg: "none"` and symmetric algorithms. SAML is deliberately not hand-rolled; see the package README. The composer falls back to `localStorage` when no store is configured.
  - **License validation** — offline Ed25519 signature verification, no license server and no telemetry. Fails closed; `INTI_EE_LICENSE_KEY=dev` unlocks features locally but is rejected in production. Includes `scripts/license.mjs` to generate keypairs and issue keys.
  - **Fail-closed degradation** — when a configured paid feature isn't licensed, the app still boots but the writes that depended on it are denied with an explicit error (`onInvalidLicense: 'block'`, the default). An expired license locks editing down instead of reopening it. Configurations that request nothing paid are unaffected and run as the MIT core.
- **CI workflow**: GitHub Actions with Node 18/20/22 matrix, build + test on every PR.

### Added — SEO

- **Build-time SEO audit.** `BlockRenderer` audits the page in dev and logs findings. Because blocks are typed data rather than rendered HTML, a finding names the exact block and field (`[block 0 HeroBanner.image]`) instead of describing the page as a whole. Covers metadata length and absence, images missing `alt` at any nesting depth, and — given a `headings` map declaring what level each block renders — missing/duplicate H1 and skipped levels. `auditPage` + `hasErrors` are exported for CI.
- **The same audit in the visual editor.** Findings render as a badge on the block that caused them, next to the field to fix, reusing the exact auditor that runs at build time.
- **`buildLlmsTxt` and `pageToMarkdown`** in `@intijs/core/seo`, generating a site index and per-page Markdown from `listPages()` and the block tree.
- **LCP support in `BlockRenderer`**: every block now receives `intiBlock={{ index, isFirst, total }}`, so the first block's image can opt out of lazy-loading. `IntiImage` emits `fetchpriority="high"` with `priority`, always emits `width`/`height` to prevent CLS, and warns in dev when `alt` is missing. It no longer needs a configured image service to be useful.

- **SEO metadata is read from whatever the CMS actually uses.** WordPress previously only looked at hand-made ACF fields, so a site with years of Yoast configuration lost all of it. The adapter now detects **Yoast, RankMath, AIOSEO and SEOPress** in that order, falling back to ACF, and Strapi reads its official `seo` component including `metaSocial` and `structuredData`. Everything normalizes into one `PageSeo` shape, so templates don't depend on which plugin a client installed.
- `PageSeo` now carries canonical, robots directives, per-network social overrides, keywords, dates, locale and CMS-computed JSON-LD — not just title/description/image.
- When the CMS already computed a JSON-LD graph, it is emitted as-is rather than rebuilt from scratch; `preferCmsJsonLd: false` opts out.
- `extractSeo(raw, fieldMap)` and `mergeSeo(...)` in `@intijs/core/seo` let adapters for CMSs without an SEO convention (Contentful, Sanity, custom) declare where their fields live.

- **`@intijs/core/seo`**: `buildMetaTags`, `buildStructuredData`, `buildSitemapXml`, `toSitemapEntries` and `buildRobotsTxt`, plus `<IntiSeo>` and `<IntiStructuredData>` Astro components. `IntiPage.seo` existed as a type but nothing rendered it — the CMS returned title, description and image and they were discarded.
- **JSON-LD from blocks.** A block is already a typed, self-contained unit of content, so it maps cleanly onto structured data. Builders are explicit (`faqFromBlock`, `howToFromBlock`, or your own) because the core cannot guess field names, and wrong structured data is worse than none. Relative images are absolutized; the payload escapes `<` so a value containing `</script>` cannot break out of the tag.
- **`ListableAdapter`** (`listPages()`), implemented by the WordPress and Local adapters, so sitemaps carry a real `lastmod` from the CMS instead of a build timestamp. The WordPress implementation requests only the needed fields and paginates.
- Editor modules are now loaded through dynamic imports, so they are emitted as lazy chunks rather than bundled into the entry script. The published HTML never referenced them, so this changes deployed bundle size rather than visitor performance.

### Removed

- **The local Meta-CMS is gone** (~1,800 lines): the `/admin` UI, schema builder, media library, block editor, session auth, content branching, the Astro DB tables and the codegen endpoint. Inti is a layer over the CMS you already have; shipping a second CMS alongside it contradicted that and was surface to maintain for a case nobody had asked for. It remains in git history if it is ever wanted back.
- Dropped with it: `IntiLogger`, `intiMiddleware`, the `IntiUser` / `IntiCollection` / `IntiDocument` / `IntiBranch` / `IntiLog` table exports, `/api/inti/upload`, `/api/inti/types`, the `admin` integration option and the S3 media configuration.
- The `getDocuments` and `getDocumentById` actions, which only ever served the local CMS.

### Changed

- **The local store is now an adapter, not a special case.** `LocalAdapter` (`@intijs/core/adapters/local`) writes to `.inti/content.json` and satisfies the same `WritableAdapter` + `SearchableAdapter` contract as WordPress and Strapi. `resolveWriteAdapter()` returns it when `INTI_ADAPTER` is unset or `local`, so the actions no longer carry any fallback branching — every write is just `adapter.method(...)`. Writes are serialized and the file is replaced atomically, so concurrent edits don't overwrite each other.
- **No database dependency.** Nothing in Inti imports `astro:db` or `@astrojs/db` any more, which also removes the Rollup externalization workaround that existed to keep them from breaking bundles.

### Compatibility

- **Astro 7 support.** The peer range is now `^5.0.0 || ^6.0.0 || ^7.0.0`, verified by building a clean project against both Astro 5 and Astro 7. Astro 4 is no longer claimed: `astro:actions`, which the whole write path depends on, is only stable from 5.
- Fixed an HTML comment inside a JSX expression in `FallbackBlock.astro` that the Go compiler tolerated and Astro 7's Rust compiler rejects.
- **`@astrojs/db` was removed in Astro 7**, so the optional local Meta-CMS only runs on Astro 5 or 6 with that package installed. With `admin: true` on Astro 7, the integration now logs a warning and skips the `/admin` routes instead of failing the build. Inline editing against an external CMS is unaffected.

### Fixed

- **The documented setup did not build.** Verified end to end against a clean Astro project; nine separate blockers were found and fixed:
  - `@intijs/core/actions` imported `astro:db` statically, so every WordPress or Strapi project failed to build over a database it never installed. The local Meta-CMS now lives in `actions/local-fallback.ts` and is loaded lazily; without `@astrojs/db` the actions return a clear error instead of breaking the bundle.
  - `@intijs/core/visual-bridge/*`, `@intijs/core/admin/*` and `@intijs/core/api/*` were not in the package `exports` map, so the injected admin routes and the documented `VisualBridgeAuto` import both failed to resolve.
  - `intiActions` was documented as `import { intiActions } from '@intijs/core'`, but the root entry only exports the integration — and cannot export the actions, since it is loaded from `astro.config.mjs` where Astro's virtual modules don't exist yet. It now has its own `@intijs/core/actions` subpath.
  - `VisualBridgeAuto` hard-required an `inti.config.ts`; the file is now optional and the CMS is read from `INTI_ADAPTER` when it's absent.
  - Stale compiled `.js`/`.d.ts` artifacts committed under `src/` shadowed the TypeScript sources during bundling.
  - Block components receive their fields as direct props, not under `Astro.props.data` as previously documented.
- **`admin` now defaults to `false`.** It mounts the local Meta-CMS, whose routes require `@astrojs/db`; defaulting it on broke the build for every project using an external CMS. `/api/inti/search` and `/api/inti/sync` are injected unconditionally, since inline editing needs them with any CMS.
- **Missing setup steps documented**: an Astro adapter is required for editing (Inti now warns at startup when none is configured), and block components must be registered — a single `registerBlocks(import.meta.glob('/src/blocks/*.astro'))` call, with the dev-mode placeholder naming the exact file and snippet needed.
- **Root build scripts never ran**: every `build:*` script used pnpm's `--filter` flag under npm, which errors with `Missing script`. Rewritten to npm's `-w <workspace>` syntax. `npm run build` now completes the whole chain.
- **`@intijs/core` could not compile standalone**: `astro:db`, `@astrojs/db`, and `@aws-sdk/client-s3` are provided by the host project, so `tsc` failed on them. Declared as ambient modules in a non-published `env.d.ts`, and the two real packages are now listed as optional peer dependencies.
- **Realtime broadcast leaked across documents**: `/api/inti/sync` kept connected clients in a map keyed only by client id, so a change to one page was broadcast to every connected editor regardless of which page they had open. Clients are now grouped per document. The endpoint also no longer sends `Access-Control-Allow-Origin: *` — cross-origin access is opt-in via `INTI_REALTIME_ALLOWED_ORIGIN`.
- Removed two API routes that were injected as live endpoints but returned hardcoded placeholder data (`/api/inti/[...path]` federation stub, `/api/inti/render-block` mock renderer).
- The generated `inti-manifest.json` no longer points AI assistants at a `GEMINI.md` file that does not exist.

### Architecture

- `WritableAdapter` contract: any adapter implementing `updateBlockField`, `moveBlock`, `insertBlock`, `removeBlock`, `duplicateBlock` gets inline editing for free.
- Server-side credential isolation: CMS credentials stay in `astro:actions`, never reach the client.
- Adapter-based write path: WordPress (ACF + Gutenberg), Strapi (dynamic zones), local Astro DB.
