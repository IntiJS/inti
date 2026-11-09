/**
 * Inti's plugin system.
 *
 * Extension points on the write path. It exists so that external packages
 * (your own, community plugins, a future commercial add-on) can intercept writes WITHOUT
 * @intijs/core depending on them: core only calls whatever is registered,
 * and if nothing is registered the behavior is exactly the same as
 * before.
 *
 * Core never imports a plugin. The dependency always points
 * plugin → core.
 */

import type { IntiAdapter, WritableAdapter, WriteResult } from '../adapters/index.js';
import type { Decider, ExperimentStore } from '../adapt/index.js';

// ============================================
// Types
// ============================================

/** Write operations that go through the actions */
export type WriteOperation =
    | 'updateBlockField'
    | 'updateBlock'
    | 'moveBlock'
    | 'insertBlock'
    | 'removeBlock'
    | 'duplicateBlock'
    | 'createDraft'
    | 'publishDraft'
    | 'discardDraft'
    /**
     * Not a write: used when resolving the actor to open the editor
     * or the realtime channel. It only reaches `resolveActor`, never
     * `beforeWrite` or `afterWrite`.
     */
    | 'session';

/** Who performs the operation */
export interface Actor {
    id: string;
    role: string;
    email?: string;
    name?: string;
}

/** Context of a write, as a plugin sees it */
export interface WriteContext {
    operation: WriteOperation;
    documentId: string;
    /** Index of the affected block. -1 = page-level field */
    blockIndex?: number;
    /** Affected field (dot-path: 'cta.label') */
    field?: string;
    /** New value, in field operations */
    value?: unknown;
    /** Whole data, in updateBlock / insertBlock */
    data?: Record<string, unknown>;
    /** Reordering */
    fromIndex?: number;
    toIndex?: number;
    /** Native CMS type, in insertBlock */
    nativeType?: string;
    /** Affected block type, if it could be determined */
    blockType?: string;
    /** Resolved by the plugin before evaluating permissions */
    actor?: Actor | null;
    /** The action's original request, to resolve identity */
    request?: Request;
    /** Astro cookies, to resolve the session */
    cookies?: unknown;
}

/** Verdict of a beforeWrite hook */
export interface WriteDecision {
    allowed: boolean;
    /** Readable reason when allowed === false */
    reason?: string;
}

// ============================================
// Patterns
// ============================================

/** A block inside a pattern, in its native CMS type */
export interface PatternBlock {
    nativeType: string;
    data: Record<string, unknown>;
}

/** Group of blocks saved to reinsert on other pages */
export interface Pattern {
    name: string;
    blocks: PatternBlock[];
    /** Actor who saved it, if it could be identified */
    createdBy?: string | null;
    updatedAt?: string;
}

/**
 * Shared pattern store.
 *
 * Without a plugin that provides one, the composer saves patterns in the
 * browser's localStorage: they serve a single editor and are not shared.
 */
export interface PatternStore {
    list(): Promise<Pattern[]>;
    save(pattern: Pattern, actor: Actor | null): Promise<void>;
    remove(name: string, actor: Actor | null): Promise<void>;
}

// ============================================
// Realtime
// ============================================

/** Edit message that travels between connected editors */
export interface RealtimeMessage {
    /** Document it belongs to. The fan-out never crosses documents */
    documentId: string;
    /** Who sent it, so it is not echoed back to them */
    senderId: string;
    type: string;
    data?: unknown;
}

/**
 * Message transport between processes.
 *
 * The core ships an in-memory one that only reaches the current process:
 * it works in dev and in a single-instance deployment. With several
 * instances behind a load balancer a shared one is needed (Valkey, Durable
 * Objects, a hosted relay): `createValkeyBackplane` in @intijs/core/team,
 * or `IntiRoom` in @intijs/cloudflare.
 */
export interface RealtimeBackplane {
    publish(message: RealtimeMessage): Promise<void>;
    /** Registers the handler and returns a function to cancel it */
    subscribe(handler: (message: RealtimeMessage) => void): Promise<() => void>;
    close?(): Promise<void>;
}

// ============================================
// Assisted generation
// ============================================

/** Vocabulary offered to the generator */
export interface GeneratorBlockType {
    nativeType: string;
    label?: string;
    description?: string;
    /** When this block is a good fit */
    when?: string;
    /**
     * Declared fields. Without this only the empty block can be inserted.
     * Also accepts lists, objects and references: @intijs/genui defines the full
     * shape, and core only carries it.
     */
    fields?: Record<string, { type: string; description?: string; [option: string]: any }>;
    variants?: Record<string, string[]>;
}

