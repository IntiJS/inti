/**
 * Inti's MCP server over stdio.
 *
 * Exposes the WritableAdapter contract as Model Context Protocol tools, so
 * that an agent (Claude Code, Cursor, Claude Desktop) can read and edit the
 * CMS content with the same operations the browser's inline editing uses.
 *
 * IMPORTANT: over stdio, stdout is the protocol channel. Every log goes to
 * stderr — a console.log would break the connection with the client.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolveWriteAdapter, env } from '@intijs/core/server';

import { readFileSync } from 'node:fs';

import { createToolRegistry } from './tools.js';
import type { AgentVocabulary } from './tools.js';

/** Version advertised to the MCP client */
const VERSION = '0.1.0';

function log(message: string): void {
    process.stderr.write(`[inti-mcp] ${message}\n`);
}

export async function startServer(): Promise<void> {
    const adapter = await resolveWriteAdapter();

    if (!adapter) {
        const configured = env('INTI_ADAPTER');
        log(
            configured && configured !== 'local'
                ? `Adapter "${configured}" could not be resolved or does not support write-back.\n` +
                      `  Check that @intijs/adapter-${configured} is installed and its INTI_* credentials are set.`
                : 'No CMS adapter configured. Set INTI_ADAPTER (e.g. "wordpress") plus its credentials.\n' +
                      '  See .env.example for the full list of variables.'
        );
        process.exit(1);
    }

    const readOnly = /^(1|true|yes)$/i.test(env('INTI_MCP_READONLY') ?? '');
    const vocabularyFile = env('INTI_MCP_VOCABULARY');
    let vocabulary: AgentVocabulary | undefined;
    if (vocabularyFile) {
        try {
            const parsed = JSON.parse(readFileSync(vocabularyFile, 'utf8'));
            vocabulary = Array.isArray(parsed) ? { blocks: parsed } : parsed;
        } catch (error) {
            // Without a vocabulary an agent could write anything: do not start
            log(`Could not read INTI_MCP_VOCABULARY (${vocabularyFile}): ${error instanceof Error ? error.message : error}`);
            process.exit(1);
        }
    }

    const registry = createToolRegistry(adapter, { readOnly, vocabulary });
    const tools = registry.list();

    const server = new Server({ name: 'inti', version: VERSION }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const result = await registry.call(name, (args ?? {}) as Record<string, unknown>);

        return {
            content: [{ type: 'text' as const, text: result.text }],
            isError: !result.ok
        };
    });

    await server.connect(new StdioServerTransport());

    log(
        `Connected — adapter "${adapter.name}", ${tools.length} tools${readOnly ? ' (read-only mode)' : ''}: ` +
            tools.map((t) => t.name).join(', ')
    );
}
