/**
 * Adapter for Keystatic: edit its files by double-clicking the page.
 *
 * Keystatic stores content in files in a repo and edits it in an admin panel. It
 * has no write API, so this adapter writes those same files in the format its
 * reader expects. Its tests check this with the official reader.
 *
 * A page is an entry in a collection with a `fields.blocks` field:
 *
 *   # content/pages/home.yaml
 *   title: Inicio
 *   blocks:
 *     - discriminant: hero
 *       value:
 *         heading: Hola
 *
 * `documentId` is the slug, which is the file name.
 *
 * Rewriting a YAML file keeps its data, but not its comments or style.
 */

import yaml from 'js-yaml';
import { IntiAdapter } from '@intijs/core/adapters';
import type {
    DraftableAdapter,
    DraftResult,
    EntrySummary,
    IntrospectionResult,
    ListableAdapter,
    PageSummary,
    SchemaDefinition,
    SearchableAdapter,
    WritableAdapter,
    WriteResult
} from '@intijs/core/adapters';
import { extractSeo } from '@intijs/core/seo';
import type { SeoFieldMap } from '@intijs/core/seo';
import type { IntiBlock, IntiNavigation, IntiPage } from '@intijs/core/types';

import { githubStorage, localStorage } from './storage.js';
import type { GitHubStorageConfig, KeystaticStorage } from './storage.js';

export { githubStorage, localStorage } from './storage.js';
export type { GitHubStorageConfig, KeystaticStorage } from './storage.js';

export interface KeystaticConfig {
    /** Default: local folder (`root`), or GitHub if `repo` and `token` are passed */
    storage?: KeystaticStorage;
    /** Shortcuts for the environment variables */
    root?: string;
    repo?: string;
    token?: string;
    branch?: string;
    /** The collection's `path` in `keystatic.config`. Default: `content/pages/*` */
    collection?: string;
    /** Default: `yaml`. It is the collection's `format.data` */
    format?: 'yaml' | 'json';
    /** `fields.blocks` field. Default: `blocks` */
    blocksField?: string;
    /** Field holding the title. Default: `title` */
    titleField?: string;
    /** Where to store drafts, outside the collection. Default: `.inti/drafts/pages/*` */
    draftsPath?: string;
    /** The entry's SEO fields. Default: metaTitle, metaDescription, ogImage */
    seo?: SeoFieldMap;
}

interface KeystaticBlock {
    discriminant: string;
    value: unknown;
}

type Entry = Record<string, any>;

const SOURCE = 'keystatic';
const DRAFT_PREFIX = 'draft:';

/** A slug is a file name: nothing that could leave the folder */
const VALID_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const isObject = (value: unknown): value is Record<string, any> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

