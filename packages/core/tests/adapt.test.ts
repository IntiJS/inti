import { describe, test, expect } from 'bun:test';

import {
    adaptBlocks,
    applyViewAs,
    audienceDecider,
    bestVariantDecider,
    buildAdaptContext,
    computeLift,
    createMemoryExperimentStore,
    detectDevice,
    explainAudience,
    hasAdaptiveBlocks,
    matchesAudience,
    parseAudience,
    stableFraction
} from '../src/adapt/index.js';
import type { Decider } from '../src/adapt/index.js';

const MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const ctx = (headers: Record<string, string> = {}, url = 'http://x/') =>
    buildAdaptContext(new Request(url, { headers: { 'user-agent': DESKTOP, ...headers } }));

const cookie = (values: Record<string, unknown>) =>
    Object.entries(values)
        .map(([key, value]) => `${key}=${encodeURIComponent(typeof value === 'string' ? value : JSON.stringify(value))}`)
        .join('; ');

const hero = (heading: string, index: number, audience?: string) => ({
    type: 'Hero',
    data: { heading, inti_slot: 'hero', ...(audience ? { inti_audience: audience } : {}) },
    meta: { index, documentId: 'home' }
});

const PAGE = [
    hero('Default', 0),
    hero('Mobile', 1, 'device:mobile'),
    hero('Vegan mobile', 2, 'device:mobile;pref.diet:vegan'),
    { type: 'Text', data: { body: 'Always' }, meta: { index: 3, documentId: 'home' } }
];

const headings = (blocks: Array<{ data: any }>) => blocks.map((block) => block.data.heading ?? block.data.body);

