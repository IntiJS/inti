/**
 * What is written is read back with Keystatic's official reader: the proof that the
 * format is its own cannot be an imitation of it.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collection, config, fields } from '@keystatic/core';
import { createReader } from '@keystatic/core/reader';

import { githubStorage, KeystaticAdapter } from '../src/index.js';
import { isDraftableAdapter, isWritableAdapter } from '../../core/src/adapters/index.js';

const keystaticConfig = config({
    storage: { kind: 'local' },
    collections: {
        pages: collection({
            label: 'Pages',
            slugField: 'title',
            path: 'content/pages/*',
            format: { data: 'yaml' },
            schema: {
                title: fields.slug({ name: { label: 'Title' } }),
                metaTitle: fields.text({ label: 'Meta title' }),
                blocks: fields.blocks(
                    {
                        hero: {
                            label: 'Hero',
                            schema: fields.object({
                                heading: fields.text({ label: 'Heading' }),
                                cta: fields.object({ label: fields.text({ label: 'Label' }), url: fields.text({ label: 'URL' }) }),
                                items: fields.array(fields.object({ title: fields.text({ label: 'Title' }) }), { label: 'Items' })
                            })
                        },
                        quote: { label: 'Quote', schema: fields.text({ label: 'Quote' }) }
                    },
                    { label: 'Blocks' }
                )
            }
        })
    }
});

const HOME = `title: Home
metaTitle: Home meta
blocks:
  - discriminant: hero
    value:
      heading: Hello
      cta:
        label: Buy
        url: https://example.com
      items:
        - title: One
        - title: Two
  - discriminant: quote
    value: A quote
`;

let root: string;
let adapter: KeystaticAdapter;
const homeFile = () => join(root, 'content/pages/home.yaml');
const official = (slug = 'home') => createReader(root, keystaticConfig).collections.pages.read(slug);

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'inti-keystatic-'));
    mkdirSync(join(root, 'content/pages'), { recursive: true });
    writeFileSync(homeFile(), HOME);
    adapter = new KeystaticAdapter({ root });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('reading', () => {
    test('declares the contracts', () => {
        expect(isWritableAdapter(adapter)).toBe(true);
        expect(isDraftableAdapter(adapter)).toBe(true);
    });

    test('converts the entry into a page', async () => {
        const page = await adapter.fetchPageBySlug('home');
        expect(page.title).toBe('Home');
        expect(page.seo?.title).toBe('Home meta');
        expect(page.blocks.map((block) => block.type)).toEqual(['hero', 'quote']);
        expect(page.blocks[0].data.cta.label).toBe('Buy');
        expect(page.blocks[1].data).toEqual({ value: 'A quote' });
        expect(page.blocks[1].meta).toMatchObject({ documentId: 'home', index: 1, total: 2 });
    });

    test('lists the pages, and files not in the format do not count', async () => {
        writeFileSync(join(root, 'content/pages/notes.txt'), 'no');
        expect(await adapter.listPages()).toEqual([{ slug: 'home', title: 'Home' }]);
    });

    test('a missing page fails with a clear error', async () => {
        await expect(adapter.fetchPageBySlug('missing')).rejects.toThrow('Page not found');
    });

    test('a slug cannot leave the folder', async () => {
        writeFileSync(join(root, 'secret.yaml'), 'title: Secret');
        for (const slug of ['../../secret', '..', 'a/b', '.env', '']) {
            await expect(adapter.fetchPageBySlug(slug)).rejects.toThrow();
        }
        const result = await adapter.updateBlockField('../../secret', -1, 'title', 'x');
        expect(result.success).toBe(false);
        expect(readFileSync(join(root, 'secret.yaml'), 'utf8')).toBe('title: Secret');
    });

    test('a YAML file with code tags is not executed', async () => {
        writeFileSync(homeFile(), 'title: !!js/function "function(){ return 1 }"\n');
        await expect(adapter.fetchPageBySlug('home')).rejects.toThrow();
    });
});

describe('writing, read back with the Keystatic reader', () => {
    test('edits a field and leaves the rest intact', async () => {
        // Intentional non-ASCII, curly quotes, ampersand and emoji to verify YAML round-trip
        const result = await adapter.updateBlockField('home', 0, 'heading', 'Add “quotes” & ñ 🌞');
        expect(result.success).toBe(true);

        const entry: any = await official();
        expect(entry.blocks[0].value.heading).toBe('Add “quotes” & ñ 🌞');
        expect(entry.blocks[0].value.cta.url).toBe('https://example.com');
        expect(entry.blocks[1]).toEqual({ discriminant: 'quote', value: 'A quote' });
        expect(entry.metaTitle).toBe('Home meta');
        expect(entry.title).toBe('Home');
    });

    test('dot-path in groups and lists', async () => {
        await adapter.updateBlockField('home', 0, 'cta.label', 'See');
        await adapter.updateBlockField('home', 0, 'items.1.title', 'Two edited');
        const { value }: any = (await official() as any).blocks[0];
        expect(value.cta).toEqual({ label: 'See', url: 'https://example.com' });
        expect(value.items).toEqual([{ title: 'One' }, { title: 'Two edited' }]);
    });

    test('a single-value block is edited through "value"', async () => {
        expect((await adapter.updateBlockField('home', 1, 'value', 'Another quote')).success).toBe(true);
        expect((await adapter.updateBlockField('home', 1, 'heading', 'x')).success).toBe(false);
        expect(((await official()) as any).blocks[1].value).toBe('Another quote');
    });

    test('a page field with index -1', async () => {
        await adapter.updateBlockField('home', -1, 'metaTitle', 'Another meta');
        expect(((await official()) as any).metaTitle).toBe('Another meta');
    });

    test('inserts, moves, duplicates and removes', async () => {
        await adapter.insertBlock('home', 1, 'hero', { heading: 'New', cta: { label: '', url: '' }, items: [] });
        await adapter.moveBlock('home', 1, 0);
        await adapter.duplicateBlock('home', 0);
        let entry: any = await official();
        expect(entry.blocks.map((b: any) => b.value.heading ?? b.value)).toEqual(['New', 'New', 'Hello', 'A quote']);

        await adapter.removeBlock('home', 1);
        entry = await official();
        expect(entry.blocks.length).toBe(3);
    });

    test('several blocks go in at once', async () => {
        await adapter.insertBlocks('home', 2, [
            { nativeType: 'quote', data: 'a' as any },
            { nativeType: 'quote', data: 'b' as any }
        ]);
        expect(((await official()) as any).blocks.slice(2).map((b: any) => b.value)).toEqual(['a', 'b']);
    });

    test('concurrent writes do not overwrite each other', async () => {
        await Promise.all(
            Array.from({ length: 10 }, (_, i) => adapter.insertBlock('home', 99, 'quote', `q${i}` as any))
        );
        expect(((await official()) as any).blocks.length).toBe(12);
    });

    test('out of range and missing document fail without writing', async () => {
        const before = readFileSync(homeFile(), 'utf8');
        expect((await adapter.updateBlockField('home', 9, 'heading', 'x')).success).toBe(false);
        expect((await adapter.removeBlock('home', 9)).success).toBe(false);
        expect((await adapter.updateBlockField('missing', 0, 'heading', 'x')).success).toBe(false);
        expect(readFileSync(homeFile(), 'utf8')).toBe(before);
    });

    test('a dot-path cannot pollute Object.prototype', async () => {
        for (const field of ['__proto__.admin', 'constructor.prototype.admin', 'cta.__proto__.admin']) {
            expect((await adapter.updateBlockField('home', 0, field, true)).success).toBe(false);
        }
        expect(({} as any).admin).toBeUndefined();
    });
});

describe('drafts', () => {
    test('the draft does not show up as a page, not even to Keystatic', async () => {
        const { documentId } = await adapter.createDraft('home');
        await adapter.updateBlockField(documentId, 0, 'heading', 'In draft');

        expect(((await official()) as any).blocks[0].value.heading).toBe('Hello');
        expect((await adapter.fetchPageBySlug('home')).blocks[0].data.heading).toBe('Hello');
        expect(await createReader(root, keystaticConfig).collections.pages.list()).toEqual(['home']);
        expect((await adapter.listPages()).length).toBe(1);

        const draft = await adapter.fetchDraftBySlug('home');
        expect(draft?.blocks[0].data.heading).toBe('In draft');
        expect(draft?.slug).toBe('home');
        expect(draft?.blocks[0].meta?.documentId).toBe(documentId);
    });

    test('requesting it twice does not overwrite the work', async () => {
        const first = await adapter.createDraft('home');
        await adapter.updateBlockField(first.documentId, 0, 'heading', 'Work');
        await adapter.createDraft('home');
        expect((await adapter.fetchDraftBySlug('home'))?.blocks[0].data.heading).toBe('Work');
    });

    test('publishing moves it to the collection and removes the copy', async () => {
        const { documentId } = await adapter.createDraft('home');
        await adapter.updateBlockField(documentId, 0, 'heading', 'Published');

        const result = await adapter.publishDraft(documentId);

        expect(result).toMatchObject({ success: true, documentId: 'home' });
        expect(((await official()) as any).blocks[0].value.heading).toBe('Published');
        expect(await adapter.fetchDraftBySlug('home')).toBeNull();
    });

    test('discarding leaves the published page intact', async () => {
        const { documentId } = await adapter.createDraft('home');
        await adapter.updateBlockField(documentId, 0, 'heading', 'No');
        await adapter.discardDraft(documentId);
        expect(((await official()) as any).blocks[0].value.heading).toBe('Hello');
        expect(await adapter.fetchDraftBySlug('home')).toBeNull();
    });

    test('publishing or discarding the published page is rejected', async () => {
        expect((await adapter.publishDraft('home')).success).toBe(false);
        expect((await adapter.discardDraft('home')).success).toBe(false);
        expect(existsSync(homeFile())).toBe(true);
    });
});

describe('other collection shapes', () => {
    test('path with a trailing slash: <slug>/index.yaml', async () => {
        mkdirSync(join(root, 'nested/home'), { recursive: true });
        writeFileSync(join(root, 'nested/home/index.yaml'), HOME);
        const nested = new KeystaticAdapter({ root, collection: 'nested/*/' });

        expect((await nested.listPages()).map((page) => page.slug)).toEqual(['home']);
        await nested.updateBlockField('home', 0, 'heading', 'Nested');
        expect(readFileSync(join(root, 'nested/home/index.yaml'), 'utf8')).toContain('Nested');
    });

    test('json format', async () => {
        mkdirSync(join(root, 'json'));
        writeFileSync(join(root, 'json/home.json'), JSON.stringify({ title: 'J', blocks: [{ discriminant: 'quote', value: 'x' }] }));
        const json = new KeystaticAdapter({ root, collection: 'json/*', format: 'json' });

        await json.updateBlockField('home', 0, 'value', 'y');
        expect(JSON.parse(readFileSync(join(root, 'json/home.json'), 'utf8')).blocks[0].value).toBe('y');
    });

    test('a collection without * is a configuration error', () => {
        expect(() => new KeystaticAdapter({ collection: 'content/pages' })).toThrow('needs a *');
    });
});

