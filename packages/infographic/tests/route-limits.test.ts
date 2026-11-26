/**
 * A request parameter that does not change the image does not change the cache key.
 *
 * `theme` was hashed raw into the key although every unknown name renders the default
 * theme, so ?theme=<anything new> forced a fresh render and flushed the cache; and the
 * render queue had no bound. Both found by a 2026-11 audit.
 */

import { describe, test, expect } from 'bun:test';
import satori from 'satori';
import { createInfographicRoute } from '../src/route.js';
import { fonts } from './fixtures.js';

const data = {
    title: 'Sales by channel',
    locale: 'en',
    sections: [{ kind: 'bar', title: 'Channels', items: [{ label: 'Web', value: 120 }, { label: 'Store', value: 80 }] }]
};

function route(extra: Record<string, unknown> = {}) {
    let reads = 0;
    const GET = createInfographicRoute({
        readPage: async () => {
            reads++;
            return { blocks: [{ type: 'infographic', data, meta: { index: 1 } }] };
        },
        blockTypes: ['infographic'],
        fonts,
        ...extra
    });
    const call = (query = '') =>
        GET({ params: { path: 'blog/x/1.json' }, request: new Request(`https://acme.com/infographics/blog/x/1.json${query}`) });
    return { call, reads: () => reads };
}

describe('infographic route keys and queue', () => {
    test('an unknown theme is a 400, not a fresh render', async () => {
        const { call } = route();
        expect((await call('?theme=made-up-1')).status).toBe(400);
    });

    test('naming the default theme and omitting it share one cache entry', async () => {
        const { call } = route();
        const a = await call('');
        const b = await call('?theme=light');
        expect(a.status).toBe(200);
        expect(b.headers.get('etag')).toBe(a.headers.get('etag'));
    });

    test('work beyond the queue is turned away with 503 and Retry-After', async () => {
        // Layout work that really holds the slot (as a cold font load or a slow engine does)
        const slowSatori = async (node: never, options: never) => {
            await new Promise((resolve) => setTimeout(resolve, 40));
            return satori(node, options);
        };
        const { call } = route({ concurrency: 1, maxQueue: 1, satori: slowSatori });
        const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => call(`?slide=${i + 1}`)));
        const busy = responses.filter((r) => r.status === 503);
        expect(busy.length).toBeGreaterThan(0);
        expect(busy[0].headers.get('retry-after')).toBeTruthy();
    }, 30_000);
});

describe('niceTicks', () => {
    test('ends for huge values a few units apart', async () => {
        const { niceTicks } = await import('../src/sections.js');
        const ticks = niceTicks(1e16, 1e16 + 4);
        expect(ticks.length).toBeGreaterThan(0);
        expect(ticks.length).toBeLessThanOrEqual(50);
        expect(niceTicks(1e300, 1e300 * 1.0000001).length).toBeLessThanOrEqual(50);
    });

    test('ordinary ranges are unchanged', async () => {
        const { niceTicks } = await import('../src/sections.js');
        expect(niceTicks(0, 100)).toEqual([0, 25, 50, 75, 100]);
    });
});
