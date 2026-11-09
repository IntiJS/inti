/**
 * Flow recipes — a serializable, visual-builder-friendly flow (2026-11-07)
 * =========================================================================
 *
 * Crew Studio's lesson: flows people can SEE get edited by people who don't
 * write code. A Recipe is the serializable form of a composition flow: the
 * instruction plus an ordered list of named stages (each a pipeline swap from
 * `pipeline.ts`). `runRecipe()` loads it back into a `ComposePipeline`.
 *
 * The builder (`builder/flow-builder.ts`, `<inti-flow-builder>`) edits this
 * shape: export JSON here, import JSON back, run the same thing.
 */

import { createComposePipeline } from './pipeline.js';
import type { ComposePipeline, Processor } from './pipeline.js';
import type { ComposeOptions, AiProvider } from './compose.js';
import type { ValidationResult } from './validate.js';

// ── The recipe ──────────────────────────────────────────────────────────────

/** A named stage in the flow. */
export interface RecipeStage {
    /** What the stage does. The builder shows this as the node label. */
    id: 'generate' | 'personalize' | 'cache';
    /** For 'personalize': appended to the instruction (per-visitor variant). */
    with?: string;
    /** For 'cache': TTL in seconds. */
    ttlSeconds?: number;
}

/** The serializable flow. */
export interface FlowRecipe {
    version: 1;
    /** The composition instruction (what the page should say/be). */
    instruction: string;
    stages: RecipeStage[];
}

/** The runtime services a recipe needs that are NOT serializable. */
export interface RecipeDeps {
    provider: AiProvider;
    /** Required by the 'cache' stage. */
    cache?: {
        get(key: string): Promise<unknown | null>;
        set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
    };
    /** Extra ComposeOptions fields (vocabulary comes from the host). */
    options?: Partial<ComposeOptions>;
}

// ── Validation (pure) ───────────────────────────────────────────────────────

const STAGE_IDS = new Set(['generate', 'personalize', 'cache']);

/** Validates a recipe; throws with the first problem. Pure. */
export function validateRecipe(recipe: FlowRecipe): void {
    if (!recipe || typeof recipe !== 'object') throw new Error('recipe must be an object');
    if (recipe.version !== 1) throw new Error(`unsupported recipe version: ${String(recipe.version)}`);
    if (typeof recipe.instruction !== 'string' || !recipe.instruction.trim()) {
        throw new Error('recipe.instruction is required');
    }
    if (!Array.isArray(recipe.stages) || recipe.stages.length === 0) {
        throw new Error('recipe.stages must be a non-empty array');
    }
    let hasGenerate = false;
    for (const [i, stage] of recipe.stages.entries()) {
        if (!stage || typeof stage !== 'object') throw new Error(`stage ${i} must be an object`);
        if (!STAGE_IDS.has(stage.id)) {
            throw new Error(`stage ${i}: unknown id '${String(stage.id)}'`);
        }
        if (stage.id === 'generate') {
            if (hasGenerate) throw new Error('a recipe can have only one generate stage');
            hasGenerate = true;
        }
        if (stage.id === 'personalize' && (typeof stage.with !== 'string' || !stage.with.trim())) {
            throw new Error(`stage ${i} (personalize): 'with' must be a non-empty string`);
        }
        if (stage.id === 'cache') {
            if (stage.ttlSeconds !== undefined && (!Number.isFinite(stage.ttlSeconds) || stage.ttlSeconds < 0)) {
                throw new Error(`stage ${i} (cache): ttlSeconds must be a number >= 0`);
            }
        }
    }
    // The flow must produce something: a generate stage is mandatory.
    if (!hasGenerate) throw new Error("a recipe needs a 'generate' stage");
}

// ── Loading ─────────────────────────────────────────────────────────────────

/**
 * Builds a ComposePipeline from a recipe. Stage order in the recipe is the
 * frame order: 'personalize' wraps the request, 'cache' wraps generation.
 */
export function recipeToPipeline(recipe: FlowRecipe, deps: RecipeDeps): ComposePipeline {
    validateRecipe(recipe);
    const base: ComposeOptions = {
        prompt: recipe.instruction,
        vocabulary: deps.options?.vocabulary as ComposeOptions['vocabulary'],
        provider: deps.provider,
        sources: deps.options?.sources,
        max: deps.options?.max
    };

    let toRequest: ComposePipeline['toRequest'] | undefined;
    const generateChain: Array<(g: ComposePipeline['generate']) => ComposePipeline['generate']> = [];

    for (const stage of recipe.stages) {
        if (stage.id === 'personalize') {
            const extra = stage.with!;
            const prev = toRequest;
            toRequest = async (frame) => {
                const context = prev ? await prev(frame) : await defaultToRequest(frame);
                return {
                    ...context,
                    request: { ...context.request, prompt: `${context.request.prompt}\n\n${extra}` }
                };
            };
        }
        if (stage.id === 'cache') {
            if (!deps.cache) throw new Error("the 'cache' stage needs deps.cache");
            const ttl = stage.ttlSeconds ?? 3600;
            const cache = deps.cache;
            // The cache wrapper is applied NESTED: the last one in the recipe wraps the others.
            generateChain.push((inner) => {
                const cached: ComposePipeline['generate'] = async (frame) => {
                    const key = await digest(JSON.stringify({ request: frame.request, max: frame.max }));
                    const hit = (await cache.get(key)) as { raw: unknown } | null;
                    if (hit && 'raw' in hit) return { kind: 'generation', raw: hit.raw, context: frame };
                    const generated = await inner(frame);
                    await cache.set(key, { raw: generated.raw }, ttl);
                    return generated;
                };
                return cached;
            });
        }
    }

    // The generate chain is wrapped BEFORE building the pipeline:
    // `run()` closes over the stages, so overrides go into the factory.
    const defaultPipeline = createComposePipeline(base);
    let generate = defaultPipeline.generate;
    for (const wrap of generateChain) generate = wrap(generate);

    return createComposePipeline(base, toRequest ? { toRequest, generate } : { generate });
}

const defaultToRequest: Processor<any, any> = async (frame: any) => {
    const { loadCandidates, buildRequest } = await import('./compose.js');
    const max = frame.options.max ?? 12;
    const candidates = await loadCandidates(frame.options);
    return {
        kind: 'context',
        request: buildRequest(frame.options, candidates, max),
        candidates,
        options: frame.options,
        max
    };
};

async function digest(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
    if (!subtle) return `fnv-${text.length}-${text.slice(0, 64)}`;
    const hash = await subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Runs a recipe end to end. */
export async function runRecipe(recipe: FlowRecipe, deps: RecipeDeps): Promise<ValidationResult> {
    return recipeToPipeline(recipe, deps).run({
        prompt: recipe.instruction,
        vocabulary: deps.options?.vocabulary as ComposeOptions['vocabulary'],
        provider: deps.provider,
        sources: deps.options?.sources,
        max: deps.options?.max
    });
}
