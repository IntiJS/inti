/**
 * Generates the files of an Inti project.
 *
 * It is the complete setup from AGENTS.md, nothing more: if this generator produces
 * something the documentation does not describe, one of the two is wrong. That is why
 * there is a check (scripts/create-inti-check.mjs) that generates a
 * project, builds it, starts it in development and in production, and edits
 * a page for real.
 *
 * It does not write to disk or ask anything: it returns a path → content map.
 * The prompt interface lives in bin/create-inti.js.
 */

/** Dependency versions for the generated project */
export const VERSIONS = {
    // Pinned to 7.3: Astro 7.4 requires Node 22.23.4, and a `^` would make the same command
    // generate something that does not start depending on when it runs
    astro: '~7.3.8',
    // The node adapter has its own major: Astro 7 → @astrojs/node 11
    node: '^11.1.0',
    inti: '^0.1.0'
};

/** The Node version required by the Astro version in `VERSIONS` */
export const MIN_NODE = [22, 12];

/** A message if this Node version cannot run the generated project */
export function nodeVersionError(version) {
    const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
    if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) return undefined;
    return `Inti needs Node ${MIN_NODE.join('.')} or later, and you have ${version}.`;
}

/**
 * What changes from one CMS to another. Everything else in the project is identical.
 *
 * - `block`: the sample block file, with the name that CMS
 *   produces (WordPress and Strapi convert to PascalCase; Kitsuden does not).
 */
export const CMS = {
    local: {
        label: 'No CMS (local store)',
        hint: 'For trying it out: saves to .inti/content.json',
        package: null,
        block: { file: 'Hero.astro', type: 'Hero', native: 'Hero', heading: 'heading', text: 'subheading' }
    },
    wordpress: {
        label: 'WordPress',
        hint: 'REST + ACF Flexible Content',
        package: '@intijs/adapter-wordpress',
        block: { file: 'HeroBanner.astro', type: 'HeroBanner', native: 'hero_banner', heading: 'heading', text: 'subheading' }
    },
    kitsuden: {
        label: 'Kitsuden',
        hint: 'Page Builder API',
        package: '@intijs/adapter-kitsuden',
        block: { file: 'hero.astro', type: 'hero', native: 'hero', heading: 'headline', text: 'subheadline' }
    },
    strapi: {
        label: 'Strapi',
        hint: 'v4 or v5, dynamic zones',
        package: '@intijs/adapter-strapi',
        block: { file: 'Hero.astro', type: 'Hero', native: 'sections.hero', heading: 'heading', text: 'subheading' }
    },
    keystatic: {
        label: 'Keystatic',
        hint: 'Files in your repo, locally or via GitHub',
        package: '@intijs/adapter-keystatic',
        block: { file: 'hero.astro', type: 'hero', native: 'hero', heading: 'heading', text: 'subheading' }
    }
};

export const CMS_IDS = Object.keys(CMS);

/** A project name valid as an npm package name and a folder name */
export function validateName(name) {
    if (!name) return 'The name is required';
    if (name.length > 214) return 'Too long (214 characters maximum)';
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
        return 'Only lowercase letters, numbers, hyphens, dots and underscores, starting with a letter or number';
    }
    return undefined;
}

// ============================================
// Files
// ============================================

/** The @intijs packages a project for this CMS depends on */
export function intiPackages(cms) {
    return ['@intijs/core', ...(CMS[cms]?.package ? [CMS[cms].package] : [])];
}

/**
 * @param {Record<string, string>} [packages] dependency spec per @intijs package
 *   (for example `file:../tarballs/intijs-core-0.1.0.tgz`), for installing from
 *   local tarballs while the packages are not on npm. Default: the npm range.
 */
function packageJson(name, cms, packages = {}) {
    const dependencies = {
        '@astrojs/node': VERSIONS.node,
        astro: VERSIONS.astro
    };
    for (const dep of intiPackages(cms)) dependencies[dep] = packages[dep] ?? VERSIONS.inti;

    const sorted = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)));

    return (
        JSON.stringify(
            {
                name,
                type: 'module',
                version: '0.0.1',
                private: true,
                scripts: {
                    dev: 'astro dev',
                    build: 'astro build',
                    preview: 'astro preview',
                    start: 'node ./dist/server/entry.mjs',
                    astro: 'astro'
                },
                dependencies: sorted
            },
            null,
            2
        ) + '\n'
    );
}

const ASTRO_CONFIG = `import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import inti from '@intijs/core';

export default defineConfig({
    // Each page is read from the CMS on every request: that way a change shows without
    // rebuilding the site. Without this, the [...slug] route does not compile.
    output: 'server',
    // Without an Astro adapter the actions do not exist and nothing is saved.
    adapter: node({ mode: 'standalone' }),
    integrations: [inti()]

    // For <IntiImage> to optimize the CMS images (srcset + WebP),
    // allow its domain:
    // image: { domains: ['cms.yoursite.com'] }
});
`;

