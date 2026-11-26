# @intijs/adapter-wordpress

Official **Headless WordPress** adapter for Inti.js: reads via the WP REST API + ACF, and **write-back** (inline editing) via Application Passwords.

> **Not on npm yet.** The `@intijs` packages will be published there. Until then `npm install @intijs/…` answers 404: install from git as described under [Installation](https://github.com/intijs/inti#-installation) in the repository README.

## Requirements in WordPress

1. **ACF >= 5.11** with *"Show in REST API"* enabled on the field groups.
2. Page blocks modelled as **ACF Flexible Content** (each layout = one Inti block).
3. **Application Password** (WP >= 5.6): wp-admin → Users → Profile → Application Passwords.
4. If you use Apache and get 401 on writes: Apache may strip the `Authorization` header. Add to your `.htaccess`:
   ```apache
   SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1
   ```

## Usage

### Reading
```ts
import { WordPressAdapter } from '@intijs/adapter-wordpress';

const adapter = new WordPressAdapter({
    endpoint: 'https://cms.yoursite.com',
    postType: 'pages',            // default: 'pages'
    blocksField: 'content_blocks' // ACF Flexible Content field, default: 'content_blocks'
});

const page = await adapter.fetchPageBySlug('home');
// page.blocks: IntiBlock[] — each acf_fc_layout → a PascalCase block type
// 'hero_banner' → 'HeroBanner' (customizable with blockTypeMap)
```

- A missing page throws `NotFoundError` and a WordPress that cannot answer throws `UnavailableError` (`@intijs/core/errors`): the page template answers 404 or 503 with `pageErrorResponse`.
- Only the fields a page needs are requested (`_fields`); add a plugin's REST field with `extraFields`, or turn it off with `trimFields: false`.
- A nested page can be asked for by its path: `fetchPageBySlug('services/design')`.
- Images in ACF fields keep their keys and gain the image contract: `srcset` from the sizes WordPress generated, `sources` with the AVIF and WebP versions when modern formats are on, `video` when an animated GIF is also stored as a video, and `size` (`filesize`). `<IntiImage src={image} />` uses them as they are.
- `listPages()` walks every page of the listing, four requests at a time, with no cap.

### Languages, menus, taxonomies and archives

```ts
await adapter.fetchPageBySlug('about', { locale: 'en' });  // Polylang or WPML (?lang=)
// page.locale and page.translations come from the plugin's fields: IntiSeo emits hreflang

await adapter.fetchNavigation('primary', { locale: 'en' }); // the menu of a theme location (needs the plugin)
await adapter.listTerms('categories');
await adapter.fetchArchive({ taxonomy: 'categories', term: 'news', page: 2, perPage: 10 });
// { items, total, totalPages, page, term }: totals from X-WP-Total, for pagination
```

### Writing (write-back)
```ts
// ONLY on the server (astro:action) — never on the client
const adapter = new WordPressAdapter({
    endpoint: process.env.INTI_WP_ENDPOINT!,
    username: process.env.INTI_WP_USER,
    appPassword: process.env.INTI_WP_APP_PASSWORD
});

// Updates blocks[1].heading of post 123
await adapter.updateBlockField('123', 1, 'heading', 'New title');

// Page-level ACF field (blockIndex = -1)
await adapter.updateBlockField('123', -1, 'seo_description', '...');

// Dot-path for nested fields (ACF groups)
await adapter.updateBlockField('123', 0, 'cta.label', 'Buy now');
```

With the companion plugin every write is one call that runs on the server (below). Without it, ACF REST requires the **full** value of the Flexible Content field, so each write is a *read-modify-write* of the layouts array: the post is read, the field of the target layout is patched and the whole array is sent back. The `acf_fc_layout` values are always preserved.

Requests go through the HTTP client of `@intijs/core/http`: a time limit, reads retried, `Retry-After` respected, and JSON sent with exactly `Content-Type: application/json`.

### Block type mapping
```ts
new WordPressAdapter({
    endpoint: '...',
    blockTypeMap: {
        hero_banner: 'Hero',      // instead of the default 'HeroBanner'
        two_col_text: 'TwoColumn'
    }
});
```

### Introspection (`inti sync`)
WordPress does not expose the ACF schema over REST, so introspection combines `/wp-json/wp/v2/types` with one sample post per type to infer fields and types. With the API down, it falls back to the introspection system's standard mock.

### Password-protected pages
A page with a WordPress password is never rendered: `fetchPageBySlug` throws `NotFoundError` (a 404) and listings leave it out. The adapter reads with `context=edit` when it has a write credential, and that context returns the protected content, so it checks `content.protected` and `password` itself. The companion plugin's `inti_blocks` field and `inti/get-page` ability apply `post_password_required()` as well.

### Ids
`documentId` and `draftId` must be post ids (digits) and `postType`, taxonomies and search collections plain REST bases (`[A-Za-z0-9_-]`). Anything else is refused before a request is made: those values come from the editor, and a path such as `5/../../users/1` would reach another route with the service credential.

## Gutenberg mode

If your pages do not use ACF Flexible Content, the adapter (in `auto` mode, or with `mode: 'gutenberg'`) parses the blocks in `post_content`:

- **Reading**: each top-level block → one `IntiBlock` (`core/paragraph` → `Paragraph`). It needs credentials (`context=edit`) to get `content.raw`; without them, the rendered content is exposed as a single `RichText` block.
- **Writing**: only the `text` field and only in simple blocks (one tag, no nested markup). Complex blocks are rejected with a clear error — the `post_content` is never put at risk. Classic HTML between blocks and Block Hooks metadata (`ignoredHookedBlocks`) survive every write byte for byte.
- **Bindings** (WordPress 6.5+): a block whose content comes from a source (`metadata.bindings`) shows what WordPress renders for it, taken from the plugin's `inti_blocks` field, and is not editable: what is stored is not what shows. Dynamic blocks show their rendered HTML the same way.
- With the plugin and no credentials, `inti_blocks` still gives one block per Gutenberg block (read only) instead of a single `RichText`.

## Companion plugin (recommended)

Copy [`wordpress-plugin/inti-bridge.php`](./wordpress-plugin/inti-bridge.php) to `wp-content/plugins/` and activate it (WordPress 6.5+). It provides:

- **Every write in one PHP call.** `POST /inti/v1/patch` writes one field with `acf_update_value` (groups and repeater items by dot-path); `POST /inti/v1/rows` moves, inserts, removes, duplicates or replaces rows on the raw values, so images and relationships are never sent back as objects; `POST /inti/v1/content` writes a Gutenberg document.
- **No silent overwrites.** Each write accepts `expected_modified` (the `modified_gmt` the writer read) and answers 409 when the page changed since. The adapter sends it whenever it read the page, and turns a 409 into "The page changed in WordPress since it was read. Reload it and edit again."
- **Signed purge notices.** With `INTI_PURGE_URL` and `INTI_PURGE_SECRET` in `wp-config.php`, publishing, updating, unpublishing, deleting or renaming a page posts `{ event, id, type, slug }` to the site, signed with `X-Inti-Signature: sha256=<HMAC>`: point it at `purgeRoute` from `@intijs/core/delivery`. A menu change purges everything. Notices are sent once per request, at the end, without blocking wp-admin.
- **REST fields** on every post type: `inti_blocks` (`parse_blocks()` of the stored content, with `rendered` for bound and dynamic blocks), `inti_locale` and `inti_translations` (Polylang or WPML).
- **Menus** without credentials: `GET /inti/v1/menus/<location>?lang=` returns the tree with each link's path on the site.
- **Abilities API** (WordPress 6.9+): `inti/get-page`, `inti/update-block-field` and `inti/purge`, each checking the capability a person would need.
- An `intiUpdateBlockField` mutation in WPGraphQL (if installed), running the same code as `/patch`.

The adapter detects it on its own (`useBridgePlugin: 'auto'`, the default). Only a 404 for its route means "not installed", and the adapter checks again after ten minutes; any other failure is reported as it is, never retried through the racier REST path.

## Inline editing integration

This adapter implements `WritableAdapter`, so the `inti.updateBlockField` action from `@intijs/core` uses it automatically when the environment defines:

```bash
INTI_ADAPTER=wordpress
INTI_WP_ENDPOINT=https://cms.yoursite.com
INTI_WP_USER=editor
INTI_WP_APP_PASSWORD=xxxx xxxx xxxx xxxx
```

See the root README for the full flow (BlockRenderer + VisualBridgeAuto + InlineEditor).
