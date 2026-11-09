/**
 * Local adapter: content in a JSON file in the project.
 *
 * Inti is a layer over YOUR CMS. This adapter does not try to be a CMS: it
 * is the minimum needed to try inline editing without connecting anything,
 * and to give the examples and the demo somewhere to write.
 *
 * It fulfills the same contract as WordPress or Strapi, so the rest of the
 * system cannot tell the difference: there is no special "fallback" path.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { IntiAdapter } from './index.js';
import type {
    DraftableAdapter,
    DraftResult,
    EntrySummary,
    ListableAdapter,
    PageSummary,
    SearchableAdapter,
    WritableAdapter,
    WriteResult
} from './index.js';
import type { IntiBlock, IntiNavigation, IntiPage, PageSeo } from '../types/index.js';

/** Document as stored on disk */
interface StoredDocument {
    id: string;
    slug: string;
    title: string;
    blocks: IntiBlock[];
    /** SEO metadata, with the same shape as `IntiPage.seo` */
    seo?: PageSeo;
    /** If this is the working copy of another document, which one */
    draftOf?: string;
}

const DRAFT_SUFFIX = '--draft';

interface StoreShape {
    documents: Record<string, StoredDocument>;
}

export interface LocalAdapterConfig {
    /** Path of the JSON file. Default: .inti/content.json (or INTI_LOCAL_STORE) */
    file?: string;
}

/**
 * A NEW empty store on every call.
 *
 * It must be a function, not a constant: with a shared object, the
 * spread is a shallow copy and every instance would end up mutating
 * the same `documents`.
 */
const emptyStore = (): StoreShape => ({ documents: {} });

export class LocalAdapter extends IntiAdapter implements WritableAdapter, SearchableAdapter, ListableAdapter, DraftableAdapter {
    readonly writable = true as const;

    private file: string;
    /** Mutation queue: concurrent read-modify-writes would overwrite each other */
    private queue: Promise<unknown> = Promise.resolve();
    private tempCounter = 0;

    constructor(config: LocalAdapterConfig = {}) {
        super('local', config);
        const configured =
            config.file ??
            (typeof process !== 'undefined' ? process.env?.INTI_LOCAL_STORE : undefined) ??
            join('.inti', 'content.json');
        this.file = resolve(configured);
    }

    // ============================================
    // Persistence
    // ============================================

    private async read(): Promise<StoreShape> {
        try {
            const parsed = JSON.parse(await readFile(this.file, 'utf8'));
            return parsed && typeof parsed.documents === 'object' ? parsed : emptyStore();
        } catch {
            // It does not exist yet, or became unreadable: start from empty
            return emptyStore();
        }
    }

    /** Atomic write: temp file in the same directory + rename */
    private async write(store: StoreShape): Promise<void> {
        await mkdir(dirname(this.file), { recursive: true });
        const temp = join(dirname(this.file), `.inti-${process.pid}-${this.tempCounter++}.tmp`);
        await writeFile(temp, JSON.stringify(store, null, 2), 'utf8');
        await rename(temp, this.file);
    }