const TSCONFIG = `{
  "extends": "astro/tsconfigs/strict",
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist"]
}
`;

const ACTIONS = `import { intiActions } from '@intijs/core/actions';

// The action that receives the edits and writes them to the CMS, on the server.
export const server = { inti: intiActions };
`;

const MIDDLEWARE = `import { defineMiddleware } from 'astro:middleware';

/**
 * In development anyone can edit. In production, Inti rejects
 * writes and does not show the editor until a plugin decides who is
 * editing. That plugin is registered HERE, not in src/actions/index.ts: Astro
 * only loads the actions with the first action, and until then the plugin
 * would not exist and the editor would not appear.
 *
 * import { registerIntiPlugin } from '@intijs/core/plugins';
 *
 * registerIntiPlugin({
 *     name: 'session',
 *     // Who is asking: null = nobody identified
 *     resolveActor: async (ctx) => (await mySession(ctx.request)) ?? null,
 *     // Whether they may write
 *     beforeWrite: (ctx) => ({ allowed: Boolean(ctx.actor) })
 * });
 *
 * Guide: https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/guides/securing-writes.md
 */

export const onRequest = defineMiddleware((_context, next) => next());
`;

function cmsModule(cms) {
    switch (cms) {
        case 'local':
            return `import { LocalAdapter } from '@intijs/core/adapters/local';

/**
 * No CMS: the pages live in .inti/content.json. It is for trying out
 * editing; for a real site, run create-inti again with your CMS or
 * change this file.
 */
const adapter = new LocalAdapter();

export function readPage(slug: string) {
    return adapter.fetchPageBySlug(slug);
}
`;
        case 'wordpress':
            return `import { WordPressAdapter } from '@intijs/adapter-wordpress';
import { env } from '@intijs/core/server';

// env() also reads the server's variables at startup. import.meta.env only
// sees the ones present at build time, so a Docker image or a platform that
// injects them at runtime would answer 404 on every page.
const endpoint = env('INTI_WP_ENDPOINT');

const adapter = new WordPressAdapter({
    endpoint: endpoint ?? '',
    blocksField: env('INTI_WP_BLOCKS_FIELD'),
    postType: env('INTI_WP_POST_TYPE')
});

export function readPage(slug: string) {
    if (!endpoint) throw new Error('INTI_WP_ENDPOINT is missing from .env (copy .env.example)');
    return adapter.fetchPageBySlug(slug);
}
`;
        case 'kitsuden':
            return `import { KitsudenAdapter } from '@intijs/adapter-kitsuden';
import { env } from '@intijs/core/server';

// env() also reads the server's variables at startup. import.meta.env only
// sees the ones present at build time, so a Docker image or a platform that
// injects them at runtime would answer 404 on every page.
const endpoint = env('INTI_KITSUDEN_ENDPOINT');

// Reading published pages needs no key: the key is only used by
// writes, on the server.
const adapter = new KitsudenAdapter({ endpoint: endpoint ?? '' });

export function readPage(slug: string) {
    if (!endpoint) throw new Error('INTI_KITSUDEN_ENDPOINT is missing from .env (copy .env.example)');
    return adapter.getPage(slug);
}
`;
        case 'strapi':
            return `import { StrapiAdapter } from '@intijs/adapter-strapi';
import { env } from '@intijs/core/server';

// env() also reads the server's variables at startup. import.meta.env only
// sees the ones present at build time, so a Docker image or a platform that
// injects them at runtime would answer 404 on every page.
const endpoint = env('INTI_STRAPI_ENDPOINT');

const adapter = new StrapiAdapter({
    endpoint: endpoint ?? '',
    apiToken: env('INTI_STRAPI_TOKEN'),
    contentType: env('INTI_STRAPI_CONTENT_TYPE'),
    blocksField: env('INTI_STRAPI_BLOCKS_FIELD')
});

export function readPage(slug: string) {
    if (!endpoint) throw new Error('INTI_STRAPI_ENDPOINT is missing from .env (copy .env.example)');
    return adapter.fetchPageBySlug(slug);
}
`;
        case 'keystatic':
            return `import { KeystaticAdapter } from '@intijs/adapter-keystatic';
import { env } from '@intijs/core/server';

// With INTI_KEYSTATIC_REPO it reads and writes via GitHub, and each edit is a commit. Without
// it, it uses the local folder, which would be lost on a server with no persistent disk.
const adapter = new KeystaticAdapter({
    root: env('INTI_KEYSTATIC_ROOT'),
    repo: env('INTI_KEYSTATIC_REPO'),
    token: env('INTI_KEYSTATIC_TOKEN'),
    branch: env('INTI_KEYSTATIC_BRANCH'),
    collection: env('INTI_KEYSTATIC_COLLECTION'),
    blocksField: env('INTI_KEYSTATIC_BLOCKS_FIELD')
});

export function readPage(slug: string) {
    return adapter.fetchPageBySlug(slug);
}
`;
        default:
            throw new Error(`Unknown CMS: ${cms}`);
    }
}

