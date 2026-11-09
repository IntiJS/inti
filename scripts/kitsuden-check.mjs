#!/usr/bin/env node
/**
 * Checks @intijs/adapter-kitsuden against a real Kitsuden.
 *
 * It starts a throwaway instance in Docker, with its own project, network, volumes and
 * port, and walks through every operation, reading the result back from the API
 * afterwards. It is destroyed at the end. It never connects to another installation.
 *
 * It also compares the real responses with the adapter's reference file:
 * if the API changes shape, it shows up here even if the contract was not copied.
 *
 * Usage: node scripts/kitsuden-check.mjs [--keep]
 *        Requires Docker, `npm run build` and a Kitsuden image
 *        (KITSUDEN_API_IMAGE, kitsuden/api:latest by default).
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = join(ROOT, 'scripts/kitsuden-check/docker-compose.yml');
const ENDPOINT = 'http://127.0.0.1:43490';
const keep = process.argv.includes('--keep');

const compose = (...args) =>
    execFileSync('docker', ['compose', '-f', COMPOSE, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const sql = (statement) =>
    compose('exec', '-T', 'db', 'psql', '-U', 'kitsuden', '-d', 'kitsuden', '-tA', '-c', statement);

async function waitForApi() {
    for (let i = 0; i < 90; i++) {
        const up = await fetch(`${ENDPOINT}/api/version`).then((r) => r.ok).catch(() => false);
        if (up) return;
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Kitsuden did not start:\n${compose('logs', 'api', '--tail', '30')}`);
}

/**
 * An agent key with only the permission Inti asks for. It is inserted directly,
 * with the SHA-256 hash the API still accepts: creating it through the API would
 * require an admin account, and this instance has none.
 */
function createAgentKey() {
    const token = `kitsuden_agent_machine_${randomBytes(24).toString('hex')}`;
    const hash = createHash('sha256').update(token).digest('hex');
    const id = `inti-check-${randomBytes(6).toString('hex')}`;

    // Without the default quota of 60 requests per minute: many are made in a row here
    sql(`INSERT INTO agent_identities (id, name, type, scopes, is_active, rate_limit)
         VALUES ('${id}', 'inti-check', 'machine', '["content:edit"]', true, 100000)`);
    sql(`INSERT INTO agent_api_keys (agent_id, key_hash, key_prefix, algorithm)
         VALUES ('${id}', '${hash}', 'kitsuden_agent_machine', 'sha256')`);
    return token;
}

const results = [];

async function check(name, run) {
    try {
        await run();
        results.push({ name, ok: true });
        console.log(`✓ ${name}`);
    } catch (error) {
        results.push({ name, ok: false });
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

/** An object's keys, recursively: the shape, not the values */
function shape(value, path = '', out = new Set()) {
    if (Array.isArray(value)) {
        if (value.length > 0) shape(value[0], `${path}[]`, out);
    } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            out.add(`${path}.${key}`);
            shape(child, `${path}.${key}`, out);
        }
    }
    return out;
}

