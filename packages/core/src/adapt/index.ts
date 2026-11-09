/**
 * Personalization: which version of each zone each visitor sees.
 *
 * Context → deciders → allowed variant → render. No step needs AI: a model is
 * just one more decider, and any decider that fails or has no opinion leaves the
 * page's default content. The choice is only ever among blocks that already exist
 * in the CMS, the same ones an editor can open and correct.
 *
 * It is declared in the content, with two block fields any CMS can store as
 * text:
 *
 *   inti_slot:     "hero"                        blocks with the same slot are
 *                                                versions of the same zone
 *   inti_audience: "device:mobile;pref.diet:vegan"    who it is aimed at
 *
 * Filtering never renumbers `meta.index`: it is how the editor locates the block in
 * the CMS, and renumbering would make an edit land on another block.
 */

import type { IntiBlock } from '../types/index.js';

export const PREFERENCES_COOKIE = 'inti_prefs';
export const CONSENT_COOKIE = 'inti_consent';
export const SEEN_COOKIE = 'inti_seen';
export const VISITOR_COOKIE = 'inti_vid';
export const STICKY_COOKIE = 'inti_dec';

// ============================================
// Context
// ============================================

export type Device = 'mobile' | 'tablet' | 'desktop';

export interface AdaptContext {
    device: Device;
    country?: string;
    language?: string;
    /** 0-23, in server time */
    hour: number;
    campaign?: string;
    referrer?: string;
    returning: boolean;
    /** What the visitor chose. Always counts: they asked for it */
    preferences: Record<string, string>;
    /** What they have seen. Empty without consent: observing does require it */
    seen: Record<string, number>;
    consent: boolean;
    /** Search engines always get the default content */
    crawler: boolean;
    /** Anonymous identifier for measuring. Only with consent */
    visitorId?: string;
    /** Decisions already made in this session: the interface does not change while in use */
    sticky: Record<string, number>;
}

const CRAWLER = /bot\b|crawl|spider|slurp|facebookexternalhit|embedly|preview|lighthouse|headless/i;

