/**
 * The public read never returns a draft.
 *
 * `locate()` maps `draft:<slug>` to the working copy so the draft APIs can address it,
 * and `fetchPageBySlug` used it too: a visitor requesting /draft:home received the
 * unpublished draft (found by a 2026-11 audit and reproduced against this adapter).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KeystaticAdapter } from '../src/index.js';

let root: string;
let adapter: KeystaticAdapter;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'inti-keystatic-draft-'));
    mkdirSync(join(root, 'content/pages'), { recursive: true });
    writeFileSync(
        join(root, 'content/pages/home.yaml'),
        'title: Home\nblocks:\n  - discriminant: hero\n    value:\n      heading: Published heading\n'
    );
    adapter = new KeystaticAdapter({ root });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('drafts stay private', () => {
    test('a draft: slug is not found on the public read', async () => {
        await adapter.createDraft('home');
        await adapter.updateBlockField('draft:home', 0, 'heading', 'Unreleased pricing', {});

        await expect(adapter.fetchPageBySlug('draft:home')).rejects.toMatchObject({ name: 'NotFoundError' });
        expect((await adapter.fetchPageBySlug('home')).blocks[0].data.heading).toBe('Published heading');
    });

    test('the editor still reads the draft through the draft API', async () => {
        await adapter.createDraft('home');
        await adapter.updateBlockField('draft:home', 0, 'heading', 'Unreleased pricing', {});
        expect((await adapter.fetchDraftBySlug('home'))?.blocks[0].data.heading).toBe('Unreleased pricing');
    });

    test('draftOriginId names the page a draft overwrites', async () => {
        expect(await adapter.draftOriginId('draft:home')).toBe('home');
        expect(await adapter.draftOriginId('home')).toBeNull();
        expect(await adapter.draftOriginId('draft:../x')).toBeNull();
    });
});
