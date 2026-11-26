/**
 * The AI decider cannot be made to call the model without bound.
 *
 * Its cache was keyed on signals an anonymous visitor controls (the first Accept-Language
 * token, the preferences cookie), with no limit and no in-flight deduplication: a 2026-11
 * audit reproduced one provider call per request that changed Accept-Language.
 */

import { describe, test, expect } from 'bun:test';
import { createAiDecider } from '../src/decider.js';
import { buildAdaptContext } from '../../core/src/adapt/index.js';

const candidates = [
    { block: { type: 'Hero', data: { heading: 'Default', inti_slot: 'hero' }, meta: { index: 0 } }, audience: {}, index: 0 },
    { block: { type: 'Hero', data: { heading: 'Other', inti_slot: 'hero' }, meta: { index: 1 } }, audience: {}, index: 1 }
] as never[];

const context = (language: string) =>
    buildAdaptContext(new Request('http://x/', { headers: { 'accept-language': language, 'user-agent': 'Mozilla/5.0' } }));

function countingProvider(delayMs = 0) {
    const provider = {
        calls: 0,
        generate: async () => {
            provider.calls++;
            if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
            return { choice: '1' };
        }
    };
    return provider;
}

describe('createAiDecider spend limits', () => {
    test('concurrent identical decisions share one model call', async () => {
        const provider = countingProvider(30);
        const decider = createAiDecider({ provider });
        const results = await Promise.all(
            Array.from({ length: 5 }, () => decider.decide({ slot: 'hero', candidates, context: context('en-US') }))
        );
        expect(provider.calls).toBe(1);
        expect(results).toEqual([1, 1, 1, 1, 1]);
    });

    test('made-up languages do not create new cache keys', async () => {
        const provider = countingProvider();
        const decider = createAiDecider({ provider });
        for (let i = 0; i < 10; i++) await decider.decide({ slot: 'hero', candidates, context: context(`lang${i}-US`) });
        expect(provider.calls).toBe(1);
    });

    test('the model is called at most perMinute times; beyond it the default content stays', async () => {
        const provider = countingProvider();
        const decider = createAiDecider({ provider, limits: { perMinute: 3 } });
        const results = [];
        for (const language of ['en', 'es', 'fr', 'de', 'it', 'pt']) {
            results.push(await decider.decide({ slot: 'hero', candidates, context: context(language) }));
        }
        expect(provider.calls).toBe(3);
        expect(results.slice(3)).toEqual([null, null, null]);
    });

    test('a shared limiter is used when given', async () => {
        const provider = countingProvider();
        const taken: string[] = [];
        const decider = createAiDecider({
            provider,
            limiter: { take: (key: string) => (taken.push(key), false) }
        });
        expect(await decider.decide({ slot: 'hero', candidates, context: context('en') })).toBeNull();
        expect(provider.calls).toBe(0);
        expect(taken.length).toBeGreaterThan(0);
    });
});