export interface GenerationResult {
    /** What is saved to the CMS */
    blocks: PatternBlock[];
    /** What is previewed, with references resolved. Default: `blocks` */
    rendered?: PatternBlock[];
    /** Non-fatal warnings: dropped fields, undeclared types… */
    warnings: string[];
}

/** One step of a streaming generation */
export type GenerationEvent =
    | { type: 'block'; index: number; block: PatternBlock; rendered: PatternBlock }
    | { type: 'warning'; message: string }
    | { type: 'done'; count: number };

/**
 * Generates blocks from a natural-language instruction.
 *
 * The generator does NOT invent types: it receives the vocabulary declared
 * by the developer and can only compose with it. It is the same rule that
 * governs the human editor.
 */
export interface BlockGenerator {
    generate(prompt: string, blockTypes: GeneratorBlockType[], options?: { max?: number }): Promise<GenerationResult>;
    /** Block by block, to show the proposal as it comes. Optional */
    stream?(prompt: string, blockTypes: GeneratorBlockType[], options?: { max?: number }): AsyncIterable<GenerationEvent>;
}

export interface IntiPlugin {
    name: string;

    /**
     * Identifies who makes the request. The first plugin that returns
     * an actor wins; core imposes no identity model.
     */
    resolveActor?(ctx: WriteContext): Promise<Actor | null> | Actor | null;

    /**
     * Runs before writing. Returning `{ allowed: false }` aborts the
     * operation. Returning undefined means having no opinion.
     */
    beforeWrite?(ctx: WriteContext): Promise<WriteDecision | void> | WriteDecision | void;

    /**
     * Runs after writing, on success as well as on failure.
     * It can never alter the result: it is for side effects
     * (audit log, cache invalidation, notifications).
     */
    afterWrite?(ctx: WriteContext, result: WriteResult): Promise<void> | void;

    /**
     * Provides a shared pattern store. The first one that returns one
     * wins; if none does, the composer uses localStorage.
     */
    getPatternStore?(): PatternStore | null | undefined;

    /**
     * Provides a shared backplane for multi-instance realtime.
     * Without it, the core only fans out within its own process.
     */
    getRealtimeBackplane?(): RealtimeBackplane | null | undefined;

    /** Provides an AI-assisted block generator */
    getBlockGenerator?(): BlockGenerator | null | undefined;

    /**
     * Provides the already-built write adapter, instead of resolving it from
     * environment variables. Anything that depends on a binding needs it, like D1 in a
     * Worker, and it works in any environment where a dynamic import cannot be resolved.
     */
    getWriteAdapter?(): (IntiAdapter & WritableAdapter) | null | undefined;

    /** Personalization deciders, in order. The audience rules come after them */
    getDeciders?(): Decider[] | null | undefined;

    /** Where to store exposures and conversions, to measure whether personalizing helps */
    getExperimentStore?(): ExperimentStore | null | undefined;
}

// ============================================
// Registry
// ============================================

/**
 * A single registry per process, stored on `globalThis`.
 *
 * This module exists twice in a real project: the user registers with
 * `@intijs/core/plugins`, which resolves to `dist/`, but the `.astro`
 * components and the injected routes load from `src/` and import this
 * file by relative path. With one array per module there were two
 * registries: the plugin ended up in one and the editor session, the
 * search and the realtime channel read the other, empty one. In production
 * no editor could open the editor —not even with an SSO plugin— and the
 * Valkey backplane never reached /api/inti/sync. The component registry
 * already solved it this way.
 */
const _global = globalThis as { __intiPlugins?: IntiPlugin[] };
if (!_global.__intiPlugins) {
    _global.__intiPlugins = [];
}
const plugins: IntiPlugin[] = _global.__intiPlugins;

/**
 * Registers a plugin. Idempotent by name: registering the same name
 * again replaces the previous one in its position, so reloading in
 * dev does not pile up duplicates.
 */
export function registerIntiPlugin(plugin: IntiPlugin): void {
    const existing = plugins.findIndex((p) => p.name === plugin.name);
    if (existing >= 0) {
        plugins[existing] = plugin;
        return;
    }
    plugins.push(plugin);
}

export function getIntiPlugins(): readonly IntiPlugin[] {
    return plugins;
}

/** Empties the registry. Meant for tests. */
export function clearIntiPlugins(): void {
    plugins.length = 0;
}

/**
 * Is anyone checking who writes?
 *
 * The actions' access control asks this to tell "the write was allowed
 * after evaluating it" apart from "there was nothing to evaluate it".
 * It checks whether the hook is declared, not what it returns: a
 * `beforeWrite` that allows anonymous writes is a legitimate decision of
 * the integrator, and it is not our place to contradict it.
 */
