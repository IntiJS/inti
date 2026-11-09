/**
 * The real MCP server: the binary is started and spoken to over stdio with the
 * official client, just as Claude Code or Cursor would.
 */

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

setDefaultTimeout(30_000);

const BIN = resolve(import.meta.dir, '../bin/inti-mcp.js');

const STORE = {
    documents: {
        home: {
            id: 'home',
            slug: 'home',
            title: 'Inicio',
            blocks: [{ type: 'Hero', data: { heading: 'Hola' } }]
        }
    }
};

const VOCABULARY = {
    blocks: [{ nativeType: 'Hero', fields: { heading: { type: 'string', maxLength: 40 } } }]
};

let dir: string;
let store: string;

async function connect(env: Record<string, string> = {}) {
    const transport = new StdioClientTransport({
        command: 'node',
        args: [BIN],
        env: { ...(process.env as Record<string, string>), INTI_ADAPTER: 'local', INTI_LOCAL_STORE: store, ...env },
        stderr: 'ignore'
    });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport);
    return client;
}

const text = (result: any): string => result.content[0].text;
const saved = () => JSON.parse(readFileSync(store, 'utf8')).documents;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'inti-mcp-'));
    store = join(dir, 'content.json');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('MCP server over stdio', () => {
    test('an agent reads, edits, composes in a draft and publishes', async () => {
        writeFileSync(store, JSON.stringify(STORE));
        const client = await connect();

        try {
            const { tools } = await client.listTools();
            const names = tools.map((tool) => tool.name);
            for (const name of ['inti_get_page', 'inti_update_field', 'inti_insert_blocks', 'inti_create_draft', 'inti_publish_draft']) {
                expect(names).toContain(name);
            }

            const page = JSON.parse(text(await client.callTool({ name: 'inti_get_page', arguments: { slug: 'home' } })));
            expect(page.documentId).toBe('home');
            expect(page.blocks[0].data.heading).toBe('Hola');

            const edit = await client.callTool({
                name: 'inti_update_field',
                arguments: { documentId: 'home', blockIndex: 0, field: 'heading', value: 'Editado por agente' }
            });
            expect(edit.isError).toBe(false);
            expect(saved().home.blocks[0].data.heading).toBe('Editado por agente');

            const draft = JSON.parse(text(await client.callTool({ name: 'inti_create_draft', arguments: { documentId: 'home' } })));

            await client.callTool({
                name: 'inti_insert_blocks',
                arguments: { documentId: draft.draftDocumentId, index: 1, blocks: [{ nativeType: 'Hero', data: { heading: 'Nuevo' } }] }
            });
            expect(saved().home.blocks.length).toBe(1);
            expect(saved()[draft.draftDocumentId].blocks.length).toBe(2);

            const publish = await client.callTool({ name: 'inti_publish_draft', arguments: { documentId: draft.draftDocumentId } });
            expect(publish.isError).toBe(false);
            expect(saved().home.blocks.length).toBe(2);
            expect(saved()[draft.draftDocumentId]).toBeUndefined();
        } finally {
            await client.close();
        }
    });

    test('a CMS error or an invalid argument reaches the agent without bringing down the server', async () => {
        writeFileSync(store, JSON.stringify(STORE));
        const client = await connect();

        try {
            const missing = await client.callTool({ name: 'inti_get_page', arguments: { slug: 'does-not-exist' } });
            expect(missing.isError).toBe(true);

            const invalid = await client.callTool({ name: 'inti_update_field', arguments: { documentId: 'home' } });
            expect(invalid.isError).toBe(true);

            const page = await client.callTool({ name: 'inti_get_page', arguments: { slug: 'home' } });
            expect(page.isError).toBe(false);
        } finally {
            await client.close();
        }
    });

    test('in read-only mode the write tools do not exist', async () => {
        writeFileSync(store, JSON.stringify(STORE));
        const client = await connect({ INTI_MCP_READONLY: '1' });

        try {
            const { tools } = await client.listTools();
            expect(tools.map((tool) => tool.name)).not.toContain('inti_update_field');

            const refused = await client.callTool({
                name: 'inti_update_field',
                arguments: { documentId: 'home', blockIndex: 0, field: 'heading', value: 'x' }
            });
            expect(refused.isError).toBe(true);
            expect(saved().home.blocks[0].data.heading).toBe('Hola');
        } finally {
            await client.close();
        }
    });

    test('with a vocabulary, what is not declared is not written', async () => {
        writeFileSync(store, JSON.stringify(STORE));
        const vocabularyFile = join(dir, 'vocabulary.json');
        writeFileSync(vocabularyFile, JSON.stringify(VOCABULARY));
        const client = await connect({ INTI_MCP_VOCABULARY: vocabularyFile });

        try {
            const listed = JSON.parse(text(await client.callTool({ name: 'inti_get_vocabulary', arguments: {} })));
            expect(listed.blocks[0].nativeType).toBe('Hero');

            const unknown = await client.callTool({
                name: 'inti_insert_blocks',
                arguments: { documentId: 'home', index: 1, blocks: [{ nativeType: 'Invented', data: {} }] }
            });
            expect(unknown.isError).toBe(true);
            expect(text(unknown)).toContain('Invented');

            const badField = await client.callTool({
                name: 'inti_insert_block',
                arguments: { documentId: 'home', index: 1, nativeType: 'Hero', data: { heading: 'x', css: 'color:red' } }
            });
            expect(badField.isError).toBe(true);
            expect(saved().home.blocks.length).toBe(1);

            const good = await client.callTool({
                name: 'inti_insert_blocks',
                arguments: { documentId: 'home', index: 1, blocks: [{ nativeType: 'Hero', data: { heading: 'Vale' } }] }
            });
            expect(good.isError).toBe(false);
            expect(saved().home.blocks.length).toBe(2);
        } finally {
            await client.close();
        }
    });

    test('an unreadable vocabulary prevents startup instead of allowing unchecked writes', async () => {
        writeFileSync(store, JSON.stringify(STORE));
        await expect(connect({ INTI_MCP_VOCABULARY: join(dir, 'does-not-exist.json') })).rejects.toThrow();
    });
});
