/**
 * Flow recipes (I6): the serializable shape edited by the visual builder.
 *
 * Fixed here: validateRecipe rejects what cannot run; runRecipe executes the
 * SAME JSON the builder exports (personalize wraps the request, cache wraps
 * generation), and a round-trip through JSON changes nothing.
 */
import { describe, expect, test } from 'bun:test';

import { defineVocabulary, recipeToPipeline, runRecipe, validateRecipe } from '../src/index.js';
import type { AiProvider, FlowRecipe } from '../src/index.js';

const vocabulary = defineVocabulary({
    hero: {
        label: 'Hero',
        fields: { heading: { type: 'string', maxLength: 30 } }
    }
});

const raw = { blocks: [{ nativeType: 'hero', data: { heading: 'Hello' } }] };

function provider(): { ai: AiProvider; calls: () => number } {
    let n = 0;
    return {
        ai: { generate: async () => (n++, raw) },
        calls: () => n
    };
}

const validRecipe: FlowRecipe = {
    version: 1,
    instruction: 'A landing hero',
    stages: [{ id: 'personalize', with: '[variant: returning]' }, { id: 'generate' }, { id: 'cache', ttlSeconds: 60 }]
};

describe('validateRecipe', () => {
    test('accepts a well-formed recipe', () => {
        expect(() => validateRecipe(validRecipe)).not.toThrow();
    });

    test('requires instruction, stages, and one generate stage', () => {
        expect(() => validateRecipe({ ...validRecipe, instruction: '' })).toThrow(/instruction/);
        expect(() => validateRecipe({ ...validRecipe, stages: [] })).toThrow(/stages/);
        expect(() =>
            validateRecipe({ ...validRecipe, stages: [{ id: 'cache' }] })
        ).toThrow(/generate/);
        expect(() =>
            validateRecipe({
                ...validRecipe,
                stages: [{ id: 'generate' }, { id: 'generate' }]
            })
        ).toThrow(/only one generate/);
    });

    test('personalize requires "with" and cache requires a valid ttl', () => {
        expect(() =>
            validateRecipe({ ...validRecipe, stages: [{ id: 'personalize' }, { id: 'generate' }] })
        ).toThrow(/with/);
        expect(() =>
            validateRecipe({
                ...validRecipe,
                stages: [{ id: 'generate' }, { id: 'cache', ttlSeconds: -1 }]
            })
        ).toThrow(/ttlSeconds/);
    });

    test('cache stage requires deps.cache when loading', () => {
        const { ai } = provider();
        expect(() =>
            recipeToPipeline(validRecipe, { provider: ai, options: { vocabulary } })
        ).toThrow(/deps.cache/);
    });
});

describe('runRecipe', () => {
    const inMemoryCache = () => {
        const store = new Map<string, unknown>();
        return {
            get: async (k: string) => store.get(k) ?? null,
            set: async (k: string, v: unknown) => void store.set(k, v)
        };
    };

    test('executes exported JSON: generates and validates', async () => {
        const { ai } = provider();
        const result = await runRecipe(
            JSON.parse(JSON.stringify(validRecipe)) as FlowRecipe,
            { provider: ai, cache: inMemoryCache(), options: { vocabulary } }
        );
        expect(result.blocks).toHaveLength(1);
        expect(result.blocks[0]!.nativeType).toBe('hero');
    });

    test('cache stage avoids a second call to the provider', async () => {
        const { ai, calls } = provider();
        const deps = { provider: ai, cache: inMemoryCache(), options: { vocabulary } };
        const recipe = JSON.parse(JSON.stringify(validRecipe)) as FlowRecipe;
        await runRecipe(recipe, deps);
        await runRecipe(recipe, deps);
        expect(calls()).toBe(1);
    });

    test('personalize reaches the provider in the prompt', async () => {
        let calls = 0;
        const deps = {
            provider: {
                generate: async (req: { prompt: string }) => {
                    calls++;
                    expect(req.prompt).toContain('[variant: returning]');
                    return raw;
                }
            },
            cache: inMemoryCache(),
            options: { vocabulary }
        };
        await runRecipe(JSON.parse(JSON.stringify(validRecipe)) as FlowRecipe, deps);
        expect(calls).toBe(1);
    });
});
