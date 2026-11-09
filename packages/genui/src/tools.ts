/**
 * The vocabulary as a tool for other agents.
 *
 * Inti does not compete with the AI SDK or ship its own chat: an existing agent
 * calls this tool and gets validated blocks, under the same rules as the editor.
 * It does not import `ai`: the caller passes its own `jsonSchema`, so this
 * package does not depend on a specific version.
 */

import { buildBlockSchema } from './schema.js';
import type { Candidates } from './schema.js';
import { validateGenerated } from './validate.js';
import type { ValidationResult } from './validate.js';
import { sourcesUsed } from './vocabulary.js';
import type { DataSources, Vocabulary } from './vocabulary.js';

export interface VocabularyToolOptions<Schema> {
    /** `jsonSchema` from `ai` */
    jsonSchema: (schema: Record<string, unknown>) => Schema;
    /** Sources resolved in advance: the schema needs them when the tool is created */
    sources?: DataSources;
    prompt?: string;
    max?: number;
    description?: string;
}

const DESCRIPTION =
    'Compose page sections from the declared blocks. Pass the blocks in the order they should appear. ' +
    'Unknown types and fields are discarded, and the result lists anything that was.';

/** Tool compatible with the AI SDK's `streamText({ tools })` */
export async function createVocabularyTool<Schema>(vocabulary: Vocabulary, options: VocabularyToolOptions<Schema>) {
    const candidates: Candidates = {};
    for (const name of sourcesUsed(vocabulary)) {
        const source = options.sources?.[name];
        if (!source) throw new Error(`createVocabularyTool: missing data source "${name}".`);
        candidates[name] = typeof source === 'function' ? await source(options.prompt ?? '') : source;
    }

    return {
        description: options.description ?? DESCRIPTION,
        inputSchema: options.jsonSchema(buildBlockSchema(vocabulary, candidates)),
        execute: async (input: unknown): Promise<ValidationResult> =>
            validateGenerated(input, vocabulary, { max: options.max, candidates })
    };
}
