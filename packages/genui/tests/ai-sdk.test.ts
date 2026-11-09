/**
 * With the real AI SDK, not an imitation of its shape: `generateText` validates
 * the tool's schema and runs it. Only the model is simulated.
 */

import { describe, test, expect } from 'bun:test';
import { generateText, jsonSchema } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { createVocabularyTool, defineVocabulary, fromData } from '../src/index.js';

const vocabulary = defineVocabulary({
    grid: { fields: { heading: { type: 'string' }, products: fromData('products') } }
});

const products = [{ id: 'p1', summary: 'Boot', value: { name: 'Boot', price: 120 } }];

function modelCalling(input: unknown) {
    return new MockLanguageModelV4({
        doGenerate: async () => ({
            content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'compose', input: JSON.stringify(input) }],
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 }
            },
            warnings: []
        })
    });
}

describe('AI SDK', () => {
    test('the agent receives validated blocks, with the server data', async () => {
        const compose = await createVocabularyTool(vocabulary, { jsonSchema, sources: { products } });

        const result = await generateText({
            model: modelCalling({ blocks: [{ nativeType: 'grid', data: { heading: 'Boots', products: ['p1'] } }] }),
            tools: { compose } as any,
            prompt: 'boots'
        });

        const output: any = result.toolResults[0].output;
        expect(output.blocks[0].data.products).toEqual(['p1']);
        expect(output.rendered[0].data.products[0].price).toBe(120);
        expect(output.warnings).toEqual([]);
    });

    test('the model receives the schema derived from the vocabulary', async () => {
        const compose = await createVocabularyTool(vocabulary, { jsonSchema, sources: { products } });
        const model = modelCalling({ blocks: [] });

        await generateText({ model, tools: { compose } as any, prompt: 'boots' });

        const tool: any = model.doGenerateCalls[0].tools?.[0];
        const schema = JSON.stringify(tool.inputSchema);
        expect(tool.name).toBe('compose');
        expect(schema).toContain('"const":"grid"');
        expect(schema).toContain('"enum":["p1"]');
    });
});