    /** Queues a mutation behind the previous ones, whether they fail or not */
    private serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation, operation);
        this.queue = result.catch(() => undefined);
        return result;
    }

    /**
     * Applies a mutation to a document's blocks.
     * Every write of the adapter goes through here.
     */
    private mutate(documentId: string, apply: (blocks: IntiBlock[]) => void): Promise<WriteResult> {
        return this.serialize(async () => {
            const store = await this.read();
            const document = store.documents[documentId];

            if (!document) {
                return { success: false, documentId, error: `Document "${documentId}" not found`, source: 'local' };
            }

            const blocks = [...(document.blocks ?? [])];

            try {
                apply(blocks);
            } catch (error) {
                return {
                    success: false,
                    documentId,
                    error: error instanceof Error ? error.message : String(error),
                    source: 'local'
                };
            }

            store.documents[documentId] = { ...document, blocks };
            await this.write(store);

            return { success: true, documentId, source: 'local' };
        });
    }

    private assertIndex(blocks: IntiBlock[], index: number, label = 'Block index'): void {
        if (!Number.isInteger(index) || index < 0 || index >= blocks.length) {
            throw new Error(`${label} ${index} out of range`);
        }
    }

    // ============================================
    // Reading
    // ============================================

    parsePage(raw: StoredDocument): IntiPage {
        return {
            id: raw.id,
            slug: raw.slug,
            title: raw.title,
            // It used to be dropped: a document with its `seo` saved was
            // published with the page title and no meta description.
            ...(raw.seo ? { seo: raw.seo } : {}),
            blocks: (raw.blocks ?? []).map((block, index) => ({
                ...block,
                meta: { ...block.meta, documentId: raw.id, index, total: raw.blocks?.length ?? 0 }
            }))
        };
    }

    parseNavigation(raw: IntiNavigation): IntiNavigation {
        return raw;
    }

    /** There is no schema to introspect: the JSON defines the content */
    async introspect() {
        const store = await this.read();
        return {
            source: 'local',
            version: '1',
            collections: [
                {
                    name: 'documents',
                    description: `Local documents in ${this.file}`,
                    fields: [
                        { name: 'slug', type: 'string' as const, required: true },
                        { name: 'title', type: 'string' as const, required: true },
                        { name: 'blocks', type: 'blocks' as const }
                    ]
                }
            ],
            documentCount: Object.keys(store.documents).length
        };
    }

    async fetchPageBySlug(slug: string): Promise<IntiPage> {
        const store = await this.read();
        const document = Object.values(store.documents).find((d) => d.slug === slug && !d.draftOf);

        if (!document) {
            throw new Error(
                `No local document with slug "${slug}". ` +
                    `Add one to ${this.file}, or configure a CMS with INTI_ADAPTER.`
            );
        }

        return this.parsePage(document);
    }

    /** Creates or replaces a document. Meant for seeding examples and tests */
    async putDocument(document: StoredDocument): Promise<void> {
        await this.serialize(async () => {
            const store = await this.read();
            store.documents[document.id] = document;
            await this.write(store);
        });
    }

    async listPages(): Promise<PageSummary[]> {
        const store = await this.read();
        return Object.values(store.documents)
            .filter((doc) => !doc.draftOf)
            .map((doc) => ({ slug: doc.slug, title: doc.title }));
    }

    async searchEntries(_collection: string, query: string): Promise<EntrySummary[]> {
        const store = await this.read();
        const q = query.toLowerCase();

        return Object.values(store.documents)
            .filter((doc) => !doc.draftOf && (!q || doc.title.toLowerCase().includes(q)))
            .slice(0, 10)
            .map((doc) => ({ id: doc.id, title: doc.title, subtitle: doc.slug }));
    }

    // ============================================
    // Drafts
    // ============================================

    async fetchDraftBySlug(slug: string): Promise<IntiPage | null> {
        const store = await this.read();
        const draft = Object.values(store.documents).find((d) => d.draftOf && d.slug === slug);
        return draft ? this.parsePage(draft) : null;
    }

    createDraft(documentId: string): Promise<DraftResult> {
        return this.serialize(async () => {
            const store = await this.read();
            const original = store.documents[documentId];
            if (!original) {
                return { success: false, documentId, error: `Document "${documentId}" not found`, source: 'local' };
            }

            const id = `${documentId}${DRAFT_SUFFIX}`;
            // There was one already: keep using it instead of overwriting what it has
            if (!store.documents[id]) {
                store.documents[id] = { ...JSON.parse(JSON.stringify(original)), id, draftOf: documentId };
                await this.write(store);
            }
            return { success: true, documentId: id, slug: original.slug, source: 'local' };
        });
    }

    publishDraft(draftId: string): Promise<DraftResult> {
        return this.serialize(async () => {
            const store = await this.read();
            const draft = store.documents[draftId];
            if (!draft?.draftOf) {
                return { success: false, documentId: draftId, error: `"${draftId}" is not a draft`, source: 'local' };
            }

            const { draftOf, ...published } = draft;
            store.documents[draftOf] = { ...published, id: draftOf };
            delete store.documents[draftId];
            await this.write(store);
            return { success: true, documentId: draftOf, slug: draft.slug, source: 'local' };
        });
    }

    discardDraft(draftId: string): Promise<DraftResult> {
        return this.serialize(async () => {
            const store = await this.read();
            const draft = store.documents[draftId];
            if (!draft?.draftOf) {
                return { success: false, documentId: draftId, error: `"${draftId}" is not a draft`, source: 'local' };
            }

            delete store.documents[draftId];
            await this.write(store);
            return { success: true, documentId: draft.draftOf, slug: draft.slug, source: 'local' };
        });
    }

    // ============================================
    // Writing
    // ============================================

    async updateBlockField(documentId: string, blockIndex: number, field: string, value: any): Promise<WriteResult> {
        const result = await this.mutate(documentId, (blocks) => {
            this.assertIndex(blocks, blockIndex);

            const block = JSON.parse(JSON.stringify(blocks[blockIndex]));
            const parts = field.split('.');
            let cursor: any = block.data ?? (block.data = {});

            for (let i = 0; i < parts.length - 1; i++) {
                if (cursor[parts[i]] === null || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {};
                cursor = cursor[parts[i]];
            }
            cursor[parts[parts.length - 1]] = value;

            blocks[blockIndex] = block;
        });

        return result.success ? { ...result, value } : result;
    }

    async updateBlock(documentId: string, blockIndex: number, data: Record<string, any>): Promise<WriteResult> {
        return this.mutate(documentId, (blocks) => {
            this.assertIndex(blocks, blockIndex);
            blocks[blockIndex] = { ...blocks[blockIndex], data };
        });
    }

    async moveBlock(documentId: string, fromIndex: number, toIndex: number): Promise<WriteResult> {
        return this.mutate(documentId, (blocks) => {
            this.assertIndex(blocks, fromIndex, 'From index');
            this.assertIndex(blocks, toIndex, 'To index');

            const [moved] = blocks.splice(fromIndex, 1);
            blocks.splice(toIndex, 0, moved);
        });
    }

    async insertBlock(
        documentId: string,
        index: number,
        nativeType: string,
        data: Record<string, any> = {}
    ): Promise<WriteResult> {
        return this.mutate(documentId, (blocks) => {
            // Inserting at the end is valid, which is why assertIndex is not used
            const clamped = Math.max(0, Math.min(index, blocks.length));
            blocks.splice(clamped, 0, { type: nativeType, data });
        });
    }

    async insertBlocks(
        documentId: string,
        index: number,
        blocks: Array<{ nativeType: string; data?: Record<string, any> }>
    ): Promise<WriteResult> {
        return this.mutate(documentId, (current) => {
            const clamped = Math.max(0, Math.min(index, current.length));
            current.splice(
                clamped,
                0,
                ...blocks.map((block) => ({ type: block.nativeType, data: block.data ?? {} }))
            );
        });
    }

    async removeBlock(documentId: string, index: number): Promise<WriteResult> {
        return this.mutate(documentId, (blocks) => {
            this.assertIndex(blocks, index);
            blocks.splice(index, 1);
        });
    }

    async duplicateBlock(documentId: string, index: number): Promise<WriteResult> {
        return this.mutate(documentId, (blocks) => {
            this.assertIndex(blocks, index);
            blocks.splice(index + 1, 0, JSON.parse(JSON.stringify(blocks[index])));
        });
    }
}
