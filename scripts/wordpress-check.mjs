#!/usr/bin/env node
/**
 * Checks @intijs/adapter-wordpress against a real WordPress.
 *
 * The adapter's tests use a mocked `fetch`, which confirms what WordPress is
 * believed to do. This confirms what it does: it starts WordPress in Docker
 * with Flexible Content (Secure Custom Fields), creates a page and walks through
 * every write operation, reading the result back from the REST API afterwards.
 *
 * Usage: node scripts/wordpress-check.mjs [--keep]
 *        Requires Docker and `npm run build`. --keep leaves WordPress running.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = join(ROOT, 'scripts/wordpress-check/docker-compose.yml');
const ENDPOINT = 'http://127.0.0.1:43480';
const keep = process.argv.includes('--keep');

function compose(...args) {
    return execFileSync('docker', ['compose', '-f', COMPOSE, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
}

const wp = (...args) => compose('--profile', 'tools', 'run', '--rm', '-T', 'cli', 'wp', ...args);

function setup() {
    compose('up', '-d', '--wait');
    try {
        wp('core', 'is-installed');
    } catch {
        wp(
            'core', 'install', `--url=${ENDPOINT}`, '--title=Inti', '--admin_user=admin',
            '--admin_password=inti-check-only', '--admin_email=check@example.invalid', '--skip-email'
        );
    }
    wp('plugin', 'install', 'secure-custom-fields', '--activate');
    wp('rewrite', 'structure', '/%postname%/', '--hard');
}

function createAppPassword() {
    try {
        wp('user', 'application-password', 'delete', 'admin', '--all');
    } catch {
        // there were none
    }
    return wp('user', 'application-password', 'create', 'admin', 'inti-check', '--porcelain');
}

/** Creates a page with blocks, the same way an editor does in wp-admin */
function createPage(slug, status = 'publish') {
    const id = wp('post', 'create', '--post_type=page', `--post_title=${slug}`, `--post_name=${slug}`, `--post_status=${status}`, '--porcelain');
    wp('eval', `update_field('content_blocks', [
        ['acf_fc_layout' => 'hero_banner', 'heading' => 'Hello', 'cta' => ['label' => 'Buy', 'url' => 'https://example.com/a']],
        ['acf_fc_layout' => 'feature_list', 'title' => 'Benefits', 'items' => [
            ['title' => 'One', 'body' => 'First'],
            ['title' => 'Two', 'body' => 'Second']
        ]]
    ], ${id});`);
    return id;
}

const results = [];
async function check(name, run) {
    try {
        await run();
        results.push({ name, ok: true });
        console.log(`✓ ${name}`);
    } catch (error) {
        results.push({ name, ok: false, error });
        console.log(`✗ ${name}\n    ${error instanceof Error ? error.message : error}`);
    }
}

function equal(actual, expected, label = 'value') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

function ok(result) {
    if (!result.success) throw new Error(`the write failed: ${result.error}`);
}

/**
 * The full path: an `npm create inti` project connected to this WordPress,
 * in production. The page is read from WordPress, and edits go through the
 * actions, with permissions, all the way to WordPress.
 */