const PAGE = `---
import Layout from '../layouts/Layout.astro';
import { registerBlocks } from '@intijs/core/registry';
import BlockRenderer from '@intijs/core/astro/BlockRenderer.astro';
import VisualBridgeAuto from '@intijs/core/visual-bridge/VisualBridgeAuto.astro';
import { readDraftPage } from '@intijs/core/server';
import { readPage } from '../lib/cms';

// Each file in src/blocks is a block type: the file name
// has to match the type the CMS returns.
registerBlocks(import.meta.glob('/src/blocks/*.astro'));

const slug = Astro.params.slug ?? 'home';

let page;
try {
    // The draft only exists for someone with an editor session; for any
    // other visitor this is null and the published version is read
    page = (await readDraftPage(slug, Astro)) ?? (await readPage(slug));
} catch (error) {
    const detail = import.meta.env.DEV && error instanceof Error ? \`: \${error.message}\` : '';
    return new Response(\`Page not found\${detail}\`, { status: 404 });
}
---

<Layout page={page}>
    <BlockRenderer blocks={page.blocks} page={page} />
</Layout>

<!-- The editor: active in development; in production, only with an editor session -->
<VisualBridgeAuto />
`;

const LAYOUT = `---
import IntiSeo from '@intijs/core/astro/IntiSeo.astro';
import type { IntiPage } from '@intijs/core/types';

interface Props {
    page: IntiPage;
}

const { page } = Astro.props;
---

<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <!-- Title, description, canonical and Open Graph, normalized from the CMS -->
        <IntiSeo page={page} url={Astro.url.href} />
    </head>
    <body>
        <slot />
    </body>
</html>

<style is:global>
    body {
        margin: 0;
        font-family: system-ui, sans-serif;
        line-height: 1.6;
    }
</style>
`;

function blockComponent(cms) {
    const b = CMS[cms].block;
    return `---
/**
 * "${b.type}" block. The file name is the block type${
        cms === 'local' ? '' : `: in ${CMS[cms].label} it maps to "${b.native}"`
    }.
 * The CMS fields arrive as props. data-inti-field marks which field is
 * edited by double-clicking that element.
 */
const { ${b.heading}, ${b.text} } = Astro.props;
---

<section class="hero">
    <h1 data-inti-field="${b.heading}">{${b.heading}}</h1>
    {${b.text} && <p data-inti-field="${b.text}">{${b.text}}</p>}
</section>

<style>
    .hero {
        padding: 4rem 1.5rem;
        text-align: center;
    }
</style>
`;
}

const TEXT_BLOCK = `---
/** "Text" block: an editable paragraph */
const { body } = Astro.props;
---

<section class="text">
    <p data-inti-field="body">{body}</p>
</section>

<style>
    .text {
        max-width: 42rem;
        margin: 0 auto;
        padding: 1rem 1.5rem;
    }
</style>
`;

/** Initial content of the local store, in the shape LocalAdapter reads */
function localContent() {
    return (
        JSON.stringify(
            {
                documents: {
                    home: {
                        id: 'home',
                        slug: 'home',
                        title: 'Home',
                        seo: {
                            title: 'My site with Inti',
                            description: 'A sample page you can edit by double-clicking it.'
                        },
                        blocks: [
                            {
                                type: 'Hero',
                                data: {
                                    heading: 'Double-click this heading',
                                    subheading: 'Edit it, press Enter, and it is saved to .inti/content.json'
                                }
                            },
                            {
                                type: 'Text',
                                data: {
                                    body: 'Each block on the page is a component in src/blocks. The file name is the block type.'
                                }
                            }
                        ]
                    }
                }
            },
            null,
            2
        ) + '\n'
    );
}

const KEYSTATIC_HOME = `title: Home
metaTitle: My site with Inti
metaDescription: A sample page you can edit by double-clicking it.
blocks:
  - discriminant: hero
    value:
      heading: Double-click this heading
      subheading: Edit it, press Enter, and it is saved to content/pages/home.yaml
`;