export function parseCookies(header: string | null | undefined): Record<string, string> {
    const cookies: Record<string, string> = {};
    for (const part of (header ?? '').split(';')) {
        const at = part.indexOf('=');
        if (at < 0) continue;
        try {
            cookies[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
        } catch {
            // A badly encoded cookie is ignored
        }
    }
    return cookies;
}

/** A flat map read from a cookie: the visitor controls its content */
function readMap<T>(raw: string | undefined, accept: (value: unknown) => value is T): Record<string, T> {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const result = Object.create(null) as Record<string, T>;
        for (const [key, value] of Object.entries(parsed)) {
            if (/^[a-zA-Z0-9_-]{1,32}$/.test(key) && accept(value)) result[key] = value;
        }
        return result;
    } catch {
        return {};
    }
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length <= 64;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function detectDevice(userAgent: string): Device {
    if (/ipad|tablet|(android(?!.*mobile))/i.test(userAgent)) return 'tablet';
    if (/mobi|iphone|android/i.test(userAgent)) return 'mobile';
    return 'desktop';
}

export function buildAdaptContext(request: Request, options: { now?: Date } = {}): AdaptContext {
    const headers = request.headers;
    const cookies = parseCookies(headers.get('cookie'));
    const userAgent = headers.get('user-agent') ?? '';
    const url = new URL(request.url);
    const consent = cookies[CONSENT_COOKIE] === '1';

    return {
        device: detectDevice(userAgent),
        // Deployment platform headers, if any
        country: (headers.get('cf-ipcountry') ?? headers.get('x-vercel-ip-country') ?? undefined)?.toUpperCase(),
        language: headers.get('accept-language')?.split(/[,;-]/)[0]?.toLowerCase() || undefined,
        hour: (options.now ?? new Date()).getHours(),
        campaign: url.searchParams.get('utm_campaign') ?? undefined,
        referrer: headers.get('referer') ?? undefined,
        returning: consent && Boolean(cookies[VISITOR_COOKIE]),
        preferences: readMap(cookies[PREFERENCES_COOKIE], isString),
        seen: consent ? readMap(cookies[SEEN_COOKIE], isCount) : {},
        consent,
        crawler: CRAWLER.test(userAgent),
        visitorId: consent ? cookies[VISITOR_COOKIE] : undefined,
        sticky: readMap(cookies[STICKY_COOKIE], isCount)
    };
}

/** Applies `?inti-as=device:mobile;pref.diet:vegan` to a context: the editor's preview */
export function applyViewAs(context: AdaptContext, viewAs: string): AdaptContext {
    const result: AdaptContext = {
        ...context,
        preferences: { ...context.preferences },
        seen: { ...context.seen },
        sticky: {},
        crawler: false
    };

    for (const [key, values] of Object.entries(parseAudience(viewAs))) {
        const value = values[0];
        if (key === 'device') result.device = value as Device;
        else if (key === 'country') result.country = value.toUpperCase();
        else if (key === 'language') result.language = value.toLowerCase();
        else if (key === 'campaign') result.campaign = value;
        else if (key === 'hour') result.hour = Number(value);
        else if (key === 'returning') result.returning = value === 'true';
        else if (key.startsWith('pref.')) result.preferences[key.slice(5)] = value;
        else if (key.startsWith('seen.')) {
            result.seen[key.slice(5)] = Number(value);
            result.consent = true;
        }
    }
    return result;
}

// ============================================
// Audiences
// ============================================

/** `key → accepted values`. Across keys it is AND; across values of one key, OR */
export type Audience = Record<string, string[]>;

export function parseAudience(raw: unknown): Audience {
    if (typeof raw !== 'string') return {};

    const audience: Audience = Object.create(null);
    for (const part of raw.split(';')) {
        const at = part.indexOf(':');
        if (at < 0) continue;
        const key = part.slice(0, at).trim();
        const values = part
            .slice(at + 1)
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
        if (key && values.length > 0) audience[key] = values;
    }
    return audience;
}

function matchesCondition(key: string, values: string[], context: AdaptContext): boolean {
    const lower = (value: string | undefined) => value?.toLowerCase();

    if (key === 'device') return values.includes(context.device);
    if (key === 'country') return values.some((value) => value.toUpperCase() === context.country);
    if (key === 'language') return values.some((value) => lower(value) === context.language);
    if (key === 'campaign') return values.includes(context.campaign ?? '');
    if (key === 'returning') return values.includes(String(context.returning));
    if (key === 'referrer') return values.some((value) => context.referrer?.includes(value));
    if (key === 'hour') {
        return values.some((value) => {
            const [from, to] = value.split('-').map(Number);
            if (Number.isNaN(from)) return false;
            if (to === undefined || Number.isNaN(to)) return context.hour === from;
            // 22-6 crosses midnight
            return from <= to ? context.hour >= from && context.hour < to : context.hour >= from || context.hour < to;
        });
    }
    if (key.startsWith('pref.')) return values.includes(context.preferences[key.slice(5)] ?? '');
    if (key.startsWith('seen.')) {
        const count = context.seen[key.slice(5)] ?? 0;
        return values.some((value) => count >= Number(value));
    }

    // An unknown condition cannot let anyone through
    return false;
}

export function matchesAudience(audience: Audience, context: AdaptContext): boolean {
    return Object.entries(audience).every(([key, values]) => matchesCondition(key, values, context));
}

const LABELS: Record<string, string> = {
    device: 'your device',
    country: 'your country',
    language: 'your language',
    hour: 'the time of day',
    campaign: 'the campaign that brought you here',
    returning: 'having visited us before',
    referrer: 'the page you came from'
};

/** Why something is shown, in a sentence that can be shown to the visitor */
export function explainAudience(audience: Audience): string {
    const reasons = Object.keys(audience).map((key) => {
        if (key.startsWith('pref.')) return `your ${key.slice(5)} preference`;
        if (key.startsWith('seen.')) return `what you have been viewing in ${key.slice(5)}`;
        return LABELS[key] ?? key;
    });
    return reasons.length > 0 ? `Because of ${reasons.join(' and ')}.` : '';
}

// ============================================
// Deciders
// ============================================

export interface SlotCandidate {
    block: IntiBlock;
    audience: Audience;
    /** Stable key: the block's index in the CMS */
    index: number;
}

export interface DecideInput {
    slot: string;
    candidates: SlotCandidate[];
    context: AdaptContext;
}

/** Picks a candidate by its `index`, or returns null to let the next one decide */
export interface Decider {
    name: string;
    decide(input: DecideInput): Promise<number | null> | number | null;
}

/**
 * Rules and preferences: the matching audience with the most conditions wins. It is
 * the only default decider, and it needs nothing external.
 */
export const audienceDecider: Decider = {
    name: 'audience',
    decide({ candidates, context }) {
        let best: SlotCandidate | null = null;
        let bestScore = 0;

        for (const candidate of candidates) {
            const score = Object.keys(candidate.audience).length;
            if (score > bestScore && matchesAudience(candidate.audience, context)) {
                best = candidate;
                bestScore = score;
            }
        }
        return best?.index ?? null;
    }
};

// ============================================
// Measurement
// ============================================

export type VisitorGroup = 'personalized' | 'control' | 'unassigned';

export interface ExposureEvent {
    slot: string;
    index: number;
    group: VisitorGroup;
    visitorId?: string;
    decider: string;
}

/** Stores exposures and conversions. Without this there is no way to know whether personalizing helps */
export interface ExperimentStore {
    recordExposure(event: ExposureEvent): Promise<void> | void;
    recordConversion(event: { visitorId: string; goal?: string; value?: number }): Promise<void> | void;
    /** A slot's rates. Optional: implemented by the store that knows how to compute them */
    stats?(slot: string): Promise<SlotStats> | SlotStats;
}

export interface GroupStats {
    visitors: number;
    conversions: number;
}

export interface SlotStats {
    /** By block index, so a decider can pick the best-performing variant */
    variants: Record<number, GroupStats>;
    groups: Record<'personalized' | 'control', GroupStats>;
}

/** In-memory store. Lost on restart: for testing, not for production */
export function createMemoryExperimentStore(): ExperimentStore & { stats(slot: string): SlotStats } {
    const exposures = new Map<string, Map<string, ExposureEvent>>();
    const converted = new Set<string>();

    return {
        recordExposure(event) {
            if (!event.visitorId) return;
            let slot = exposures.get(event.slot);
            if (!slot) exposures.set(event.slot, (slot = new Map()));
            // A visitor counts once, with the first thing they saw
            if (!slot.has(event.visitorId)) slot.set(event.visitorId, event);
        },
        recordConversion(event) {
            converted.add(event.visitorId);
        },
        stats(slot) {
            const result: SlotStats = {
                variants: {},
                groups: { personalized: { visitors: 0, conversions: 0 }, control: { visitors: 0, conversions: 0 } }
            };
            for (const [visitorId, event] of exposures.get(slot) ?? []) {
                const did = converted.has(visitorId) ? 1 : 0;
                const variant = (result.variants[event.index] ??= { visitors: 0, conversions: 0 });
                variant.visitors++;
                variant.conversions += did;
                if (event.group !== 'unassigned') {
                    result.groups[event.group].visitors++;
                    result.groups[event.group].conversions += did;
                }
            }
            return result;
        }
    };
}

export interface LiftReport {
    control: number;
    personalized: number;
    /** Relative improvement over the control. null with no data in the control */
    lift: number | null;
    /** Too little data: the number does not mean anything yet */
    enoughData: boolean;
}

export function computeLift(stats: SlotStats, minimumPerGroup = 100): LiftReport {
    const rate = (group: GroupStats) => (group.visitors > 0 ? group.conversions / group.visitors : 0);
    const control = rate(stats.groups.control);
    const personalized = rate(stats.groups.personalized);

    return {
        control,
        personalized,
        lift: control > 0 ? (personalized - control) / control : null,
        enoughData:
            stats.groups.control.visitors >= minimumPerGroup && stats.groups.personalized.visitors >= minimumPerGroup
    };
}

/**
 * Picks the best-converting variant among those that fit the visitor.
 * It needs traffic: with little data it has no opinion, and the next one decides.
 */
export function bestVariantDecider(store: ExperimentStore, options: { minimumVisitors?: number; explore?: number; random?: () => number } = {}): Decider {
    const minimum = options.minimumVisitors ?? 200;
    const explore = options.explore ?? 0.1;
    const random = options.random ?? Math.random;

    return {
        name: 'best-variant',
        async decide({ slot, candidates, context }) {
            if (!context.consent || !store.stats) return null;

            const eligible = candidates.filter((candidate) => matchesAudience(candidate.audience, context));
            if (eligible.length < 2) return null;

            const stats = await store.stats(slot);
            const measured = eligible.map((candidate) => ({ candidate, data: stats.variants[candidate.index] }));
            if (measured.some(({ data }) => !data || data.visitors < minimum)) return null;

            // Part of the traffic keeps exploring, or a bad streak would be final
            if (random() < explore) return eligible[Math.floor(random() * eligible.length)].index;

            const rate = (data: GroupStats) => data.conversions / data.visitors;
            return measured.reduce((best, item) => (rate(item.data) > rate(best.data) ? item : best)).candidate.index;
        }
    };
}

/** Stable number in [0, 1) for a text: the same visitor always falls in the same group */
export function stableFraction(text: string): number {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967296;
}

// ============================================
// Adapting a page
// ============================================

export interface AdaptDecision {
    slot: string;
    index: number;
    decider: string;
    group: VisitorGroup;
    /** Something other than the default content was shown */
    personalized: boolean;
    reason: string;
}

export interface AdaptOptions {
    deciders?: Decider[];
    /** Fraction of measured visitors that always sees the default content. Default: 0 */
    holdout?: number;
    /** A decider that takes longer is ignored. Default: 500 ms */
    timeoutMs?: number;
    onError?: (decider: string, error: unknown) => void;
}

export interface AdaptResult {
    blocks: IntiBlock[];
    decisions: AdaptDecision[];
}

const fieldOf = (block: IntiBlock, name: 'audience' | 'slot'): unknown =>
    (block.meta as any)?.[name] ?? block.data?.[`inti_${name}`];

const slotOf = (block: IntiBlock): string | undefined => {
    const slot = fieldOf(block, 'slot');
    return typeof slot === 'string' && slot.trim() ? slot.trim() : undefined;
};

/** A page with nothing adaptive is served at no cost at all */
export function hasAdaptiveBlocks(blocks: IntiBlock[]): boolean {
    return blocks.some((block) => slotOf(block) || Object.keys(parseAudience(fieldOf(block, 'audience'))).length > 0);
}

function withTimeout<T>(value: Promise<T> | T, ms: number): Promise<T> {
    return Promise.race([
        Promise.resolve(value),
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms))
    ]);
}

