import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { LocalAdapter } from '../src/adapters/local.js';
import { isDraftableAdapter } from '../src/adapters/index.js';
import { readDraftPage } from '../src/server/drafts.js';
import { registerIntiPlugin, clearIntiPlugins } from '../src/plugins/index.js';

const files: string[] = [];

async function seeded() {
    const file = join(tmpdir(), `inti-drafts-${Math.random().toString(36).slice(2)}.json`);
    files.push(file);
    const adapter = new LocalAdapter({ file });
    await adapter.putDocument({
        id: 'home',
        slug: 'home',
        title: 'Home',
        blocks: [{ type: 'Hero', data: { heading: 'Published' } }]
    });
    return { adapter, file };
}

afterEach(async () => {
    delete process.env.INTI_LOCAL_STORE;
    for (const file of files.splice(0)) await rm(file, { force: true });
});

describe('LocalAdapter: drafts', () => {
    test('declares the contract', async () => {
        expect(isDraftableAdapter((await seeded()).adapter)).toBe(true);
    });

    test('what is edited in the draft does not reach the published page', async () => {
        const { adapter } = await seeded();
        const { documentId } = await adapter.createDraft('home');

        await adapter.updateBlockField(documentId, 0, 'heading', 'Draft');

        expect((await adapter.fetchPageBySlug('home')).blocks[0].data.heading).toBe('Published');
        const draft = await adapter.fetchDraftBySlug('home');
        expect(draft?.blocks[0].data.heading).toBe('Draft');
        expect(draft?.blocks[0].meta?.documentId).toBe(documentId);
    });

    test('the copy appears neither in the sitemap nor in searches', async () => {
        const { adapter } = await seeded();
        await adapter.createDraft('home');

        expect((await adapter.listPages()).length).toBe(1);
        expect((await adapter.searchEntries('documents', '')).length).toBe(1);
    });

    test('asking for a draft twice does not overwrite the work', async () => {
        const { adapter } = await seeded();
        const first = await adapter.createDraft('home');
        await adapter.updateBlockField(first.documentId, 0, 'heading', 'Work');

        const second = await adapter.createDraft('home');

        expect(second.documentId).toBe(first.documentId);
        expect((await adapter.fetchDraftBySlug('home'))?.blocks[0].data.heading).toBe('Work');
    });

    test('publishing brings the changes to the page and removes the copy', async () => {
        const { adapter } = await seeded();
        const { documentId } = await adapter.createDraft('home');
        await adapter.updateBlockField(documentId, 0, 'heading', 'New');

        const result = await adapter.publishDraft(documentId);

        expect(result.documentId).toBe('home');
        expect((await adapter.fetchPageBySlug('home')).blocks[0].data.heading).toBe('New');
        expect(await adapter.fetchDraftBySlug('home')).toBeNull();
    });

    test('discarding leaves the published page intact', async () => {
        const { adapter } = await seeded();
        const { documentId } = await adapter.createDraft('home');
        await adapter.updateBlockField(documentId, 0, 'heading', 'New');

        await adapter.discardDraft(documentId);

        expect((await adapter.fetchPageBySlug('home')).blocks[0].data.heading).toBe('Published');
        expect(await adapter.fetchDraftBySlug('home')).toBeNull();
    });

    test('publishing or discarding a page that is not a draft is rejected', async () => {
        const { adapter } = await seeded();
        expect((await adapter.publishDraft('home')).success).toBe(false);
        expect((await adapter.discardDraft('home')).success).toBe(false);
        expect((await adapter.fetchPageBySlug('home')).blocks.length).toBe(1);
    });
});

describe('readDraftPage', () => {
    const originalEnv = process.env.NODE_ENV;

    beforeEach(() => clearIntiPlugins());
    afterEach(() => {
        clearIntiPlugins();
        process.env.NODE_ENV = originalEnv;
    });

    const request = (query = '?inti-draft=1') => ({
        url: new URL(`http://x/home${query}`),
        request: new Request(`http://x/home${query}`),
        response: { headers: new Headers() }
    });

    async function withDraft() {
        const { adapter, file } = await seeded();
        process.env.INTI_LOCAL_STORE = file;
        const { documentId } = await adapter.createDraft('home');
        await adapter.updateBlockField(documentId, 0, 'heading', 'Unpublished');
    }

    test('without the parameter it reads nothing', async () => {
        await withDraft();
        expect(await readDraftPage('home', request(''))).toBeNull();
    });

    test('in production a visitor with the parameter does not see the draft', async () => {
        await withDraft();
        process.env.NODE_ENV = 'production';
        expect(await readDraftPage('home', request())).toBeNull();
    });

    test('a plugin that does not recognize the visitor does not show it either', async () => {
        await withDraft();
        process.env.NODE_ENV = 'production';
        registerIntiPlugin({ name: 'nobody', resolveActor: () => null });
        expect(await readDraftPage('home', request())).toBeNull();
    });

    test('with an editor session it is visible, and the response is neither cached nor indexed', async () => {
        await withDraft();
        process.env.NODE_ENV = 'production';
        registerIntiPlugin({ name: 'editor', resolveActor: () => ({ id: '1', role: 'editor' }) });

        const req = request();
        const page = await readDraftPage('home', req);

        expect(page?.blocks[0].data.heading).toBe('Unpublished');
        expect(req.response.headers.get('Cache-Control')).toBe('private, no-store');
        expect(req.response.headers.get('X-Robots-Tag')).toBe('noindex');
    });
});