function envExample(cms) {
    const common = `# Server variables: never with a PUBLIC_ prefix, never in the repository.
`;
    switch (cms) {
        case 'local':
            return `${common}
# Without INTI_ADAPTER, Inti writes to the local store.
# INTI_LOCAL_STORE=.inti/content.json
`;
        case 'wordpress':
            return `${common}
INTI_ADAPTER=wordpress
INTI_WP_ENDPOINT=https://cms.yoursite.com
# Application Password: wp-admin → Users → Profile → Application Passwords
INTI_WP_USER=editor
INTI_WP_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx
# ACF Flexible Content field holding the blocks
INTI_WP_BLOCKS_FIELD=content_blocks
# INTI_WP_POST_TYPE=pages
`;
        case 'kitsuden':
            return `${common}
INTI_ADAPTER=kitsuden
INTI_KITSUDEN_ENDPOINT=https://cms.yoursite.com
# AGENT key (kitsuden_agent_…). Only for writing.
INTI_KITSUDEN_TOKEN=
`;
        case 'strapi':
            return `${common}
INTI_ADAPTER=strapi
INTI_STRAPI_ENDPOINT=https://strapi.yoursite.com
# API Token with update permission
INTI_STRAPI_TOKEN=
# INTI_STRAPI_CONTENT_TYPE=pages
# INTI_STRAPI_BLOCKS_FIELD=blocks
`;
        case 'keystatic':
            return `${common}
INTI_ADAPTER=keystatic
# The collection with a fields.blocks field, as in keystatic.config
# INTI_KEYSTATIC_COLLECTION=content/pages/*
# INTI_KEYSTATIC_BLOCKS_FIELD=blocks

# In production, via GitHub: each edit is a commit
# INTI_KEYSTATIC_REPO=owner/repo
# INTI_KEYSTATIC_TOKEN=
# INTI_KEYSTATIC_BRANCH=main
`;
        default:
            throw new Error(`Unknown CMS: ${cms}`);
    }
}

const GITIGNORE = `node_modules/
dist/
.astro/
.env
.env.*
!.env.example
`;

function readme(name, cms) {
    const b = CMS[cms].block;
    const connect =
        cms === 'local'
            ? `This project is not connected to any CMS: the pages live in \`.inti/content.json\`. It is for trying out editing, not for production.`
            : `1. Copy \`.env.example\` to \`.env\` and fill in your ${CMS[cms].label} details.
2. Create a component in \`src/blocks/\` for each block type in your CMS. The sample one, \`${b.file}\`, maps to \`${b.native}\`.`;

    return `# ${name}

An Astro site with [Inti](https://github.com/intijs/inti): edit the content by double-clicking the page itself.

## Getting started

${connect}

\`\`\`bash
npm run dev
\`\`\`

Open the page, hover over some text, double-click, edit and press Enter.

## Structure

| File | What for |
|---|---|
| \`src/pages/[...slug].astro\` | Reads each page from the CMS and renders it |
| \`src/blocks/\` | One component per block type. The file name is the type |
| \`src/lib/cms.ts\` | How it connects to the CMS |
| \`src/actions/index.ts\` | Receives the edits and writes them to the CMS |
| \`src/middleware.ts\` | Who can edit in production |

## Production

In production Inti rejects edits until you decide who may make them. See \`src/middleware.ts\`.

\`\`\`bash
npm run build
npm start
\`\`\`
`;
}

/**
 * All the project's files.
 * @returns {Record<string, string>} relative path → content
 */
export function generateProject({ name, cms, packages }) {
    const nameError = validateName(name);
    if (nameError) throw new Error(`Invalid project name: ${nameError}`);
    if (!CMS[cms]) throw new Error(`Unknown CMS: "${cms}". Options: ${CMS_IDS.join(', ')}`);

    const files = {
        'package.json': packageJson(name, cms, packages),
        'astro.config.mjs': ASTRO_CONFIG,
        'tsconfig.json': TSCONFIG,
        '.gitignore': GITIGNORE,
        '.env.example': envExample(cms),
        'README.md': readme(name, cms),
        'src/actions/index.ts': ACTIONS,
        'src/middleware.ts': MIDDLEWARE,
        'src/lib/cms.ts': cmsModule(cms),
        'src/pages/[...slug].astro': PAGE,
        'src/layouts/Layout.astro': LAYOUT,
        [`src/blocks/${CMS[cms].block.file}`]: blockComponent(cms)
    };

    if (cms === 'keystatic') {
        files['content/pages/home.yaml'] = KEYSTATIC_HOME;
    }

    if (cms === 'local') {
        files['src/blocks/Text.astro'] = TEXT_BLOCK;
        files['.inti/content.json'] = localContent();
    }

    return files;
}
