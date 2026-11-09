/**
 * Team patterns: block patterns shared by the whole team.
 *
 * In the MIT core each editor keeps their patterns in their browser's
 * localStorage: they are not shared and do not survive a change of machine.
 * With a shared store, the pattern one editor saves is seen by everyone.
 *
 * As with the audit log, storage is pluggable because each deployment
 * keeps it somewhere different.
 */

import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Actor, Pattern, PatternStore } from '../plugins/index.js';

/** Normalizes and stamps a pattern before persisting it */
function stamp(pattern: Pattern, actor: Actor | null, at: Date = new Date()): Pattern {
    return {
        name: pattern.name,
        blocks: pattern.blocks,
        createdBy: pattern.createdBy ?? actor?.id ?? null,
        updatedAt: at.toISOString()
    };
}

/** Replaces by name: saving the same name twice does not duplicate */
function upsert(patterns: Pattern[], pattern: Pattern): Pattern[] {
    return [...patterns.filter((p) => p.name !== pattern.name), pattern];
}

/**
 * In-memory store. For tests and development: lost on restart.
 */
export function createMemoryPatternStore(initial: Pattern[] = []): PatternStore & { patterns: Pattern[] } {
    let patterns = [...initial];

    return {
        get patterns() {
            return patterns;
        },
        async list() {
            return [...patterns];
        },
        async save(pattern, actor) {
            patterns = upsert(patterns, stamp(pattern, actor));
        },
        async remove(name) {
            patterns = patterns.filter((p) => p.name !== name);
        }
    };
}

/**
 * Store in a single JSON file.
 *
 * Each mutation is a read-modify-write, so two simultaneous saves would
 * overwrite each other (the second reads before the first writes and wipes
 * its change). That is why mutations are serialized in a queue: besides
 * avoiding data loss, it stops two `rename` calls from racing for the
 * same target, which fails with EPERM on Windows.
 */
export function createFilePatternStore(filePath: string): PatternStore {
    let queue: Promise<unknown> = Promise.resolve();

    /** Queues a mutation behind the previous ones, whether they fail or not */
    function serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = queue.then(operation, operation);
        // A failure must not poison the queue for the following ones
        queue = result.catch(() => undefined);
        return result;
    }

    async function read(): Promise<Pattern[]> {
        try {
            const parsed = JSON.parse(await readFile(filePath, 'utf8'));
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            // Does not exist yet, or got corrupted: start from empty
            return [];
        }
    }

    async function write(patterns: Pattern[]): Promise<void> {
        // Temp file in the same directory so the rename is atomic
        const temp = join(dirname(filePath), `.inti-patterns-${process.pid}-${counter++}.tmp`);
        await writeFile(temp, JSON.stringify(patterns, null, 2), 'utf8');
        await rename(temp, filePath);
    }

    return {
        list: read,
        save: (pattern, actor) => serialize(async () => write(upsert(await read(), stamp(pattern, actor)))),
        remove: (name) => serialize(async () => write((await read()).filter((p) => p.name !== name)))
    };
}

/** Incremental suffix for the process's temp files */
let counter = 0;

/**
 * Your own store: the CMS, Postgres, a bucket, whatever you use.
 */
export function createCustomPatternStore(store: PatternStore): PatternStore {
    return store;
}

/**
 * Wraps a store so that only certain roles can write to it.
 *
 * A shared pattern is seen by the whole team, so you usually want anyone
 * to be able to use them but not anyone to be able to change them.
 */
export function restrictPatternWrites(store: PatternStore, allowedRoles: string[]): PatternStore {
    function assert(actor: Actor | null, action: string): void {
        const role = actor?.role;
        if (!role || !allowedRoles.includes(role)) {
            throw new Error(
                `Role "${role ?? 'anonymous'}" cannot ${action} shared patterns ` +
                    `(allowed: ${allowedRoles.join(', ')})`
            );
        }
    }

    return {
        list: () => store.list(),
        async save(pattern, actor) {
            assert(actor, 'save');
            await store.save(pattern, actor);
        },
        async remove(name, actor) {
            assert(actor, 'delete');
            await store.remove(name, actor);
        }
    };
}