async function main() {
    compose('up', '-d', '--wait');
    await waitForApi();
    const token = createAgentKey();

    const { KitsudenAdapter, SUPPORTED_CONTRACTS, toGeneratorBlockTypes } = await import(
        pathToFileURL(join(ROOT, 'packages/adapter-kitsuden/dist/index.js')).href
    );
    const adapter = new KitsudenAdapter({ endpoint: ENDPOINT, token });
    const anonymous = new KitsudenAdapter({ endpoint: ENDPOINT });

    const api = async (method, path, body) => {
        const response = await fetch(`${ENDPOINT}${path}`, {
            method,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 300)}`);
        return text ? JSON.parse(text) : null;
    };

    const slug = `page-${Date.now()}`;
    const created = await api('POST', '/api/page-builder/pages', {
        title: 'Test page',
        slug,
        status: 'published',
        metaTitle: 'Meta original',
        blocks: [
            { type: 'hero', content: { headline: 'Hello', alignment: 'center' } },
            { type: 'richtext', content: { content: '<p>Text</p>' } },
            { type: 'divider', content: {} }
        ]
    });
    const id = created.id;
    const read = async () => (await anonymous.getPage(slug)).blocks;

    await check('the API version is compatible with the adapter', async () => {
        const version = await adapter.checkCompatibility(['page-builder']);
        const declared = version.contracts['page-builder'];
        const [min, max] = SUPPORTED_CONTRACTS['page-builder'];
        if (declared < min || declared > max) throw new Error(`contract ${declared} outside ${min}-${max}`);
        console.log(`    (Kitsuden ${version.version}, page-builder ${declared})`);
    });

    await check('the real responses have the shape of the reference file', async () => {
        const reference = JSON.parse(
            readFileSync(join(ROOT, 'packages/adapter-kitsuden/tests/contract/reference-responses.json'), 'utf8')
        );
        const pageCase = reference.cases.find((c) => c.template === 'GET /api/page-builder/pages/:id');
        const typesCase = reference.cases.find((c) => c.template === 'GET /api/page-builder/block-types');

        const compare = (expected, actual, label) => {
            const real = shape(actual);
            const missing = [...shape(expected)].filter((key) => !real.has(key));
            if (missing.length > 0) throw new Error(`${label} no longer includes: ${missing.slice(0, 8).join(', ')}`);
        };
        compare(pageCase.body, await api('GET', `/api/page-builder/pages/${id}`), 'a page');
        compare(typesCase.body, await api('GET', '/api/page-builder/block-types'), 'the block types');
    });

    await check('reads a published page without credentials', async () => {
        const page = await anonymous.getPage(slug);
        equal(page.blocks.map((b) => b.type), ['hero', 'richtext', 'divider'], 'types');
        equal(page.blocks.map((b) => b.meta.index), [0, 1, 2], 'indexes');
        equal(page.seo?.title, 'Meta original', 'SEO');
    });

    await check('listPages includes the page', async () => {
        const pages = await anonymous.listPages();
        if (!pages.some((p) => p.slug === slug)) throw new Error('missing from the list');
    });

    await check('edits a field without touching the rest of the block', async () => {
        // Intentional non-ASCII, curly quotes and emoji to verify UTF-8 round-trip
        ok(await adapter.updateBlockField(id, 0, 'headline', 'Edited “with” accents ñ 🌞'));
        const [hero] = await read();
        equal(hero.data.headline, 'Edited “with” accents ñ 🌞', 'headline');
        equal(hero.data.alignment, 'center', 'alignment');
    });

    await check('editing a block does not touch the others', async () => {
        const before = (await read())[1].data;
        ok(await adapter.updateBlockField(id, 0, 'subheadline', 'Sub'));
        equal((await read())[1].data, before, 'neighbor');
    });

    await check('without a token nothing can be written', async () => {
        const result = await anonymous.updateBlockField(id, 0, 'headline', 'INTRUDER');
        equal(result.success, false, 'success');
        if ((await read())[0].data.headline === 'INTRUDER') throw new Error('it was written');
    });

    await check('a fake token is rejected', async () => {
        const fake = new KitsudenAdapter({ endpoint: ENDPOINT, token: 'kitsuden_agent_machine_fake' });
        equal((await fake.updateBlockField(id, 0, 'headline', 'INTRUDER')).success, false, 'success');
    });

    await check('inserts, moves, duplicates and removes', async () => {
        ok(await adapter.insertBlock(id, 1, 'hero', { headline: 'Inserted' }));
        equal((await read()).map((b) => b.data.headline ?? b.type), ['Edited “with” accents ñ 🌞', 'Inserted', 'richtext', 'divider'], 'after inserting');

        ok(await adapter.moveBlock(id, 1, 0));
        equal((await read())[0].data.headline, 'Inserted', 'after moving');

        ok(await adapter.duplicateBlock(id, 0));
        equal((await read())[1].data.headline, 'Inserted', 'after duplicating');

        ok(await adapter.removeBlock(id, 1));
        ok(await adapter.removeBlock(id, 0));
        equal((await read()).length, 3, 'after removing');
    });

    await check('inserts several blocks at once', async () => {
        ok(await adapter.insertBlocks(id, 1, [
            { nativeType: 'hero', data: { headline: 'L1' } },
            { nativeType: 'hero', data: { headline: 'L2' } }
        ]));
        equal((await read()).slice(1, 3).map((b) => b.data.headline), ['L1', 'L2'], 'order');
        ok(await adapter.removeBlock(id, 2));
        ok(await adapter.removeBlock(id, 1));
    });

    await check('a type outside the palette is rejected without writing', async () => {
        const before = (await read()).length;
        equal((await adapter.insertBlock(id, 0, 'made-up', {})).success, false, 'success');
        equal((await read()).length, before, 'total');
    });

    await check('an out-of-range index fails without writing', async () => {
        equal((await adapter.updateBlockField(id, 99, 'headline', 'x')).success, false, 'success');
    });

    // Hidden blocks: they share the order scale and do not show up in the public read
    await check('a hidden block does not reach the visitor', async () => {
        const rows = (await api('GET', `/api/page-builder/pages/${id}`)).blocks;
        const divider = rows.find((row) => row.type === 'divider');
        await api('PATCH', `/api/page-builder/blocks/${divider.id}`, { isVisible: false });
        equal((await read()).map((b) => b.type), ['hero', 'richtext'], 'visible');
    });

    // Drafts
    let draftId;

    await check('a draft does not change what is published and is not exposed', async () => {
        const draft = await adapter.createDraft(id);
        ok(draft);
        draftId = draft.documentId;
        if (draftId === id) throw new Error('the draft is the page itself');

        ok(await adapter.updateBlockField(draftId, 0, 'headline', 'Draft only'));

        equal((await read())[0].data.headline, 'Edited “with” accents ñ 🌞', 'the published page');

        const seen = await adapter.fetchDraftBySlug(slug);
        equal(seen.blocks[0].data.headline, 'Draft only', 'the draft');
        equal(seen.slug, slug, 'slug');
        equal(seen.blocks[0].meta.documentId, draftId, 'edits go to the copy');

        const hidden = await anonymous.getPage(`inti-draft-of-${id}`).then(() => false).catch(() => true);
        equal(hidden, true, 'the copy is not visible without credentials');
        const list = await anonymous.listPages();
        if (list.some((p) => p.slug.startsWith('inti-draft-of-'))) throw new Error('the copy is in the list');
    });

    await check('asking for the draft twice does not overwrite the work', async () => {
        equal((await adapter.createDraft(id)).documentId, draftId, 'id');
        equal((await adapter.fetchDraftBySlug(slug)).blocks[0].data.headline, 'Draft only', 'content');
    });

    await check('publishing moves the draft to the page, with the same id, and removes the copy', async () => {
        ok(await adapter.insertBlock(draftId, 1, 'hero', { headline: 'New in draft' }));

        const result = await adapter.publishDraft(draftId);
        ok(result);
        equal(result.documentId, id, 'document');

        const page = await anonymous.getPage(slug);
        equal(page.id, id, 'page id');
        equal(page.blocks.map((b) => b.data.headline ?? b.type), ['Draft only', 'New in draft', 'richtext'], 'blocks');
        equal(await adapter.fetchDraftBySlug(slug), null, 'copy');
    });

    await check('a hidden block stays hidden when publishing', async () => {
        // The API returns hidden blocks to no one: check the database
        const rows = sql(`SELECT type, is_visible FROM block_contents WHERE page_id = '${id}' AND type = 'divider'`);
        equal(rows, 'divider|f', 'hidden row');
        equal((await read()).some((b) => b.type === 'divider'), false, 'visible');
    });

    await check('discarding removes the copy and leaves the published page intact', async () => {
        const draft = await adapter.createDraft(id);
        ok(draft);
        ok(await adapter.updateBlockField(draft.documentId, 0, 'headline', 'Discarded'));
        ok(await adapter.discardDraft(draft.documentId));
        equal((await read())[0].data.headline, 'Draft only', 'published');
        equal(await adapter.fetchDraftBySlug(slug), null, 'copy');
    });

    await check('discarding never removes a published page', async () => {
        equal((await adapter.discardDraft(id)).success, false, 'success');
        equal((await read()).length, 3, 'blocks');
    });

    await check('a new draft page is published in place', async () => {
        const newSlug = `new-${Date.now()}`;
        const page = await api('POST', '/api/page-builder/pages', { title: 'New', slug: newSlug, status: 'draft', blocks: [{ type: 'hero', content: { headline: 'N' } }] });

        const found = await adapter.fetchDraftBySlug(newSlug);
        equal(found.blocks[0].data.headline, 'N', 'draft');
        ok(await adapter.publishDraft(page.id));
        equal((await anonymous.getPage(newSlug)).blocks[0].data.headline, 'N', 'published');
    });

    // Real vocabulary
    await check('the real vocabulary offers no media without a source, and with one they are references', async () => {
        const types = await adapter.blockTypes();
        const hero = (list) => list.find((t) => t.nativeType === 'hero');

        const plain = toGeneratorBlockTypes(types);
        equal(hero(plain).fields.mediaId, undefined, 'mediaId without a source');

        const withSource = toGeneratorBlockTypes(types, { mediaSource: 'media' });
        equal(hero(withSource).fields.mediaId?.type, 'media', 'type');
        equal(hero(withSource).fields.mediaId?.source, 'media', 'source');
    });

    await check('the media catalog is still reserved for the team, as mediaAsData assumes', async () => {
        const response = await fetch(`${ENDPOINT}/api/media`, { headers: { Authorization: `Bearer ${token}` } });
        equal(response.status, 403, 'status');
        const [item] = adapter.mediaAsData([{ id: 'abc', summary: 'Photo' }]);
        equal(item.value.url, `${ENDPOINT}/api/media/preset/abc/large`, 'url');
    });

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks against a real Kitsuden`);
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