/** Assigns by dot-path. Rejects the keys that would pollute Object.prototype */
function setByPath(target: Record<string, any>, path: string, value: unknown): void {
    const parts = path.split('.');
    if (parts.some((part) => part === '__proto__' || part === 'constructor' || part === 'prototype')) {
        throw new Error(`Invalid field path "${path}"`);
    }

    let cursor = target;
    for (const part of parts.slice(0, -1)) {
        if (cursor[part] === null || typeof cursor[part] !== 'object') cursor[part] = {};
        cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = value;
}

export class KeystaticAdapter
    extends IntiAdapter<Entry & { slug: string }>
    implements WritableAdapter, ListableAdapter, SearchableAdapter, DraftableAdapter
{
    readonly writable = true as const;

    private storage: KeystaticStorage;
    private collection: string;
    private format: 'yaml' | 'json';
    private blocksField: string;
    private titleField: string;
    private draftsPath: string;
    private seoMap: SeoFieldMap;
    /** Write queue: concurrent read-modify-writes would overwrite each other */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(config: KeystaticConfig = {}) {
        super('Keystatic', config);

        this.storage =
            config.storage ??
            (config.repo
                ? githubStorage({ repo: config.repo, token: config.token ?? '', branch: config.branch })
                : localStorage({ root: config.root }));
        this.collection = config.collection ?? 'content/pages/*';
        this.format = config.format ?? 'yaml';
        this.blocksField = config.blocksField ?? 'blocks';
        this.titleField = config.titleField ?? 'title';
        this.draftsPath = config.draftsPath ?? '.inti/drafts/pages/*';
        this.seoMap = config.seo ?? {
            title: 'metaTitle',
            description: 'metaDescription',
            image: 'ogImage'
        };

        if (!this.collection.includes('*')) {
            throw new Error('[KeystaticAdapter] `collection` needs a * for the slug, e.g. "content/pages/*"');
        }
    }

    // ============================================
    // Files
    // ============================================

    /** `content/pages/*` → `content/pages/home.yaml`; `content/pages/*\/` → `.../home/index.yaml` */
    private pathFor(pattern: string, slug: string): string {
        const extension = this.format === 'json' ? 'json' : 'yaml';
        const nested = pattern.endsWith('/');
        const base = pattern.replace('*', slug).replace(/\/$/, '');
        return nested ? `${base}/index.${extension}` : `${base}.${extension}`;
    }

    /** A document is a slug, or `draft:<slug>` for its working copy */
    private locate(documentId: string): { slug: string; path: string; isDraft: boolean } {
        const isDraft = documentId.startsWith(DRAFT_PREFIX);
        const slug = isDraft ? documentId.slice(DRAFT_PREFIX.length) : documentId;
        if (!VALID_SLUG.test(slug)) throw new Error(`Invalid document id "${documentId}"`);
        return { slug, isDraft, path: this.pathFor(isDraft ? this.draftsPath : this.collection, slug) };
    }

    private parse(text: string): Entry {
        const parsed = this.format === 'json' ? JSON.parse(text) : yaml.load(text, { schema: yaml.CORE_SCHEMA });
        return isObject(parsed) ? parsed : {};
    }

    private serialize(entry: Entry): string {
        return this.format === 'json'
            ? `${JSON.stringify(entry, null, 2)}\n`
            : yaml.dump(entry, { lineWidth: -1, noRefs: true, schema: yaml.CORE_SCHEMA });
    }

    private async readEntry(path: string): Promise<Entry | null> {
        const text = await this.storage.read(path);
        return text === null ? null : this.parse(text);
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation, operation);
        this.queue = result.catch(() => undefined);
        return result;
    }

    /** Every block write goes through here. Returns the result, without throwing */
    private mutate(documentId: string, message: string, apply: (blocks: KeystaticBlock[]) => void): Promise<WriteResult> {
        return this.enqueue(async () => {
            try {
                const { path } = this.locate(documentId);
                const entry = await this.readEntry(path);
                if (!entry) throw new Error(`Document "${documentId}" not found`);

                const blocks = Array.isArray(entry[this.blocksField]) ? [...entry[this.blocksField]] : [];
                apply(blocks);
                entry[this.blocksField] = blocks;

                await this.storage.write(path, this.serialize(entry), message);
                return { success: true, documentId, source: SOURCE };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[KeystaticAdapter] write failed:`, message);
                return { success: false, documentId, error: message, source: SOURCE };
            }
        });
    }

    private assertIndex(blocks: KeystaticBlock[], index: number): void {
        if (!Number.isInteger(index) || index < 0 || index >= blocks.length) {
            throw new Error(`Block index ${index} out of range`);
        }
    }

    // ============================================
    // Reading
    // ============================================

    parsePage(raw: Entry & { slug: string; documentId?: string }): IntiPage {
        const documentId = raw.documentId ?? raw.slug;
        const rows: KeystaticBlock[] = Array.isArray(raw[this.blocksField]) ? raw[this.blocksField] : [];

        const blocks: IntiBlock[] = rows.map((row, index) => ({
            id: `${documentId}-${index}`,
            type: row?.discriminant,
            // A block can be a single value (`fields.text`): it is exposed as `value`
            data: isObject(row?.value) ? row.value : { value: row?.value },
            meta: { documentId, contentType: 'page', label: row?.discriminant, index, total: rows.length }
        }));

        return {
            id: documentId,
            slug: raw.slug,
            title: typeof raw[this.titleField] === 'string' ? raw[this.titleField] : raw.slug,
            blocks,
            seo: extractSeo(raw, this.seoMap, SOURCE),
            meta: { contentType: 'page', documentId }
        };
    }

    parseNavigation(_raw: unknown): IntiNavigation {
        return { items: [] };
    }

    async fetchPageBySlug(slug: string): Promise<IntiPage> {
        const { path } = this.locate(slug);
        const entry = await this.readEntry(path);
        if (!entry) throw new Error(`Page not found for slug: ${slug}`);
        return this.parsePage({ ...entry, slug });
    }

    /** The collection's slugs: the files, or the folders if `path` ends in `/` */
    private async slugs(): Promise<string[]> {
        const [before] = this.collection.split('*');
        const nested = this.collection.endsWith('/');
        const extension = `.${this.format === 'json' ? 'json' : 'yaml'}`;
        const names = await this.storage.list(before.replace(/\/$/, ''));

        return names
            .filter((name) => (nested ? !name.includes('.') : name.endsWith(extension)))
            .map((name) => (nested ? name : name.slice(0, -extension.length)))
            .filter((slug) => VALID_SLUG.test(slug));
    }

    async listPages(): Promise<PageSummary[]> {
        const slugs = await this.slugs();
        const pages = await Promise.all(
            slugs.map(async (slug) => {
                const entry = await this.readEntry(this.pathFor(this.collection, slug));
                return { slug, title: typeof entry?.[this.titleField] === 'string' ? entry[this.titleField] : slug };
            })
        );
        return pages;
    }

    async searchEntries(_collection: string, query: string): Promise<EntrySummary[]> {
        const q = query.toLowerCase();
        return (await this.listPages())
            .filter((page) => !q || page.title?.toLowerCase().includes(q) || page.slug.includes(q))
            .slice(0, 10)
            .map((page) => ({ id: page.slug, title: page.title ?? page.slug, subtitle: page.slug }));
    }

    /** The block types in use. The source of truth is `keystatic.config` */
    async introspect(): Promise<SchemaDefinition> {
        const fields = new Map<string, Set<string>>();

        for (const slug of await this.slugs()) {
            const entry = await this.readEntry(this.pathFor(this.collection, slug));
            for (const row of (entry?.[this.blocksField] ?? []) as KeystaticBlock[]) {
                if (!row?.discriminant) continue;
                const known = fields.get(row.discriminant) ?? new Set<string>();
                if (isObject(row.value)) Object.keys(row.value).forEach((key) => known.add(key));
                fields.set(row.discriminant, known);
            }
        }

        return {
            source: 'keystatic',
            version: '1',
            collections: [...fields].map(([type, names]) => ({
                name: type,
                blockType: type,
                fields: [...names].map((name) => ({ name, type: 'json' as const }))
            }))
        };
    }

    // ============================================
    // Writing
    // ============================================

    updateBlockField(documentId: string, blockIndex: number, field: string, value: any): Promise<WriteResult> {
        return this.enqueue(async () => {
            try {
                const { path, slug } = this.locate(documentId);
                const entry = await this.readEntry(path);
                if (!entry) throw new Error(`Document "${documentId}" not found`);

                if (blockIndex === -1) {
                    setByPath(entry, field, value);
                } else {
                    const blocks: KeystaticBlock[] = Array.isArray(entry[this.blocksField]) ? entry[this.blocksField] : [];
                    this.assertIndex(blocks, blockIndex);
                    const row = blocks[blockIndex];

                    if (isObject(row.value)) setByPath(row.value, field, value);
                    else if (field === 'value') row.value = value;
                    else throw new Error(`Block ${blockIndex} holds a single value: edit "value", not "${field}"`);
                }

                await this.storage.write(path, this.serialize(entry), `Inti: edit ${field} on ${slug}`);
                return { success: true, documentId, value, source: SOURCE };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[KeystaticAdapter] updateBlockField failed:`, message);
                return { success: false, documentId, error: message, source: SOURCE };
            }
        });
    }

    updateBlock(documentId: string, blockIndex: number, data: Record<string, any>): Promise<WriteResult> {
        return this.mutate(documentId, `Inti: update block on ${documentId}`, (blocks) => {
            this.assertIndex(blocks, blockIndex);
            blocks[blockIndex] = { ...blocks[blockIndex], value: data };
        });
    }

    moveBlock(documentId: string, fromIndex: number, toIndex: number): Promise<WriteResult> {
        return this.mutate(documentId, `Inti: move block on ${documentId}`, (blocks) => {
            this.assertIndex(blocks, fromIndex);
            this.assertIndex(blocks, toIndex);
            const [moved] = blocks.splice(fromIndex, 1);
            blocks.splice(toIndex, 0, moved);
        });
    }

    insertBlock(documentId: string, index: number, nativeType: string, data: Record<string, any> = {}): Promise<WriteResult> {
        return this.insertBlocks(documentId, index, [{ nativeType, data }]);
    }

    /** A single file: all go in or none do, and on GitHub it is a single commit */
    insertBlocks(
        documentId: string,
        index: number,
        newBlocks: Array<{ nativeType: string; data?: Record<string, any> }>
    ): Promise<WriteResult> {
        return this.mutate(documentId, `Inti: add ${newBlocks.length} block(s) on ${documentId}`, (blocks) => {
            const at = Math.max(0, Math.min(index, blocks.length));
            blocks.splice(at, 0, ...newBlocks.map((block) => ({ discriminant: block.nativeType, value: block.data ?? {} })));
        });
    }

    removeBlock(documentId: string, index: number): Promise<WriteResult> {
        return this.mutate(documentId, `Inti: remove block on ${documentId}`, (blocks) => {
            this.assertIndex(blocks, index);
            blocks.splice(index, 1);
        });
    }

    duplicateBlock(documentId: string, index: number): Promise<WriteResult> {
        return this.mutate(documentId, `Inti: duplicate block on ${documentId}`, (blocks) => {
            this.assertIndex(blocks, index);
            blocks.splice(index + 1, 0, JSON.parse(JSON.stringify(blocks[index])));
        });
    }

    // ============================================
    // Drafts
    // ============================================
    //
    // A copy outside the collection, so that the Keystatic admin and the reader do not
    // take it for a page. Publishing it is a single file change in the collection.

    async fetchDraftBySlug(slug: string): Promise<IntiPage | null> {
        const documentId = `${DRAFT_PREFIX}${slug}`;
        const entry = await this.readEntry(this.locate(documentId).path);
        return entry ? this.parsePage({ ...entry, slug, documentId }) : null;
    }

    createDraft(documentId: string): Promise<DraftResult> {
        return this.enqueue(async () => {
            try {
                const { path, slug } = this.locate(documentId);
                const draftId = `${DRAFT_PREFIX}${slug}`;
                const draftPath = this.locate(draftId).path;

                // One already existed: keep working on it instead of overwriting what it holds
                if ((await this.storage.read(draftPath)) === null) {
                    const text = await this.storage.read(path);
                    if (text === null) throw new Error(`Document "${documentId}" not found`);
                    await this.storage.write(draftPath, text, `Inti: start draft of ${slug}`);
                }
                return { success: true, documentId: draftId, slug, source: SOURCE };
            } catch (error) {
                return { success: false, documentId, error: error instanceof Error ? error.message : String(error), source: SOURCE };
            }
        });
    }

    publishDraft(draftId: string): Promise<DraftResult> {
        return this.enqueue(async () => {
            try {
                const { path, slug, isDraft } = this.locate(draftId);
                if (!isDraft) throw new Error(`"${draftId}" is not a draft`);

                const text = await this.storage.read(path);
                if (text === null) throw new Error(`Draft "${draftId}" not found`);

                await this.storage.write(this.pathFor(this.collection, slug), text, `Inti: publish ${slug}`);
                await this.storage.remove(path, `Inti: remove draft of ${slug}`);
                return { success: true, documentId: slug, slug, source: SOURCE };
            } catch (error) {
                return { success: false, documentId: draftId, error: error instanceof Error ? error.message : String(error), source: SOURCE };
            }
        });
    }

    discardDraft(draftId: string): Promise<DraftResult> {
        return this.enqueue(async () => {
            try {
                const { path, slug, isDraft } = this.locate(draftId);
                if (!isDraft) throw new Error(`"${draftId}" is not a draft`);

                await this.storage.remove(path, `Inti: discard draft of ${slug}`);
                return { success: true, documentId: slug, slug, source: SOURCE };
            } catch (error) {
                return { success: false, documentId: draftId, error: error instanceof Error ? error.message : String(error), source: SOURCE };
            }
        });
    }
}

export default KeystaticAdapter;

export type { IntrospectionResult };
