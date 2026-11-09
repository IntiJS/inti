/**
 * D1: state that has to survive and be visible from any instance. A Worker has no
 * disk or shared memory, so this is where the content of a site with no CMS, the
 * personalization exposures and conversions, the team's patterns and the
 * already composed responses live.
 */

import { IntiAdapter } from '@intijs/core/adapters';
import type {
    DraftableAdapter,
    DraftResult,
    ListableAdapter,
    PageSummary,
    SchemaDefinition,
    WritableAdapter,
    WriteResult
} from '@intijs/core/adapters';
import type { ExperimentStore, ExposureEvent, SlotStats } from '@intijs/core/adapt';
import type { Actor, Pattern, PatternStore } from '@intijs/core/plugins';
import type { IntiBlock, IntiNavigation, IntiPage } from '@intijs/core/types';

/** Safe to run as many times as you like */
export const D1_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS inti_documents (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        draft_of TEXT,
        title TEXT NOT NULL,
        seo TEXT,
        blocks TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS inti_documents_slug ON inti_documents (slug) WHERE draft_of IS NULL`,
    `CREATE TABLE IF NOT EXISTS inti_exposures (
        slot TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        variant INTEGER NOT NULL,
        visitor_group TEXT NOT NULL,
        decider TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (slot, visitor_id)
    )`,
    `CREATE TABLE IF NOT EXISTS inti_conversions (
        visitor_id TEXT PRIMARY KEY,
        goal TEXT,
        value REAL,
        created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS inti_patterns (
        name TEXT PRIMARY KEY,
        blocks TEXT NOT NULL,
        updated_by TEXT,
        updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS inti_compose_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL
    )`
];

export async function migrateD1(db: D1Database): Promise<void> {
    await db.batch(D1_SCHEMA.map((statement) => db.prepare(statement)));
}

const now = () => new Date().toISOString();

// ============================================
// Content
// ============================================

interface DocumentRow {
    id: string;
    slug: string;
    draft_of: string | null;
    title: string;
    seo: string | null;
    blocks: string;
    version: number;
}

const DRAFT_SUFFIX = '--draft';
const UNSAFE_PATH = /(^|\.)(__proto__|constructor|prototype)(\.|$)/;
const MAX_RETRIES = 5;

/**
 * Content in D1, for a site on Cloudflare with no external CMS. Like the local
 * store: it is for what does not justify a CMS, not a substitute for one. No admin panel, no
 * users, no history.
 */
export class D1ContentAdapter extends IntiAdapter implements WritableAdapter, ListableAdapter, DraftableAdapter {
    readonly writable = true as const;

    constructor(private db: D1Database) {
        super('D1');
    }

    private parse(row: DocumentRow): IntiPage {
        const stored: IntiBlock[] = JSON.parse(row.blocks);
        return {
            id: row.id,
            slug: row.slug,
            title: row.title,
            ...(row.seo ? { seo: JSON.parse(row.seo) } : {}),
            blocks: stored.map((block, index) => ({
                ...block,
                meta: { ...block.meta, documentId: row.id, index, total: stored.length }
            }))
        };
    }

    parsePage(raw: DocumentRow): IntiPage {
        return this.parse(raw);
    }

    parseNavigation(): IntiNavigation {
        return { items: [] };
    }

    async introspect(): Promise<SchemaDefinition> {
        return { source: 'd1', version: '1', collections: [] };
    }

    private row(id: string) {
        return this.db.prepare('SELECT * FROM inti_documents WHERE id = ?').bind(id).first<DocumentRow>();
    }

    async fetchPageBySlug(slug: string): Promise<IntiPage> {
        const row = await this.db
            .prepare('SELECT * FROM inti_documents WHERE slug = ? AND draft_of IS NULL')
            .bind(slug)
            .first<DocumentRow>();
        if (!row) throw new Error(`Page not found for slug: ${slug}`);
        return this.parse(row);
    }

    async listPages(): Promise<PageSummary[]> {
        const { results } = await this.db
            .prepare('SELECT slug, title, updated_at FROM inti_documents WHERE draft_of IS NULL')
            .all<{ slug: string; title: string; updated_at: string }>();
        return results.map((row) => ({ slug: row.slug, title: row.title, updatedAt: row.updated_at }));
    }

    /** Creates or replaces a document. For seeding content */
    async putDocument(document: { id: string; slug: string; title: string; blocks: IntiBlock[]; seo?: unknown }): Promise<void> {
        await this.db
            .prepare(
                `INSERT INTO inti_documents (id, slug, title, seo, blocks, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, title = excluded.title, seo = excluded.seo,
                 blocks = excluded.blocks, version = version + 1, updated_at = excluded.updated_at`
            )
            .bind(
                document.id,
                document.slug,
                document.title,
                document.seo ? JSON.stringify(document.seo) : null,
                JSON.stringify(document.blocks),
                now()
            )
            .run();
    }

    /**
     * Read-modify-write with version control: from two instances at once, one of
     * the two writes does not match, so it re-reads and retries instead of overwriting the other.
     */
    private async mutate(documentId: string, apply: (blocks: IntiBlock[]) => void, value?: unknown): Promise<WriteResult> {
        try {
            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                const row = await this.row(documentId);
                if (!row) throw new Error(`Document "${documentId}" not found`);

                const blocks: IntiBlock[] = JSON.parse(row.blocks);
                apply(blocks);

                const { meta } = await this.db
                    .prepare('UPDATE inti_documents SET blocks = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
                    .bind(JSON.stringify(blocks), now(), documentId, row.version)
                    .run();

                if (meta.changes === 1) return { success: true, documentId, value, source: 'd1' };
            }
            throw new Error('Too many concurrent writes, try again');
        } catch (error) {
            return { success: false, documentId, error: error instanceof Error ? error.message : String(error), source: 'd1' };
        }
    }

    private assertIndex(blocks: IntiBlock[], index: number): void {
        if (!Number.isInteger(index) || index < 0 || index >= blocks.length) {
            throw new Error(`Block index ${index} out of range`);
        }
    }

    updateBlockField(documentId: string, blockIndex: number, field: string, value: any): Promise<WriteResult> {
        return this.mutate(
            documentId,
            (blocks) => {
                if (UNSAFE_PATH.test(field)) throw new Error(`Invalid field path "${field}"`);
                this.assertIndex(blocks, blockIndex);

                const parts = field.split('.');
                let cursor: any = (blocks[blockIndex].data ??= {});
                for (const part of parts.slice(0, -1)) {
                    if (cursor[part] === null || typeof cursor[part] !== 'object') cursor[part] = {};
                    cursor = cursor[part];
                }
                cursor[parts[parts.length - 1]] = value;
            },
            value
        );
    }

    updateBlock(documentId: string, blockIndex: number, data: Record<string, any>): Promise<WriteResult> {
        return this.mutate(documentId, (blocks) => {
            this.assertIndex(blocks, blockIndex);
            blocks[blockIndex] = { ...blocks[blockIndex], data };
        });
    }

    moveBlock(documentId: string, fromIndex: number, toIndex: number): Promise<WriteResult> {
        return this.mutate(documentId, (blocks) => {
            this.assertIndex(blocks, fromIndex);
            this.assertIndex(blocks, toIndex);
            const [moved] = blocks.splice(fromIndex, 1);
            blocks.splice(toIndex, 0, moved);
        });
    }

    insertBlock(documentId: string, index: number, nativeType: string, data: Record<string, any> = {}): Promise<WriteResult> {
        return this.insertBlocks(documentId, index, [{ nativeType, data }]);
    }

    insertBlocks(documentId: string, index: number, added: Array<{ nativeType: string; data?: Record<string, any> }>): Promise<WriteResult> {
        return this.mutate(documentId, (blocks) => {
            const at = Math.max(0, Math.min(index, blocks.length));
            blocks.splice(at, 0, ...added.map((block) => ({ type: block.nativeType, data: block.data ?? {} })));
        });
    }

    removeBlock(documentId: string, index: number): Promise<WriteResult> {
        return this.mutate(documentId, (blocks) => {
            this.assertIndex(blocks, index);
            blocks.splice(index, 1);
        });
    }

    duplicateBlock(documentId: string, index: number): Promise<WriteResult> {
        return this.mutate(documentId, (blocks) => {
            this.assertIndex(blocks, index);
            blocks.splice(index + 1, 0, JSON.parse(JSON.stringify(blocks[index])));
        });
    }

    async fetchDraftBySlug(slug: string): Promise<IntiPage | null> {
        const row = await this.db
            .prepare('SELECT * FROM inti_documents WHERE slug = ? AND draft_of IS NOT NULL')
            .bind(slug)
            .first<DocumentRow>();
        return row ? this.parse(row) : null;
    }

    async createDraft(documentId: string): Promise<DraftResult> {
        const original = await this.row(documentId);
        if (!original) return { success: false, documentId, error: `Document "${documentId}" not found`, source: 'd1' };

        const id = `${documentId}${DRAFT_SUFFIX}`;
        // If one already existed, keep using it: work in progress is never overwritten
        await this.db
            .prepare(
                `INSERT INTO inti_documents (id, slug, draft_of, title, seo, blocks, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO NOTHING`
            )
            .bind(id, original.slug, documentId, original.title, original.seo, original.blocks, now())
            .run();
        return { success: true, documentId: id, slug: original.slug, source: 'd1' };
    }

    /** Both statements go in a `batch`, which D1 runs as a transaction */
    async publishDraft(draftId: string): Promise<DraftResult> {
        const draft = await this.row(draftId);
        if (!draft?.draft_of) return { success: false, documentId: draftId, error: `"${draftId}" is not a draft`, source: 'd1' };

        await this.db.batch([
            this.db
                .prepare('UPDATE inti_documents SET title = ?, seo = ?, blocks = ?, version = version + 1, updated_at = ? WHERE id = ?')
                .bind(draft.title, draft.seo, draft.blocks, now(), draft.draft_of),
            this.db.prepare('DELETE FROM inti_documents WHERE id = ?').bind(draftId)
        ]);
        return { success: true, documentId: draft.draft_of, slug: draft.slug, source: 'd1' };
    }

    async discardDraft(draftId: string): Promise<DraftResult> {
        const draft = await this.row(draftId);
        if (!draft?.draft_of) return { success: false, documentId: draftId, error: `"${draftId}" is not a draft`, source: 'd1' };

        await this.db.prepare('DELETE FROM inti_documents WHERE id = ?').bind(draftId).run();
        return { success: true, documentId: draft.draft_of, slug: draft.slug, source: 'd1' };
    }
}

// ============================================
// Measurement
// ============================================

/** A visitor counts once per slot, with the first thing they saw */
export function createD1ExperimentStore(db: D1Database): ExperimentStore & { stats(slot: string): Promise<SlotStats> } {
    return {
        async recordExposure(event: ExposureEvent) {
            if (!event.visitorId) return;
            await db
                .prepare(
                    `INSERT INTO inti_exposures (slot, visitor_id, variant, visitor_group, decider, created_at) VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT (slot, visitor_id) DO NOTHING`
                )
                .bind(event.slot, event.visitorId, event.index, event.group, event.decider, now())
                .run();
        },
        async recordConversion(event) {
            await db
                .prepare(`INSERT INTO inti_conversions (visitor_id, goal, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (visitor_id) DO NOTHING`)
                .bind(event.visitorId, event.goal ?? null, event.value ?? null, now())
                .run();
        },
        async stats(slot) {
            const { results } = await db
                .prepare(
                    `SELECT e.variant, e.visitor_group, COUNT(*) AS visitors, COUNT(c.visitor_id) AS conversions
                     FROM inti_exposures e LEFT JOIN inti_conversions c ON c.visitor_id = e.visitor_id
                     WHERE e.slot = ? GROUP BY e.variant, e.visitor_group`
                )
                .bind(slot)
                .all<{ variant: number; visitor_group: string; visitors: number; conversions: number }>();

            const stats: SlotStats = {
                variants: {},
                groups: { personalized: { visitors: 0, conversions: 0 }, control: { visitors: 0, conversions: 0 } }
            };
            for (const row of results) {
                const variant = (stats.variants[row.variant] ??= { visitors: 0, conversions: 0 });
                variant.visitors += row.visitors;
                variant.conversions += row.conversions;
                if (row.visitor_group === 'control' || row.visitor_group === 'personalized') {
                    stats.groups[row.visitor_group].visitors += row.visitors;
                    stats.groups[row.visitor_group].conversions += row.conversions;
                }
            }
            return stats;
        }
    };
}

// ============================================
// Patterns and composition cache
// ============================================

export function createD1PatternStore(db: D1Database): PatternStore {
    return {
        async list() {
            const { results } = await db.prepare('SELECT name, blocks FROM inti_patterns ORDER BY name').all<{ name: string; blocks: string }>();
            return results.map((row) => ({ name: row.name, blocks: JSON.parse(row.blocks) }));
        },
        async save(pattern: Pattern, actor: Actor | null) {
            await db
                .prepare(
                    `INSERT INTO inti_patterns (name, blocks, updated_by, updated_at) VALUES (?, ?, ?, ?)
                     ON CONFLICT (name) DO UPDATE SET blocks = excluded.blocks, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
                )
                .bind(pattern.name, JSON.stringify(pattern.blocks), actor?.id ?? null, now())
                .run();
        },
        async remove(name: string) {
            await db.prepare('DELETE FROM inti_patterns WHERE name = ?').bind(name).run();
        }
    };
}

/** Cache for `createVisitorComposer`: shared, and survives the Worker being recycled */
export function createD1ComposeCache(db: D1Database) {
    return {
        async get(key: string): Promise<string | null> {
            const row = await db
                .prepare('SELECT value FROM inti_compose_cache WHERE key = ? AND expires_at > ?')
                .bind(key, Date.now())
                .first<{ value: string }>();
            return row?.value ?? null;
        },
        async set(key: string, value: string, ttlSeconds: number): Promise<void> {
            await db
                .prepare(`INSERT INTO inti_compose_cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`)
                .bind(key, value, Date.now() + ttlSeconds * 1000)
                .run();
        }
    };
}
