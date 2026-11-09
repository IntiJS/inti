/**
 * Composition pipeline — frames through replaceable stages (2026-11-07)
 * =====================================================================
 *
 * Pipecat's lesson applied to page composition: a request is a FRAME that
 * flows through ordered stages (context → generation → validation), each a
 * one-line swap, like swapping an STT provider without touching the rest of
 * the pipeline. Today the default stages ARE `compose()`: same behaviour,
 * same validation, but a host can now:
 *
 *   - rewrite the request (personalization, A/B variants) at `toRequest`;
 *   - swap the generator (cache, fallback provider, offline mode) at `generate`;
 *   - post-process or annotate (analytics, extra checks) at `validate`.
 *
 * The pipeline changes nothing about the output contract: a `ValidationResult`,
 * the same JSON an editor saves.
 */

import { buildRequest, loadCandidates } from './compose.js';
import type { ComposeOptions, GenerateRequest } from './compose.js';
import type { Candidates } from './schema.js';
import { validateGenerated } from './validate.js';
import type { ValidationResult } from './validate.js';
import type { Vocabulary, DataSources } from './vocabulary.js';

// ── Frames ──────────────────────────────────────────────────────────────────

/** What was asked: instruction + the declared vocabulary + the data sources. */
export interface RequestFrame {
    kind: 'request';
    options: ComposeOptions;
}

/** What goes to the model: the built prompt and the candidate ids per source. */
export interface ContextFrame {
    kind: 'context';
    request: GenerateRequest;
    candidates: Candidates;
    options: ComposeOptions;
    max: number;
}

/** What came back: the raw model output (before validation). */
export interface GenerationFrame {
    kind: 'generation';
    raw: unknown;
    context: ContextFrame;
}

/** What ships: the validated composition. */
export interface ResultFrame {
    kind: 'result';
    result: ValidationResult;
}

export type Frame = RequestFrame | ContextFrame | GenerationFrame | ResultFrame;

/** A stage: one frame in, one frame out. */
export type Processor<FIn extends Frame, FOut extends Frame> = (frame: FIn) => Promise<FOut>;

// ── The pipeline ────────────────────────────────────────────────────────────

export interface ComposePipeline {
    /** request → context: loads candidates, builds the model request. */
    toRequest: Processor<RequestFrame, ContextFrame>;
    /** context → generation: calls the provider (replaceable: cache, fallback). */
    generate: Processor<ContextFrame, GenerationFrame>;
    /** generation → result: validates shape and content (replaceable). */
    validate: Processor<GenerationFrame, ResultFrame>;
    /** Runs the frames in order and returns the validated result. */
    run(options: ComposeOptions): Promise<ValidationResult>;
}

/**
 * The default pipeline, stage by stage — each default is what `compose()`
 * does today. Pass `overrides` to swap a stage; the rest stay default.
 */
export function createComposePipeline(
    options: ComposeOptions,
    overrides: Partial<Pick<ComposePipeline, 'toRequest' | 'generate' | 'validate'>> = {}
): ComposePipeline {
    const toRequest: Processor<RequestFrame, ContextFrame> = overrides.toRequest ?? (async (frame) => {
        const max = frame.options.max ?? 12;
        const candidates = await loadCandidates(frame.options);
        return {
            kind: 'context',
            request: buildRequest(frame.options, candidates, max),
            candidates,
            options: frame.options,
            max
        };
    });

    const generate: Processor<ContextFrame, GenerationFrame> = overrides.generate ?? (async (frame) => ({
        kind: 'generation',
        raw: await frame.options.provider.generate(frame.request),
        context: frame
    }));

    const validate: Processor<GenerationFrame, ResultFrame> = overrides.validate ?? (async (frame) => ({
        kind: 'result',
        result: validateGenerated(frame.raw, frame.context.options.vocabulary, {
            max: frame.context.max,
            candidates: frame.context.candidates
        })
    }));

    return {
        toRequest,
        generate,
        validate,
        async run(opts: ComposeOptions): Promise<ValidationResult> {
            const request: RequestFrame = { kind: 'request', options: opts };
            const result = await validate(await generate(await toRequest(request)));
            return result.result;
        }
    };
}

// ── Common stage swaps ──────────────────────────────────────────────────────

/**
 * A `generate` stage that caches by prompt+schema fingerprint. The inner
 * provider is only called when the cache misses; TTL in seconds (0 = forever).
 * The cache key never contains content: instruction hash + schema hash.
 */
export function cachedGeneration(
    inner: ComposePipeline['generate'],
    cache: { get(key: string): Promise<unknown | null>; set(key: string, value: unknown, ttlSeconds?: number): Promise<void> },
    ttlSeconds = 3600
): ComposePipeline['generate'] {
    return async (frame) => {
        const fingerprint = await digest(
            JSON.stringify({ request: frame.request, max: frame.max })
        );
        const hit = (await cache.get(fingerprint)) as { raw: unknown } | null;
        if (hit && 'raw' in hit) {
            return { kind: 'generation', raw: hit.raw, context: frame };
        }
        const generated = await inner(frame);
        await cache.set(fingerprint, { raw: generated.raw }, ttlSeconds);
        return generated;
    };
}

async function digest(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
    if (!subtle) {
        // Without Web Crypto (older environments): a longer but working key.
        let h = 0;
        for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
        return `fnv-${(h >>> 0).toString(16)}-${text.length}`;
    }
    const hash = await subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A `toRequest` stage that personalizes the instruction per visitor: the
 * rewriter receives the built request and returns a new one (the candidates
 * and the model contract stay untouched).
 */
export function personalizedRequest(
    rewrite: (request: GenerateRequest, frame: RequestFrame) => GenerateRequest
): Processor<RequestFrame, ContextFrame> {
    return async (frame) => {
        const max = frame.options.max ?? 12;
        const candidates = await loadCandidates(frame.options);
        const request = buildRequest(frame.options, candidates, max);
        return {
            kind: 'context',
            request: rewrite(request, frame),
            candidates,
            options: frame.options,
            max
        };
    };
}

export type { ComposeOptions, DataSources, Vocabulary };