export function hasWriteGuard(): boolean {
    return plugins.some((plugin) => !!plugin.beforeWrite || !!plugin.resolveActor);
}

// ============================================
// Hook execution
// ============================================

/** A plugin failure must not break the write: warn and carry on */
function warn(hook: string, pluginName: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Inti] Plugin "${pluginName}" failed in ${hook}: ${message}`);
}

/**
 * Asks the plugins who the actor is. The first one to answer wins.
 */
export async function resolveActor(ctx: WriteContext): Promise<Actor | null> {
    for (const plugin of plugins) {
        if (!plugin.resolveActor) continue;
        try {
            const actor = await plugin.resolveActor(ctx);
            if (actor) return actor;
        } catch (error) {
            warn('resolveActor', plugin.name, error);
        }
    }
    return null;
}

/**
 * Runs the beforeWrite hooks. Stops at the first denial.
 *
 * With no plugins registered it returns `{ allowed: true }`, which is the
 * default behavior of open editing.
 */
export async function runBeforeWrite(ctx: WriteContext): Promise<WriteDecision> {
    for (const plugin of plugins) {
        if (!plugin.beforeWrite) continue;
        try {
            const decision = await plugin.beforeWrite(ctx);
            if (decision && decision.allowed === false) {
                return { allowed: false, reason: decision.reason ?? `Denied by plugin "${plugin.name}"` };
            }
        } catch (error) {
            // A broken plugin must not turn into a silent block
            warn('beforeWrite', plugin.name, error);
        }
    }
    return { allowed: true };
}

/**
 * Returns the shared pattern store, if some plugin provides one.
 * null means "use localStorage": patterns per editor, not per team.
 */
export function resolvePatternStore(): PatternStore | null {
    for (const plugin of plugins) {
        if (!plugin.getPatternStore) continue;
        try {
            const store = plugin.getPatternStore();
            if (store) return store;
        } catch (error) {
            warn('getPatternStore', plugin.name, error);
        }
    }
    return null;
}

/**
 * Returns the shared realtime backplane, if some plugin provides one.
 * null means "this process only".
 */
export function resolveRealtimeBackplane(): RealtimeBackplane | null {
    for (const plugin of plugins) {
        if (!plugin.getRealtimeBackplane) continue;
        try {
            const backplane = plugin.getRealtimeBackplane();
            if (backplane) return backplane;
        } catch (error) {
            warn('getRealtimeBackplane', plugin.name, error);
        }
    }
    return null;
}

export function resolvePluginWriteAdapter(): (IntiAdapter & WritableAdapter) | null {
    for (const plugin of plugins) {
        if (!plugin.getWriteAdapter) continue;
        try {
            const adapter = plugin.getWriteAdapter();
            if (adapter) return adapter;
        } catch (error) {
            warn('getWriteAdapter', plugin.name, error);
        }
    }
    return null;
}

/** All the deciders the plugins provide, in registration order */
export function resolveDeciders(): Decider[] {
    const deciders: Decider[] = [];
    for (const plugin of plugins) {
        if (!plugin.getDeciders) continue;
        try {
            deciders.push(...(plugin.getDeciders() ?? []));
        } catch (error) {
            warn('getDeciders', plugin.name, error);
        }
    }
    return deciders;
}

export function resolveExperimentStore(): ExperimentStore | null {
    for (const plugin of plugins) {
        if (!plugin.getExperimentStore) continue;
        try {
            const store = plugin.getExperimentStore();
            if (store) return store;
        } catch (error) {
            warn('getExperimentStore', plugin.name, error);
        }
    }
    return null;
}

/** Returns the block generator, if some plugin provides one */
export function resolveBlockGenerator(): BlockGenerator | null {
    for (const plugin of plugins) {
        if (!plugin.getBlockGenerator) continue;
        try {
            const generator = plugin.getBlockGenerator();
            if (generator) return generator;
        } catch (error) {
            warn('getBlockGenerator', plugin.name, error);
        }
    }
    return null;
}

/**
 * Runs the afterWrite hooks. Never throws: side effects cannot bring
 * down a write that already happened.
 */
export async function runAfterWrite(ctx: WriteContext, result: WriteResult): Promise<void> {
    for (const plugin of plugins) {
        if (!plugin.afterWrite) continue;
        try {
            await plugin.afterWrite(ctx, result);
        } catch (error) {
            warn('afterWrite', plugin.name, error);
        }
    }
}