async function fullStack(password) {
    const win = process.platform === 'win32';
    const workdir = realpathSync.native(mkdtempSync(join(tmpdir(), 'wp-stack-')));
    const shell = { shell: win, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    const base = 'http://127.0.0.1:43481';
    let server;
    let child;

    const pack = (dir) => {
        const output = execFileSync('npm', ['pack', '--json', '--pack-destination', workdir], { ...shell, cwd: join(ROOT, dir) });
        return join(workdir, JSON.parse(output.slice(output.search(/^\[\s*$/m)))[0].filename);
    };

    try {
        const tarballs = {
            '@intijs/core': pack('packages/core'),
            '@intijs/adapter-wordpress': pack('packages/adapter-wordpress')
        };
        const creator = pack('packages/create-inti');

        execFileSync('npx', ['--yes', '--package', creator, 'create-inti', 'site', '--cms', 'wordpress', '--no-install'], { ...shell, cwd: workdir });
        const project = join(workdir, 'site');

        const pkgPath = join(project, 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        for (const [name, path] of Object.entries(tarballs)) pkg.dependencies[name] = `file:${path}`;
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

        // A test editor: in production nobody writes without a plugin that decides it
        writeFileSync(
            join(project, 'src/middleware.ts'),
            `import { registerIntiPlugin } from '@intijs/core/plugins';
registerIntiPlugin({
    name: 'check',
    resolveActor: (ctx) => (ctx.request?.headers.get('x-check-editor') === '1' ? { id: 'e', role: 'editor' } : null),
    beforeWrite: (ctx) => ({ allowed: Boolean(ctx.actor) })
});
export const onRequest = (_ctx, next) => next();
`
        );
        writeFileSync(
            join(project, 'src/blocks/FeatureList.astro'),
            `---\nconst { title, items = [] } = Astro.props;\n---\n<section><h2 data-inti-field="title">{title}</h2><ul>{items.map((item, i) => <li data-inti-field={\`items.\${i}.title\`}>{item.title}</li>)}</ul></section>\n`
        );

        execFileSync('npm', ['install', '--no-audit', '--no-fund'], { ...shell, cwd: project });
        execFileSync('npx', ['astro', 'build'], { ...shell, cwd: project });

        const slug = `full-${Date.now()}`;
        const id = createPage(slug);

        child = spawn('node', ['./dist/server/entry.mjs'], {
            cwd: project,
            env: {
                ...process.env,
                NODE_ENV: 'production',
                HOST: '127.0.0.1',
                PORT: '43481',
                INTI_ADAPTER: 'wordpress',
                INTI_WP_ENDPOINT: ENDPOINT,
                INTI_WP_USER: 'admin',
                INTI_WP_APP_PASSWORD: password,
                INTI_WP_BLOCKS_FIELD: 'content_blocks'
            },
            stdio: 'ignore'
        });
        server = child;

        for (let i = 0; i < 60; i++) {
            const up = await fetch(`${base}/${slug}`).then((r) => r.status < 500).catch(() => false);
            if (up) break;
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        const action = (name, body, headers = { 'x-check-editor': '1' }) =>
            fetch(`${base}/_actions/inti.${name}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify(body)
            });
        const html = (path, headers = {}) => fetch(`${base}${path}`, { headers }).then((r) => r.text());
        const contains = (text, wanted) => {
            if (!text.includes(wanted)) throw new Error(`missing "${wanted}" in the page`);
        };

        await check('real project: the page is read from WordPress, with no JavaScript for the visitor', async () => {
            const page = await html(`/${slug}`);
            contains(page, 'Hello');
            contains(page, 'Benefits');
            if (/<script[^>]*type="module"/.test(page)) throw new Error('the visitor receives JavaScript');
        });

        await check('real project: an anonymous user cannot write and an editor can, all the way to WordPress', async () => {
            const refused = await action('updateBlockField', { documentId: id, blockIndex: 0, field: 'heading', value: 'INTRUDER' }, {});
            equal(refused.status, 403, 'anonymous');
            const saved = await action('updateBlockField', { documentId: id, blockIndex: 1, field: 'items.0.title', value: 'One via action' });
            equal(saved.status, 200, 'editor');
            contains(await html(`/${slug}`), 'One via action');
        });

        await check('real project: a draft is edited without the visitor seeing it, and is published', async () => {
            const created = await action('createDraft', { documentId: id });
            equal(created.status, 200, 'create');

            // Actions return their result in Astro's format: the id is read from WordPress
            const draftPage = await html(`/${slug}?inti-draft=1`, { 'x-check-editor': '1' });
            const draftId = /data-inti-document-id="(\d+)"/.exec(draftPage)?.[1];
            if (!draftId || draftId === id) throw new Error(`the draft is not another document (${draftId})`);

            equal((await action('updateBlockField', { documentId: draftId, blockIndex: 0, field: 'heading', value: 'Not published yet' })).status, 200, 'edit');

            if ((await html(`/${slug}`)).includes('Not published yet')) throw new Error('the visitor sees the draft');
            if ((await html(`/${slug}?inti-draft=1`)).includes('Not published yet')) throw new Error('the parameter alone is enough to see the draft');
            contains(await html(`/${slug}?inti-draft=1`, { 'x-check-editor': '1' }), 'Not published yet');

            equal((await action('publishDraft', { documentId: draftId })).status, 200, 'publish');
            contains(await html(`/${slug}`), 'Not published yet');
        });
    } catch (error) {
        results.push({ name: 'real project', ok: false, error });
        console.log(`✗ real project\n    ${error instanceof Error ? error.message : error}`);
    } finally {
        if (server) {
            try {
                if (win) execFileSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
                else server.kill();
            } catch {
                // it had already exited
            }
        }
        rmSync(workdir, { recursive: true, force: true, maxRetries: 3 });
    }
}

async function main() {
    setup();
    const password = createAppPassword();

    const { WordPressAdapter } = await import(
        pathToFileURL(join(ROOT, 'packages/adapter-wordpress/dist/index.js')).href
    );
    const adapter = new WordPressAdapter({
        endpoint: ENDPOINT,
        username: 'admin',
        appPassword: password,
        useBridgePlugin: false
    });
    const anonymous = new WordPressAdapter({ endpoint: ENDPOINT });

    const slug = `home-${Date.now()}`;
    const id = createPage(slug);
    const read = async () => (await adapter.fetchPageBySlug(slug)).blocks;

    await check('reads blocks with the expected type and index', async () => {
        const blocks = await read();
        equal(blocks.map((b) => b.type), ['HeroBanner', 'FeatureList'], 'types');
        equal(blocks.map((b) => b.meta.index), [0, 1], 'indexes');
        equal(blocks[0].data.cta.label, 'Buy', 'nested group');
        equal(blocks[1].data.items[1].title, 'Two', 'repeater');
    });

    await check('reads what is published without credentials', async () => {
        const page = await anonymous.fetchPageBySlug(slug);
        equal(page.blocks[0].data.heading, 'Hello');
    });

    await check('edits a field with accents and emoji without altering it', async () => {
        const value = 'Añadir “comillas” & <b>marcas</b> 🌞';
        ok(await adapter.updateBlockField(id, 0, 'heading', value));
        const blocks = await read();
        console.log(`    (WordPress returns: ${blocks[0].data.heading})`);
        if (!String(blocks[0].data.heading).startsWith('Añadir')) throw new Error(String(blocks[0].data.heading));
    });

    await check('edits a group field by dot-path without losing the rest', async () => {
        ok(await adapter.updateBlockField(id, 0, 'cta.label', 'See more'));
        const { cta } = (await read())[0].data;
        equal(cta, { label: 'See more', url: 'https://example.com/a' }, 'cta');
    });

    await check('edits a repeater item by dot-path', async () => {
        ok(await adapter.updateBlockField(id, 1, 'items.1.title', 'Two edited'));
        const { items } = (await read())[1].data;
        equal(items, [{ title: 'One', body: 'First' }, { title: 'Two edited', body: 'Second' }], 'items');
    });

    await check('editing a block does not touch the others', async () => {
        const before = (await read())[1].data;
        ok(await adapter.updateBlockField(id, 0, 'heading', 'Other'));
        equal((await read())[1].data, before, 'neighbor block');
    });

    await check('replaces a block\'s data keeping its layout', async () => {
        ok(await adapter.updateBlock(id, 0, { heading: 'New', cta: { label: 'A', url: 'https://example.com/b' } }));
        const [first] = await read();
        equal(first.type, 'HeroBanner', 'type');
        equal(first.data.heading, 'New', 'heading');
    });

    await check('inserts a block at a position', async () => {
        ok(await adapter.insertBlock(id, 1, 'hero_banner', { heading: 'Inserted', cta: { label: 'B', url: 'https://example.com/c' } }));
        equal((await read()).map((b) => b.data.heading ?? b.data.title), ['New', 'Inserted', 'Benefits'], 'order');
    });

    await check('inserts several blocks at once', async () => {
        ok(await adapter.insertBlocks(id, 3, [
            { nativeType: 'hero_banner', data: { heading: 'L1' } },
            { nativeType: 'feature_list', data: { title: 'L2', items: [{ title: 'x', body: 'y' }] } }
        ]));
        const blocks = await read();
        equal(blocks.length, 5, 'total');
        equal(blocks[4].data.items[0].title, 'x', 'inserted repeater');
    });

    await check('moves, duplicates and removes', async () => {
        ok(await adapter.moveBlock(id, 0, 1));
        equal((await read())[1].data.heading, 'New', 'after moving');
        ok(await adapter.duplicateBlock(id, 1));
        equal((await read())[2].data.heading, 'New', 'after duplicating');
        ok(await adapter.removeBlock(id, 2));
        equal((await read()).length, 5, 'after removing');
    });

    await check('an out-of-range index fails without writing', async () => {
        const before = await read();
        const result = await adapter.updateBlockField(id, 99, 'heading', 'X');
        equal(result.success, false, 'success');
        equal((await read()).length, before.length, 'total');
    });

    // ACF returns images and relationships as objects, but expects ids when saving.
    // Saving a neighboring field must not lose them or be rejected because of them.
    const media = wp('eval', `
        file_put_contents(ABSPATH . 'wp-content/uploads/inti.png', base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='));
        require_once ABSPATH . 'wp-admin/includes/image.php';
        $id = wp_insert_attachment(['post_mime_type' => 'image/png', 'post_title' => 'inti', 'post_status' => 'inherit'], ABSPATH . 'wp-content/uploads/inti.png');
        wp_update_attachment_metadata($id, wp_generate_attachment_metadata($id, ABSPATH . 'wp-content/uploads/inti.png'));
        echo $id;
    `);
    const richSlug = `rich-${Date.now()}`;
    const richId = wp('post', 'create', '--post_type=page', `--post_title=${richSlug}`, `--post_name=${richSlug}`, '--post_status=publish', '--porcelain');
    wp('eval', `update_field('content_blocks', [[
        'acf_fc_layout' => 'hero_banner', 'heading' => 'Rich', 'image' => ${media}, 'gallery' => [${media}], 'related' => [${id}],
        'link' => ['title' => 'Go', 'url' => 'https://example.com/l', 'target' => ''],
        'body' => '<p>Text <strong>rich</strong></p>', 'enabled' => 1, 'variant' => 'light',
        'cta' => ['label' => 'A', 'url' => 'https://example.com/a']
    ]], ${richId});`);
    const readRich = async () => (await adapter.fetchPageBySlug(richSlug)).blocks[0].data;
    /** What WordPress has stored, without going through the output format */
    const stored = () => JSON.parse(wp('eval', `echo wp_json_encode(get_field('content_blocks', ${richId}, false));`))[0];

    const richBefore = stored();

    await check('editing a field keeps image, gallery, relationship, link and wysiwyg', async () => {
        ok(await adapter.updateBlockField(richId, 0, 'heading', 'Rich edited'));
        const data = await readRich();
        equal(data.heading, 'Rich edited', 'heading');
        const after = stored();
        const compare = (block) => Object.fromEntries(Object.entries(block).filter(([k]) => !k.includes('heading')));
        equal(compare(after), compare(richBefore), 'stored values');
    });

    await check('moving a block keeps image and relationship', async () => {
        ok(await adapter.insertBlock(richId, 0, 'hero_banner', { heading: 'First' }));
        ok(await adapter.moveBlock(richId, 1, 0));
        const after = stored();
        const compare = (block) => Object.fromEntries(Object.entries(block).filter(([k]) => !k.includes('heading')));
        equal(compare(after), compare(richBefore), 'stored values');
    });

    // The companion plugin: same contract, another path to ACF
    const bridgeSlug = `bridge-${Date.now()}`;
    const bridgeId = createPage(bridgeSlug);
    const bridged = new WordPressAdapter({ endpoint: ENDPOINT, username: 'admin', appPassword: password, useBridgePlugin: true });
    const readBridged = async () => (await adapter.fetchPageBySlug(bridgeSlug)).blocks;

    await check('inti-bridge: edits a field and a group by dot-path', async () => {
        const first = await bridged.updateBlockField(bridgeId, 0, 'heading', 'Via the bridge');
        equal(first.source, 'wordpress-bridge', 'source');
        ok(first);
        ok(await bridged.updateBlockField(bridgeId, 0, 'cta.label', 'Bridge CTA'));
        const [hero] = await readBridged();
        equal(hero.data.heading, 'Via the bridge', 'heading');
        equal(hero.data.cta, { label: 'Bridge CTA', url: 'https://example.com/a' }, 'cta');
    });

    await check('inti-bridge: edits the right repeater item', async () => {
        ok(await bridged.updateBlockField(bridgeId, 1, 'items.1.title', 'Two via bridge'));
        const { items } = (await readBridged())[1].data;
        equal(items, [{ title: 'One', body: 'First' }, { title: 'Two via bridge', body: 'Second' }], 'items');
    });

    await check('inti-bridge: a nonexistent field fails', async () => {
        const result = await bridged.updateBlockField(bridgeId, 0, 'does_not_exist', 'x');
        equal(result.success, false, 'success');
    });

    await check('a wrong password is rejected and does not write', async () => {
        const wrong = new WordPressAdapter({ endpoint: ENDPOINT, username: 'admin', appPassword: 'bad bad', useBridgePlugin: false });
        const before = (await read())[0].data.heading;
        const result = await wrong.updateBlockField(id, 0, 'heading', 'INTRUDER');
        equal(result.success, false, 'success');
        equal((await read())[0].data.heading, before, 'heading');
    });

    await check('a draft page is not visible without credentials', async () => {
        const draft = `draft-${Date.now()}`;
        createPage(draft, 'draft');
        let visible = true;
        try {
            await anonymous.fetchPageBySlug(draft);
        } catch {
            visible = false;
        }
        equal(visible, false, 'visible');
    });

    // Drafts: a working copy the visitor does not see until it is published
    const draftSlug = `withdraft-${Date.now()}`;
    const draftOriginalId = createPage(draftSlug);
    let draftId;

    await check('creating a draft does not change what is published and is not exposed', async () => {
        const created = await adapter.createDraft(draftOriginalId);
        ok(created);
        draftId = created.documentId;
        if (draftId === draftOriginalId) throw new Error('the draft is the page itself');
        ok(await adapter.updateBlockField(draftId, 0, 'heading', 'Draft only'));

        equal((await anonymous.fetchPageBySlug(draftSlug)).blocks[0].data.heading, 'Hello', 'the published page');
        const draft = await adapter.fetchDraftBySlug(draftSlug);
        equal(draft.blocks[0].data.heading, 'Draft only', 'the draft');
        equal(draft.slug, draftSlug, 'draft slug');
        equal(draft.blocks[0].meta.documentId, draftId, 'edits go to the copy');
        const sitemap = await anonymous.listPages();
        if (sitemap.some((p) => p.slug.includes('inti-draft-of'))) throw new Error('the copy shows up in listPages');
    });

    await check('asking for a draft twice does not overwrite the work', async () => {
        const again = await adapter.createDraft(draftOriginalId);
        equal(again.documentId, draftId, 'id');
        equal((await adapter.fetchDraftBySlug(draftSlug)).blocks[0].data.heading, 'Draft only', 'content');
    });

    await check('publishing moves the draft to the page and removes the copy', async () => {
        const result = await adapter.publishDraft(draftId);
        ok(result);
        equal(result.documentId, draftOriginalId, 'published document');
        equal((await anonymous.fetchPageBySlug(draftSlug)).blocks[0].data.heading, 'Draft only', 'published');
        equal(await adapter.fetchDraftBySlug(draftSlug), null, 'copy');
    });

    await check('discarding removes the copy and leaves the published page intact', async () => {
        const created = await adapter.createDraft(draftOriginalId);
        ok(created);
        ok(await adapter.updateBlockField(created.documentId, 0, 'heading', 'Discarded'));
        ok(await adapter.discardDraft(created.documentId));
        equal((await anonymous.fetchPageBySlug(draftSlug)).blocks[0].data.heading, 'Draft only', 'published');
        equal(await adapter.fetchDraftBySlug(draftSlug), null, 'copy');
    });

    await check('discarding never removes a published page', async () => {
        const result = await adapter.discardDraft(draftOriginalId);
        equal(result.success, false, 'success');
        equal((await anonymous.fetchPageBySlug(draftSlug)).blocks.length, 2, 'blocks');
    });

    await check('a draft with an image and a relationship is published without losing them', async () => {
        const created = await adapter.createDraft(richId);
        ok(created);
        ok(await adapter.publishDraft(created.documentId));
        const compare = (block) => Object.fromEntries(Object.entries(block).filter(([k]) => !k.includes('heading')));
        equal(compare(stored()), compare(richBefore), 'stored values');
    });

    await check('listPages returns what is published with a date', async () => {
        const pages = await anonymous.listPages();
        const found = pages.find((p) => p.slug === slug);
        if (!found?.updatedAt) throw new Error('the page or its date is missing');
    });

    await fullStack(password);

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks against a real WordPress`);
    if (failed.length) process.exitCode = 1;
}

main()
    .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    })
    .finally(() => {
        if (!keep) compose('down', '-v');
    });
