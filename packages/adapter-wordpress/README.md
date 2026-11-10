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

ACF REST requires the **full** value of the Flexible Content field, so each write is a *read-modify-write* of the layouts array: the post is read, the field of the target layout is patched and the whole array is sent back. The `acf_fc_layout` values are always preserved.

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

## Gutenberg mode

If your pages do not use ACF Flexible Content, the adapter (in `auto` mode, or with `mode: 'gutenberg'`) parses the blocks in `post_content`:

- **Reading**: each top-level block → one `IntiBlock` (`core/paragraph` → `Paragraph`). It needs credentials (`context=edit`) to get `content.raw`; without them, the rendered content is exposed as a single `RichText` block.
- **Writing**: only the `text` field and only in simple blocks (one tag, no nested markup). Complex blocks are rejected with a clear error — the `post_content` is never put at risk.

## Companion plugin (optional, recommended)

Copy [`wordpress-plugin/inti-bridge.php`](./wordpress-plugin/inti-bridge.php) to `wp-content/plugins/` and activate it. It provides:

- `POST /wp-json/inti/v1/patch` — **atomic** patch with ACF's `update_sub_field()`: no round-trip of the whole array, no race conditions between editors.
- `POST /wp-json/inti/v1/move` — server-side row reordering.
- An `intiUpdateBlockField` mutation in WPGraphQL (if installed) — WPGraphQL for ACF ships no mutations upstream.

The adapter detects it on its own (`useBridgePlugin: 'auto'`, the default): if it answers, it uses it; if it is not there (404), it falls back to the standard REST path and remembers that.

## Inline editing integration

This adapter implements `WritableAdapter`, so the `inti.updateBlockField` action from `@intijs/core` uses it automatically when the environment defines:

```bash
INTI_ADAPTER=wordpress
INTI_WP_ENDPOINT=https://cms.yoursite.com
INTI_WP_USER=editor
INTI_WP_APP_PASSWORD=xxxx xxxx xxxx xxxx
```

See the root README for the full flow (BlockRenderer + VisualBridgeAuto + InlineEditor).
