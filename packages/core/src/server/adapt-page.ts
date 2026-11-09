/**
 * Personalizes a page. It is called in the page's frontmatter, before rendering:
 *
 *   const { blocks, decisions } = await adaptPage(page.blocks, Astro, { holdout: 0.1 });
 *
 * It has to be there and not in a component: Astro starts sending the response as
 * soon as there is something to write, and headers set by a child component are
 * lost. Without `Cache-Control: private`, a shared cache would serve one visitor
 * another visitor's version.
 *
 * It decides on the server on every request, so it adds no JavaScript.
 *
 * The editor sees every version so it can fix them, unless it asks to see the
 * page as a specific visitor with `?inti-as=device:mobile;pref.diet:vegan`.
 */

import {
    adaptBlocks,
    applyViewAs,
    audienceDecider,
    buildAdaptContext,
    hasAdaptiveBlocks,
    parseAudience,
    SEEN_COOKIE,
    STICKY_COOKIE,
    VISITOR_COOKIE
} from '../adapt/index.js';
import type { AdaptDecision, Decider } from '../adapt/index.js';
import { resolveDeciders, resolveExperimentStore } from '../plugins/index.js';
import type { IntiBlock } from '../types/index.js';
import { resolveEditorSession } from './editor-session.js';

/** What is needed from `Astro` */
export interface AdaptPageRequest {
    request: Request;
    url: URL;
    cookies: { set(name: string, value: string, options?: Record<string, unknown>): unknown };
    response: { headers: Headers };
    isPrerendered?: boolean;
}

export interface AdaptPageOptions {
    /** Default: those contributed by plugins, followed by the audience rules */
    deciders?: Decider[];
    /** Fraction that always sees the default content, so it can be measured. Default: 0 */
    holdout?: number;
    /** Counts this visit towards `seen.<category>`. Only with consent */
    track?: string;
    timeoutMs?: number;
}

export interface AdaptPageResult {
    blocks: IntiBlock[];
    decisions: AdaptDecision[];
}

export async function adaptPage(
    blocks: IntiBlock[],
    astro: AdaptPageRequest,
    options: AdaptPageOptions = {}
): Promise<AdaptPageResult> {
    // A page with nothing adaptive pays nothing: no session, no headers, no cookies
    if (!hasAdaptiveBlocks(blocks)) return { blocks, decisions: [] };

    // Per-visitor content must never go into a shared cache. This also applies
    // to the editor, which receives versions the visitor must not see
    astro.response.headers.set('Cache-Control', 'private, no-store');
    astro.response.headers.append('Vary', 'Cookie');

    const session = await resolveEditorSession({
        request: astro.request,
        cookies: astro.cookies,
        prerendered: astro.isPrerendered
    });
    const viewAs = session.allowed ? astro.url.searchParams.get('inti-as') : null;

    if (session.allowed && viewAs === null) {
        // A variant the editor does not see is a variant it cannot fix
        return {
            decisions: [],
            blocks: blocks.map((block) => {
                const audience = block.meta?.audience ?? block.data?.inti_audience;
                const slot = block.meta?.slot ?? block.data?.inti_slot;
                return slot || Object.keys(parseAudience(audience)).length > 0
                    ? {
                          ...block,
                          meta: {
                              ...block.meta,
                              label: `${slot ?? block.type}${audience ? ` → ${audience}` : ' (default)'}`
                          }
                      }
                    : block;
            })
        };
    }

    const base = buildAdaptContext(astro.request);
    const context = viewAs !== null ? applyViewAs(base, viewAs) : base;

    const result = await adaptBlocks(blocks, context, {
        deciders: options.deciders ?? [...resolveDeciders(), audienceDecider],
        holdout: options.holdout,
        timeoutMs: options.timeoutMs,
        onError: (name, error) => console.warn(`[Inti] Decider "${name}" failed and is ignored:`, error)
    });

    // An editor's preview does not count as a visit
    if (viewAs !== null) return result;

    const cookieOptions = {
        path: '/',
        sameSite: 'lax',
        httpOnly: true,
        secure: astro.url.protocol === 'https:'
    };

    // The interface does not change while in use. Only what is not the default
    // content is stored: whoever receives nothing adapted receives no cookie
    const sticky = result.decisions.filter((decision) => decision.personalized);
    if (sticky.length > 0) {
        const value = Object.fromEntries(sticky.map((decision) => [decision.slot, decision.index]));
        astro.cookies.set(STICKY_COOKIE, JSON.stringify({ ...context.sticky, ...value }), cookieOptions);
    }

    if (context.consent && !context.crawler) {
        const year = { ...cookieOptions, maxAge: 60 * 60 * 24 * 365 };

        if (!context.visitorId) {
            astro.cookies.set(VISITOR_COOKIE, crypto.randomUUID(), year);
        }

        if (options.track && /^[a-zA-Z0-9_-]{1,32}$/.test(options.track)) {
            const seen = { ...context.seen, [options.track]: (context.seen[options.track] ?? 0) + 1 };
            astro.cookies.set(SEEN_COOKIE, JSON.stringify(seen), year);
        }

        const store = resolveExperimentStore();
        if (store && context.visitorId) {
            for (const decision of result.decisions) {
                await store.recordExposure({
                    slot: decision.slot,
                    index: decision.index,
                    group: decision.group,
                    decider: decision.decider,
                    visitorId: context.visitorId
                });
            }
        }
    }

    return result;
}