export async function adaptBlocks(blocks: IntiBlock[], context: AdaptContext, options: AdaptOptions = {}): Promise<AdaptResult> {
    const deciders = options.deciders ?? [audienceDecider];
    const timeoutMs = options.timeoutMs ?? 500;
    const holdout = options.holdout ?? 0;

    const decisions: AdaptDecision[] = [];
    const indexOf = (block: IntiBlock, at: number) => block.meta?.index ?? at;

    // Without consent there is no identifier to measure with
    const groupFor = (slot: string): VisitorGroup => {
        if (holdout <= 0 || !context.visitorId) return 'unassigned';
        return stableFraction(`${context.visitorId}:${slot}`) < holdout ? 'control' : 'personalized';
    };

    const slots = new Map<string, SlotCandidate[]>();
    blocks.forEach((block, at) => {
        const slot = slotOf(block);
        if (!slot) return;
        const candidates = slots.get(slot) ?? [];
        candidates.push({ block, audience: parseAudience(fieldOf(block, 'audience')), index: indexOf(block, at) });
        slots.set(slot, candidates);
    });

    const chosen = new Map<string, number>();

    for (const [slot, candidates] of slots) {
        // The default content is the version with no audience, or the first one
        const fallback = (candidates.find((candidate) => Object.keys(candidate.audience).length === 0) ?? candidates[0]).index;
        const group = groupFor(slot);

        let index = fallback;
        let decider = 'default';

        if (!context.crawler && group !== 'control') {
            const valid = (value: number | null | undefined): value is number =>
                typeof value === 'number' && candidates.some((candidate) => candidate.index === value);

            if (valid(context.sticky[slot])) {
                index = context.sticky[slot];
                decider = 'session';
            } else {
                for (const candidate of deciders) {
                    try {
                        const picked = await withTimeout(candidate.decide({ slot, candidates, context }), timeoutMs);
                        if (valid(picked)) {
                            index = picked;
                            decider = candidate.name;
                            break;
                        }
                    } catch (error) {
                        options.onError?.(candidate.name, error);
                    }
                }
            }
        }

        chosen.set(slot, index);
        const audience = candidates.find((candidate) => candidate.index === index)?.audience ?? {};
        decisions.push({
            slot,
            index,
            decider,
            group,
            personalized: index !== fallback,
            reason: index !== fallback ? explainAudience(audience) : ''
        });
    }

    const result = blocks.filter((block, at) => {
        const slot = slotOf(block);
        if (slot) return chosen.get(slot) === indexOf(block, at);

        // A standalone block with an audience either appears or not. Without a slot it has no alternative
        const audience = parseAudience(fieldOf(block, 'audience'));
        if (Object.keys(audience).length === 0) return true;
        return !context.crawler && matchesAudience(audience, context);
    });

    return { blocks: result, decisions };
}
