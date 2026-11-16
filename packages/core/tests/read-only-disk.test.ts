import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { LocalAdapter } from '../src/adapters/local.js';
import { createFilePatternStore } from '../src/team/patterns.js';
import { explainDiskWrite, onServerlessPlatform } from '../src/adapters/disk.js';

/**
 * On Vercel, Netlify or AWS Lambda a function's disk is read-only (or gone between calls).
 * The local store and the file pattern store write JSON next to the app, so there a write
 * failed with a bare `EROFS: read-only file system` and no hint of what to do.
 */

const readOnly = () => Object.assign(new Error("EROFS: read-only file system, open '/var/task/.inti/x.tmp'"), { code: 'EROFS' });

let spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
    spies.forEach((spy) => spy.mockRestore());
    spies = [];
});

function diskIsReadOnly() {
    spies.push(spyOn(fsp, 'writeFile').mockImplementation(async () => {
        throw readOnly();
    }));
}

describe('a read-only disk', () => {
    test('the local store says the disk is read-only and to configure a CMS', async () => {
        const file = join(tmpdir(), `inti-ro-${Date.now()}`, 'content.json');
        const local = new LocalAdapter({ file });
        await local.putDocument({ id: 'home', slug: 'home', title: 'Home', blocks: [{ type: 'Hero', data: { title: 'a' } }] });

        diskIsReadOnly();
        const result = await local.updateBlockField('home', 0, 'title', 'x');
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/read-only/);
        expect(result.error).toMatch(/INTI_ADAPTER/);
        expect(result.error).toMatch(/Serverless/);
    });

    test('the file pattern store says to keep patterns elsewhere', async () => {
        diskIsReadOnly();
        const store = createFilePatternStore(join(tmpdir(), `inti-ro-patterns-${Date.now()}.json`));
        const error = await store.save({ name: 'p', blocks: [] } as never).catch((e: Error) => e);
        expect(String((error as Error).message)).toMatch(/read-only/);
        expect(String((error as Error).message)).toMatch(/createCustomPatternStore/);
    });

    test('other failures pass through untouched', () => {
        const other = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        expect(explainDiskWrite(other, 'f', 'x')).toBe(other);
        expect(explainDiskWrite(new Error('plain'), 'f', 'x')).toBeInstanceOf(Error);
    });

    test('serverless platforms are recognised by their environment', () => {
        expect(onServerlessPlatform({ VERCEL: '1' })).toBe(true);
        expect(onServerlessPlatform({ NETLIFY: 'true' })).toBe(true);
        expect(onServerlessPlatform({ AWS_LAMBDA_FUNCTION_NAME: 'fn' })).toBe(true);
        expect(onServerlessPlatform({})).toBe(false);
    });
});
