/**
 * Composition during the visit: a search box or an assistant that composes blocks
 * for whoever is looking at the page.
 *
 * It is the riskiest part, so the guarantees are in the structure:
 *
 * - It does not write. This module receives no adapter: a prompt injection has
 *   no tool with which to reach the CMS.
 * - It does not spend without limit. It is a public endpoint with the customer's key:
 *   it has a per-visitor cap, a global daily cap and a cache.
 * - It never breaks the page. Any failure returns zero blocks with a status, and
 *   the page keeps showing its normal content.
 */

import { compose } from './compose.js';
import type { AiProvider } from './compose.js';
import type { GeneratedBlock } from './validate.js';
import type { DataSources, Vocabulary } from './vocabulary.js';

export interface VisitorLimits {
    /** Model calls per visitor per minute. Default: 10 */
    perMinute?: number;
    /** Model calls per day, for the whole site. Default: 1000 */
    perDay?: number;
    /** Default: 6 */
    maxBlocks?: number;
    /** Maximum request length. Default: 300 */
    maxPromptLength?: number;
    /** Seconds a response is reused. Default: 300 */
    cacheSeconds?: number;
    /** Cached responses. Default: 500 */
    cacheSize?: number;
}

export interface VisitorComposerConfig {
    provider: AiProvider;
    vocabulary: Vocabulary;
    sources?: DataSources;
    limits?: VisitorLimits;
    /**
     * Limits shared across instances. Without this they are counted in memory, and with
     * several instances the real cap is the per-instance cap.
     */
    limiter?: VisitorLimiter;
    /** Shared cache. Without it, each instance has its own */
    cache?: VisitorCache;
    /** Injectable for tests */
    now?: () => number;
}

export interface VisitorLimiter {
    /** Consumes a call. false if none are left */
    take(key: string, limit: number, windowSeconds: number): Promise<boolean> | boolean;
}

export interface VisitorCache {
    get(key: string): Promise<string | null> | string | null;
    set(key: string, value: string, ttlSeconds: number): Promise<void> | void;
}

export type VisitorStatus = 'ok' | 'empty' | 'invalid_prompt' | 'rate_limited' | 'budget_exhausted' | 'error';

export interface VisitorResult {
    status: VisitorStatus;
    /** Ready for BlockRenderer: references are already real data */
    blocks: GeneratedBlock[];
    warnings: string[];
    cached: boolean;
}

/**
 * What is generated for a visit must not be indexed or stored in a shared
 * cache. What matters for SEO is saved to the CMS from the editor.
 */
export const VISITOR_HEADERS: Readonly<Record<string, string>> = {
    'X-Robots-Tag': 'noindex',
    'Cache-Control': 'private, no-store'
};

const normalize = (prompt: string): string => prompt.trim().replace(/\s+/g, ' ').toLowerCase();

export function createVisitorComposer(config: VisitorComposerConfig) {
    const limits = {
        perMinute: config.limits?.perMinute ?? 10,
        perDay: config.limits?.perDay ?? 1000,
        maxBlocks: config.limits?.maxBlocks ?? 6,
        maxPromptLength: config.limits?.maxPromptLength ?? 300,
        cacheSeconds: config.limits?.cacheSeconds ?? 300,
        cacheSize: config.limits?.cacheSize ?? 500
    };
    const now = config.now ?? Date.now;

    const cache = new Map<string, { expires: number; result: VisitorResult }>();
    /** The same request at the same time is a single model call */
    const pending = new Map<string, Promise<VisitorResult>>();
    const windows = new Map<string, { start: number; count: number }>();
    let day = { start: now(), count: 0 };

    const result = (status: VisitorStatus, warnings: string[] = []): VisitorResult => ({
        status,
        blocks: [],
        warnings,
        cached: false
    });

    /** Consumes one of the visitor's calls. false if they have none left */
    function takeMinute(key: string): boolean {
        const current = now();

        // Without this the map would grow with every distinct visitor
        if (windows.size > 10_000) {
            for (const [windowKey, window] of windows) {
                if (current - window.start >= 60_000) windows.delete(windowKey);
            }
        }

        const window = windows.get(key);
        if (!window || current - window.start >= 60_000) {
            windows.set(key, { start: current, count: 1 });
            return true;
        }
        if (window.count >= limits.perMinute) return false;
        window.count++;
        return true;
    }

    function takeDay(): boolean {
        const current = now();
        if (current - day.start >= 86_400_000) day = { start: current, count: 0 };
        if (day.count >= limits.perDay) return false;
        day.count++;
        return true;
    }

    return {
        async compose(prompt: string, options: { visitorKey: string }): Promise<VisitorResult> {
            if (typeof prompt !== 'string' || !prompt.trim()) return result('invalid_prompt');
            if (prompt.length > limits.maxPromptLength) {
                return result('invalid_prompt', [`Longer than ${limits.maxPromptLength} characters.`]);
            }

            const key = normalize(prompt);

            // What is already cached does not call the model: it consumes no limits
            const shared = await config.cache?.get(`genui:${key}`);
            if (shared) return { ...(JSON.parse(shared) as VisitorResult), cached: true };

            const hit = cache.get(key);
            if (hit && hit.expires > now()) return { ...hit.result, cached: true };
            if (hit) cache.delete(key);

            const inFlight = pending.get(key);
            if (inFlight) return { ...(await inFlight), cached: true };

            const allowedForVisitor = config.limiter
                ? await config.limiter.take(`visitor:${options.visitorKey}`, limits.perMinute, 60)
                : takeMinute(options.visitorKey);
            if (!allowedForVisitor) return result('rate_limited');

            const withinBudget = config.limiter ? await config.limiter.take('budget', limits.perDay, 86_400) : takeDay();
            if (!withinBudget) return result('budget_exhausted');

            const run = (async (): Promise<VisitorResult> => {
                try {
                    const composed = await compose({
                        prompt,
                        vocabulary: config.vocabulary,
                        provider: config.provider,
                        sources: config.sources,
                        max: limits.maxBlocks
                    });

                    const outcome: VisitorResult = {
                        status: composed.rendered.length > 0 ? 'ok' : 'empty',
                        blocks: composed.rendered,
                        warnings: composed.warnings,
                        cached: false
                    };

                    if (cache.size >= limits.cacheSize) {
                        const oldest = cache.keys().next().value;
                        if (oldest !== undefined) cache.delete(oldest);
                    }
                    cache.set(key, { expires: now() + limits.cacheSeconds * 1000, result: outcome });
                    await config.cache?.set(`genui:${key}`, JSON.stringify(outcome), limits.cacheSeconds);
                    return outcome;
                } catch (error) {
                    return result('error', [error instanceof Error ? error.message : String(error)]);
                }
            })();

            pending.set(key, run);
            try {
                return await run;
            } finally {
                pending.delete(key);
            }
        }
    };
}
