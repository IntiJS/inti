import { describe, test, expect } from 'bun:test';
import { createCacheManager, cachePages, pageTags, createValkeyCacheProvider } from '../src/cache/index.js';
import type { ValkeyCacheClient } from '../src/cache/index.js';
import { NotFoundError, UnavailableError, isNotFound } from '../src/errors/index.js';
import type { IntiPage } from '../src/types/index.js';

const page = (slug: string, title = slug): IntiPage => ({ id: slug, slug, title, blocks: [] });

function source(behaviour: (slug: string) => Promise<IntiPage>) {
    const calls: string[] = [];
    return {
        calls,
        name: 'test',
        fetchPageBySlug(slug: string) {
            calls.push(slug);
            return behaviour(slug);
        }
    };
}

/** Moves the clock without waiting */
function withClock<T>(run: (advance: (seconds: number) => void) => Promise<T>): Promise<T> {
    const real = Date.now;
    let offset = 0;
    Date.now = () => real() + offset;
    return run((seconds) => (offset += seconds * 1000)).finally(() => {
        Date.now = real;
    });
}

describe('cachePages', () => {
    test('concurrent misses for one slug reach the CMS once', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const cms = source(async (slug) => {
            await gate;
            return page(slug);
        });
        const pages = cachePages(cms, { cache: createCacheManager() });
        const all = Promise.all(Array.from({ length: 20 }, () => pages.fetchPageBySlug('about')));
        release();
        expect((await all).every((result) => result.title === 'about')).toBe(true);
        expect(cms.calls).toHaveLength(1);
    });

    test('serves the last good copy while the CMS is down (stale-if-error)', () =>
        withClock(async (advance) => {
            let down = false;
            const cms = source(async (slug) => {
                if (down) throw new UnavailableError('CMS down');
                return page(slug, 'v1');
            });
            const pages = cachePages(cms, { cache: createCacheManager({ defaultTtl: 10, swr: 0, staleIfError: 3600 }) });
            await pages.fetchPageBySlug('home');
            down = true;
            advance(60);
            expect((await pages.fetchPageBySlug('home')).title).toBe('v1');
            advance(7200);
            expect(await pages.fetchPageBySlug('home').catch((e) => e)).toBeInstanceOf(UnavailableError);
        }));

    test('remembers a missing page for a short time and still says 404', () =>
        withClock(async (advance) => {
            const cms = source(async (slug) => {
                throw new NotFoundError('page', slug);
            });
            const pages = cachePages(cms, { cache: createCacheManager({ defaultTtl: 600 }), notFoundTtl: 30 });
            expect(isNotFound(await pages.fetchPageBySlug('nope').catch((e) => e))).toBe(true);
            expect(isNotFound(await pages.fetchPageBySlug('nope').catch((e) => e))).toBe(true);
            expect(cms.calls).toHaveLength(1);
            advance(31);
            await pages.fetchPageBySlug('nope').catch(() => {});
            expect(cms.calls).toHaveLength(2);
        }));

    test('a purge by slug drops only that page', async () => {
        const cms = source(async (slug) => page(slug));
        const cache = createCacheManager();
        const pages = cachePages(cms, { cache });
        await pages.fetchPageBySlug('/about/');
        await pages.fetchPageBySlug('contact');
        await cache.invalidateByTag(pageTags.page('about'));
        await pages.fetchPageBySlug('about');
        await pages.fetchPageBySlug('contact');
        expect(cms.calls).toEqual(['/about/', 'contact', 'about']);
    });
});

/** Valkey double: strings with expiry and sets, same semantics for what the provider uses */
function fakeValkey(): ValkeyCacheClient & { keys(): string[] } {
    const strings = new Map<string, string>();
    const sets = new Map<string, Set<string>>();
    return {
        async get(key) {
            return strings.get(key) ?? null;
        },
        async set(key, value) {
            strings.set(key, value);
            return 'OK';
        },
        async del(...keys) {
            for (const key of keys) {
                strings.delete(key);
                sets.delete(key);
            }
            return keys.length;
        },
        async exists(key) {
            return strings.has(key) || sets.has(key) ? 1 : 0;
        },
        async sadd(key, ...members) {
            const set = sets.get(key) ?? new Set();
            members.forEach((member) => set.add(member));
            sets.set(key, set);
            return members.length;
        },
        async smembers(key) {
            return [...(sets.get(key) ?? [])];
        },
        async pexpire() {
            return 1;
        },
        keys: () => [...strings.keys()]
    };
}

describe('createValkeyCacheProvider', () => {
    test('two instances share entries and a purge on one empties both', async () => {
        const server = fakeValkey();
        const a = createCacheManager({ provider: createValkeyCacheProvider({ client: server }) });
        const b = createCacheManager({ provider: createValkeyCacheProvider({ client: server }) });
        const cms = source(async (slug) => page(slug));

        await cachePages(cms, { cache: a }).fetchPageBySlug('home');
        await cachePages(cms, { cache: b }).fetchPageBySlug('home');
        expect(cms.calls).toHaveLength(1);

        await a.invalidateByTag(pageTags.page('home'));
        await cachePages(cms, { cache: b }).fetchPageBySlug('home');
        expect(cms.calls).toHaveLength(2);
    });

    test('clear removes every entry of the prefix', async () => {
        const server = fakeValkey();
        const cache = createCacheManager({ provider: createValkeyCacheProvider({ client: server, prefix: 'x:' }) });
        await cache.set('a', 1, { tags: ['t'] });
        await cache.set('b', 2);
        await cache.clear();
        expect(server.keys()).toEqual([]);
    });
});
