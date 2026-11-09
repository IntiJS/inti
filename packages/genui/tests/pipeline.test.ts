/**
 * Composition pipeline (I5): frames through replaceable stages.
 *
 * Fixed here: the default pipeline validates exactly like `compose()`; a
 * swapped stage (cache, personalization) changes HOW a frame is produced,
 * never the output contract (a `ValidationResult`).
 */
import { describe, expect, test } from 'bun:test';

import {
    cachedGeneration,
    createComposePipeline,
    personalizedRequest,
    validateGenerated,
    defineVocabulary
} from '../src/index.js';
import type { AiProvider, ComposeOptions } from '../src/index.js';

const vocabulary = defineVocabulary({
    hero: {
        label: 'Hero',
        fields: {
            heading: { type: 'string', maxLength: 30 },
            body: { type: 'richtext' }
        }
    }
});

const fakeProvider = (raw: unknown): AiProvider => ({ generate: async () => raw });

function options(provider: AiProvider, prompt = 'A landing hero'): ComposeOptions {
    return { prompt, vocabulary, provider };
}

const validRaw = {
    blocks: [{ nativeType: 'hero', data: { heading: 'Hello', body: '<p>Welcome</p>' } }]
};

describe('createComposePipeline', () => {
    test('the default pipeline validates like compose()', async () => {
        const pipeline = createComposePipeline(options(fakeProvider(validRaw)));
        const result = await pipeline.run(options(fakeProvider(validRaw)));
        expect(result.warnings).toEqual([]);
        expect(result.blocks).toHaveLength(1);
        expect(result.blocks[0]!.nativeType).toBe('hero');
    });

    test('each stage is replaceable without touching the others', async () => {
        let sawRequest = '';
        const pipeline = createComposePipeline(options(fakeProvider(validRaw)), {
            generate: async (frame) => {
                sawRequest = frame.request.prompt;
                return { kind: 'generation', raw: validRaw, context: frame };
            }
        });
        await pipeline.run(options(fakeProvider(validRaw)));
        expect(sawRequest).toContain('A landing hero');
    });

    test('a provider that invents a type is rejected just as with compose()', async () => {
        const invalid = { blocks: [{ type: 'non-existent', props: {} }] };
        const direct = validateGenerated(invalid, vocabulary, { max: 12 });
        const pipeline = createComposePipeline(options(fakeProvider(invalid)));
        const viaPipeline = await pipeline.run(options(fakeProvider(invalid)));
        // Anything the model invents is DISCARDED: the vocabulary is the contract.
        expect(viaPipeline.blocks).toEqual(direct.blocks);
        expect(direct.blocks).toHaveLength(0);
    });
});

describe('cachedGeneration', () => {
    test('a second identical generate call does not call the provider', async () => {
        const store = new Map<string, unknown>();
        const cache = {
            get: async (k: string) => store.get(k) ?? null,
            set: async (k: string, v: unknown) => void store.set(k, v)
        };
        let calls = 0;
        const provider: AiProvider = {
            generate: async () => {
                calls++;
                return validRaw;
            }
        };
        const inner = createComposePipeline(options(provider)).generate;
        const cached = cachedGeneration(inner, cache);

        const run = async () => {
            const pipeline = createComposePipeline(options(provider), { generate: cached });
            return pipeline.run(options(provider));
        };
        await run();
        await run();
        expect(calls).toBe(1);
    });
});

describe('personalizedRequest', () => {
    test('rewrites the request without changing the vocabulary', async () => {
        let seen = '';
        const pipeline = createComposePipeline(options(fakeProvider(validRaw)), {
            toRequest: personalizedRequest((request) => ({
                ...request,
                prompt: `${request.prompt}\n\n[personalized: returning visitor]`
            })),
            generate: async (frame) => {
                seen = frame.request.prompt;
                return { kind: 'generation', raw: validRaw, context: frame };
            }
        });
        await pipeline.run(options(fakeProvider(validRaw)));
        expect(seen).toContain('[personalized: returning visitor]');
    });
});

describe('validateGenerated remains the contract', () => {
    test('the pipeline output goes through the same validation', async () => {
        const direct = validateGenerated(validRaw, vocabulary, { max: 12 });
        const pipeline = createComposePipeline(options(fakeProvider(validRaw)));
        const viaPipeline = await pipeline.run(options(fakeProvider(validRaw)));
        expect(viaPipeline.blocks).toEqual(direct.blocks);
        expect(viaPipeline.rendered).toEqual(direct.rendered);
    });
});