describe('context', () => {
    test('detects the device', () => {
        expect(detectDevice(MOBILE)).toBe('mobile');
        expect(detectDevice(DESKTOP)).toBe('desktop');
        expect(detectDevice('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe('tablet');
    });

    test('preferences count without consent, what is observed does not', () => {
        const context = ctx({ cookie: cookie({ inti_prefs: { diet: 'vegan' }, inti_seen: { boots: 5 }, inti_vid: 'v1' }) });
        expect(context.preferences.diet).toBe('vegan');
        expect(context.seen).toEqual({});
        expect(context.visitorId).toBeUndefined();
        expect(context.returning).toBe(false);
    });

    test('with consent what is observed is used', () => {
        const context = ctx({ cookie: cookie({ inti_consent: '1', inti_seen: { boots: 5 }, inti_vid: 'v1' }) });
        expect(context.seen.boots).toBe(5);
        expect(context.visitorId).toBe('v1');
        expect(context.returning).toBe(true);
    });

    test('a tampered cookie neither breaks nor pollutes', () => {
        const context = ctx({
            cookie: `inti_prefs=${encodeURIComponent('{"__proto__":{"admin":1},"ok":"yes","long":"' + 'x'.repeat(100) + '","num":3}')}; inti_seen=no-json`
        });
        expect(context.preferences.ok).toBe('yes');
        expect(context.preferences.long).toBeUndefined();
        expect(context.preferences.num).toBeUndefined();
        expect((context.preferences as any).admin).toBeUndefined();
        expect(({} as any).admin).toBeUndefined();
    });

    test('identifies search engines', () => {
        expect(ctx({ 'user-agent': GOOGLEBOT }).crawler).toBe(true);
        expect(ctx().crawler).toBe(false);
    });

    test('reads country, language and campaign', () => {
        const context = ctx({ 'cf-ipcountry': 'es', 'accept-language': 'es-ES,es;q=0.9' }, 'http://x/?utm_campaign=black');
        expect(context.country).toBe('ES');
        expect(context.language).toBe('es');
        expect(context.campaign).toBe('black');
    });
});

describe('audiences', () => {
    test('between keys it is AND; between values, OR', () => {
        const audience = parseAudience('device:mobile,tablet;country:ES');
        expect(matchesAudience(audience, { ...ctx(), device: 'tablet', country: 'ES' })).toBe(true);
        expect(matchesAudience(audience, { ...ctx(), device: 'desktop', country: 'ES' })).toBe(false);
        expect(matchesAudience(audience, { ...ctx(), device: 'mobile', country: 'FR' })).toBe(false);
    });

    test('an unknown condition matches no one', () => {
        expect(matchesAudience(parseAudience('invented:x'), ctx())).toBe(false);
    });

    test('time ranges, also across midnight', () => {
        const at = (hour: number) => ({ ...ctx(), hour });
        expect(matchesAudience(parseAudience('hour:9-17'), at(9))).toBe(true);
        expect(matchesAudience(parseAudience('hour:9-17'), at(17))).toBe(false);
        expect(matchesAudience(parseAudience('hour:22-6'), at(23))).toBe(true);
        expect(matchesAudience(parseAudience('hour:22-6'), at(3))).toBe(true);
        expect(matchesAudience(parseAudience('hour:22-6'), at(12))).toBe(false);
    });

    test('seen.x compares against a minimum number of visits', () => {
        expect(matchesAudience(parseAudience('seen.boots:3'), { ...ctx(), seen: { boots: 3 } })).toBe(true);
        expect(matchesAudience(parseAudience('seen.boots:3'), { ...ctx(), seen: { boots: 2 } })).toBe(false);
    });

    test('the explanation is readable for the visitor', () => {
        expect(explainAudience(parseAudience('device:mobile;pref.diet:vegan'))).toBe('Because of your device and your diet preference.');
    });
});

describe('adaptBlocks', () => {
    test('no match: the default content and the normal blocks', async () => {
        const { blocks, decisions } = await adaptBlocks(PAGE, ctx());
        expect(headings(blocks)).toEqual(['Default', 'Always']);
        expect(decisions[0].personalized).toBe(false);
    });

    test('the most specific matching audience wins', async () => {
        const context = ctx({ 'user-agent': MOBILE, cookie: cookie({ inti_prefs: { diet: 'vegan' } }) });
        const { blocks, decisions } = await adaptBlocks(PAGE, context);
        expect(headings(blocks)).toEqual(['Vegan mobile', 'Always']);
        expect(decisions[0]).toMatchObject({ slot: 'hero', index: 2, decider: 'audience', personalized: true });
        expect(decisions[0].reason).toContain('preference');
    });

    test('never renumbers: the editor keeps writing to the right block', async () => {
        const { blocks } = await adaptBlocks(PAGE, ctx({ 'user-agent': MOBILE }));
        expect(blocks.map((block) => block.meta?.index)).toEqual([1, 3]);
    });

    test('a search engine always receives the default content', async () => {
        const { blocks } = await adaptBlocks(PAGE, { ...ctx({ 'user-agent': GOOGLEBOT }), device: 'mobile' });
        expect(headings(blocks)).toEqual(['Default', 'Always']);
    });

    test('a standalone block with an audience shows or not, and never to a search engine', async () => {
        const page = [{ type: 'Promo', data: { body: 'Mobile only', inti_audience: 'device:mobile' }, meta: { index: 0 } }];
        expect((await adaptBlocks(page, ctx({ 'user-agent': MOBILE }))).blocks.length).toBe(1);
        expect((await adaptBlocks(page, ctx())).blocks.length).toBe(0);
        expect((await adaptBlocks(page, { ...ctx({ 'user-agent': GOOGLEBOT }), device: 'mobile' })).blocks.length).toBe(0);
    });

    test('within a session the decision does not change', async () => {
        const context = ctx({ 'user-agent': DESKTOP, cookie: cookie({ inti_dec: { hero: 1 } }) });
        const { blocks, decisions } = await adaptBlocks(PAGE, context);
        expect(headings(blocks)[0]).toBe('Mobile');
        expect(decisions[0].decider).toBe('session');
    });

    test('a saved decision that no longer exists is ignored', async () => {
        const { blocks } = await adaptBlocks(PAGE, ctx({ cookie: cookie({ inti_dec: { hero: 99 } }) }));
        expect(headings(blocks)[0]).toBe('Default');
    });

    test('a failing decider does not break the page and the next one decides', async () => {
        const broken: Decider = {
            name: 'broken',
            decide() {
                throw new Error('down');
            }
        };
        const errors: string[] = [];
        const { blocks } = await adaptBlocks(PAGE, ctx({ 'user-agent': MOBILE }), {
            deciders: [broken, audienceDecider],
            onError: (name) => errors.push(name)
        });
        expect(headings(blocks)[0]).toBe('Mobile');
        expect(errors).toEqual(['broken']);
    });

    test('a slow decider is abandoned', async () => {
        const slow: Decider = { name: 'slow', decide: () => new Promise((resolve) => setTimeout(() => resolve(1), 500)) };
        const started = Date.now();
        const { blocks } = await adaptBlocks(PAGE, ctx(), { deciders: [slow], timeoutMs: 20 });
        expect(Date.now() - started).toBeLessThan(300);
        expect(headings(blocks)[0]).toBe('Default');
    });

    test('a decider cannot pick something that is not a candidate', async () => {
        const liar: Decider = { name: 'liar', decide: () => 3 };
        const { blocks } = await adaptBlocks(PAGE, ctx(), { deciders: [liar] });
        expect(headings(blocks)).toEqual(['Default', 'Always']);
    });

    test('with no decider at all the page works: it depends on no AI or anything external', async () => {
        const { blocks } = await adaptBlocks(PAGE, ctx({ 'user-agent': MOBILE }), { deciders: [] });
        expect(headings(blocks)[0]).toBe('Default');
    });

    test('a page with nothing adaptable is detected', () => {
        expect(hasAdaptiveBlocks([{ type: 'Text', data: {} }])).toBe(false);
        expect(hasAdaptiveBlocks(PAGE)).toBe(true);
    });
});

describe('control group', () => {
    const visitor = (id: string) => ctx({ 'user-agent': MOBILE, cookie: cookie({ inti_consent: '1', inti_vid: id }) });

    test('the same visitor always lands in the same group', async () => {
        const a = await adaptBlocks(PAGE, visitor('v1'), { holdout: 0.5 });
        const b = await adaptBlocks(PAGE, visitor('v1'), { holdout: 0.5 });
        expect(a.decisions[0].group).toBe(b.decisions[0].group);
    });

    test('the control sees the default content even if the audience matches', async () => {
        const { blocks, decisions } = await adaptBlocks(PAGE, visitor('v1'), { holdout: 1 });
        expect(decisions[0].group).toBe('control');
        expect(headings(blocks)[0]).toBe('Default');
    });

    test('the fraction is roughly honored', () => {
        const total = 5000;
        let control = 0;
        for (let i = 0; i < total; i++) if (stableFraction(`visitor-${i}:hero`) < 0.1) control++;
        expect(control / total).toBeGreaterThan(0.08);
        expect(control / total).toBeLessThan(0.12);
    });

    test('without consent no group is assigned, but the rules keep working', async () => {
        const { blocks, decisions } = await adaptBlocks(PAGE, ctx({ 'user-agent': MOBILE }), { holdout: 1 });
        expect(decisions[0].group).toBe('unassigned');
        expect(headings(blocks)[0]).toBe('Mobile');
    });
});

describe('measurement', () => {
    test('computes the lift over the control', () => {
        const store = createMemoryExperimentStore();
        for (let i = 0; i < 200; i++) {
            store.recordExposure({ slot: 'hero', index: 0, group: 'control', visitorId: `c${i}`, decider: 'default' });
            store.recordExposure({ slot: 'hero', index: 1, group: 'personalized', visitorId: `p${i}`, decider: 'audience' });
            if (i < 10) store.recordConversion({ visitorId: `c${i}` });
            if (i < 20) store.recordConversion({ visitorId: `p${i}` });
        }
        const report = computeLift(store.stats('hero'));
        expect(report.control).toBeCloseTo(0.05);
        expect(report.personalized).toBeCloseTo(0.1);
        expect(report.lift).toBeCloseTo(1);
        expect(report.enoughData).toBe(true);
    });

    test('a visitor counts once, and too little data is reported', () => {
        const store = createMemoryExperimentStore();
        store.recordExposure({ slot: 'hero', index: 0, group: 'control', visitorId: 'a', decider: 'default' });
        store.recordExposure({ slot: 'hero', index: 1, group: 'control', visitorId: 'a', decider: 'default' });
        expect(store.stats('hero').groups.control.visitors).toBe(1);
        expect(computeLift(store.stats('hero')).enoughData).toBe(false);
    });

    test('bestVariantDecider has no opinion without enough data or without consent', async () => {
        const store = createMemoryExperimentStore();
        const decider = bestVariantDecider(store);
        const candidates = [
            { block: PAGE[0], audience: {}, index: 0 },
            { block: PAGE[1], audience: {}, index: 1 }
        ];
        expect(await decider.decide({ slot: 'hero', candidates, context: { ...ctx(), consent: true } })).toBeNull();
        expect(await decider.decide({ slot: 'hero', candidates, context: ctx() })).toBeNull();
    });

    test('bestVariantDecider picks the best converter and keeps exploring', async () => {
        const store = createMemoryExperimentStore();
        for (let i = 0; i < 100; i++) {
            store.recordExposure({ slot: 'hero', index: 0, group: 'personalized', visitorId: `a${i}`, decider: 'x' });
            store.recordExposure({ slot: 'hero', index: 1, group: 'personalized', visitorId: `b${i}`, decider: 'x' });
            if (i < 5) store.recordConversion({ visitorId: `a${i}` });
            if (i < 30) store.recordConversion({ visitorId: `b${i}` });
        }
        const candidates = [
            { block: PAGE[0], audience: {}, index: 0 },
            { block: PAGE[1], audience: {}, index: 1 }
        ];
        const context = { ...ctx(), consent: true };
        const exploit = bestVariantDecider(store, { minimumVisitors: 50, random: () => 0.9 });
        expect(await exploit.decide({ slot: 'hero', candidates, context })).toBe(1);

        const explore = bestVariantDecider(store, { minimumVisitors: 50, random: () => 0.01 });
        expect(await explore.decide({ slot: 'hero', candidates, context })).toBe(0);
    });
});

describe('view as', () => {
    test('simulates a visitor without depending on their cookies', async () => {
        const context = applyViewAs(ctx(), 'device:mobile;pref.diet:vegan');
        const { blocks } = await adaptBlocks(PAGE, context);
        expect(headings(blocks)[0]).toBe('Vegan mobile');
    });

    test("ignores the editor's own session decision", () => {
        const context = applyViewAs(ctx({ cookie: cookie({ inti_dec: { hero: 1 } }) }), 'device:desktop');
        expect(context.sticky).toEqual({});
    });
});