describe('githubStorage', () => {
    const TOKEN = 'ghp_secret';
    let calls: Array<{ method: string; url: string; body?: any; auth?: string }>;
    let files: Map<string, { sha: string; text: string }>;
    let original: typeof fetch;
    let rejectNextWrite: number | null;

    beforeEach(() => {
        calls = [];
        files = new Map([['content/pages/home.yaml', { sha: 's1', text: HOME }]]);
        rejectNextWrite = null;
        original = globalThis.fetch;
        globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
            const url = new URL(String(input));
            const path = decodeURIComponent(url.pathname.replace('/repos/acme/web/contents/', ''));
            const method = init.method ?? 'GET';
            const body = init.body ? JSON.parse(String(init.body)) : undefined;
            calls.push({ method, url: String(input), body, auth: (init.headers as any)?.Authorization });

            if (method === 'GET') {
                const file = files.get(path);
                if (file) return Response.json({ sha: file.sha, content: Buffer.from(file.text).toString('base64'), encoding: 'base64' });
                const children = [...files.keys()].filter((key) => key.startsWith(`${path}/`));
                if (children.length) return Response.json(children.map((key) => ({ name: key.split('/').pop() })));
                return new Response('{}', { status: 404 });
            }
            if (rejectNextWrite) return new Response('{"message":"sha mismatch"}', { status: rejectNextWrite });
            if (method === 'PUT') files.set(path, { sha: 's2', text: Buffer.from(body.content, 'base64').toString('utf8') });
            if (method === 'DELETE') files.delete(path);
            return Response.json({});
        }) as typeof fetch;
    });

    afterEach(() => {
        globalThis.fetch = original;
    });

    const github = () => new KeystaticAdapter({ storage: githubStorage({ repo: 'acme/web', token: TOKEN, branch: 'main', apiUrl: 'https://gh.test' }) });

    test('editing is a commit to the branch, with the sha it had', async () => {
        // Intentional non-ASCII value to verify UTF-8 base64 encoding against the GitHub Contents API
        expect((await github().updateBlockField('home', 0, 'heading', 'Ñandú')).success).toBe(true);

        const put = calls.find((call) => call.method === 'PUT')!;
        expect(put.body.sha).toBe('s1');
        expect(put.body.branch).toBe('main');
        expect(put.body.message).toContain('heading');
        expect(put.auth).toBe(`Bearer ${TOKEN}`);
        expect(files.get('content/pages/home.yaml')?.text).toContain('Ñandú');
    });

    test('if someone else changed the file, it fails without overwriting it or leaking the token', async () => {
        rejectNextWrite = 409;
        const result = await github().updateBlockField('home', 0, 'heading', 'x');
        expect(result.success).toBe(false);
        expect(result.error).toContain('409');
        expect(result.error).not.toContain(TOKEN);
    });

    test('lists and publishes a draft with commits', async () => {
        const adapter = github();
        expect((await adapter.listPages()).map((page) => page.slug)).toEqual(['home']);

        const { documentId } = await adapter.createDraft('home');
        expect(files.has('.inti/drafts/pages/home.yaml')).toBe(true);

        await adapter.updateBlockField(documentId, 0, 'heading', 'Draft');
        expect(files.get('content/pages/home.yaml')?.text).not.toContain('Draft');

        await adapter.publishDraft(documentId);
        expect(files.get('content/pages/home.yaml')?.text).toContain('Draft');
        expect(files.has('.inti/drafts/pages/home.yaml')).toBe(false);
    });

    test('requires repo and token', () => {
        expect(() => githubStorage({ repo: 'bad', token: 'x' })).toThrow('owner/repo');
        expect(() => githubStorage({ repo: 'a/b', token: '' })).toThrow('token');
    });
});
