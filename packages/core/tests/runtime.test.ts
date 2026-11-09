import { describe, it, expect, beforeEach } from 'bun:test';
import { IntiStore, globalStore } from '../src/runtime/index.js';
import type { IntiSchema } from '../src/types/index.js';

describe('IntiStore (Runtime)', () => {
    let store: IntiStore;

    beforeEach(() => {
        store = new IntiStore();
    });

    describe('ingest', () => {
        it('should ingest nodes into the store', () => {
            const nodes: IntiSchema[] = [
                { id: '1', type: 'article', slug: 'article-1', data: { title: 'Article 1' } },
                { id: '2', type: 'article', slug: 'article-2', data: { title: 'Article 2' } }
            ];

            store.ingest(nodes);

            expect(store.size).toBe(2);
        });

        it('should overwrite nodes with same key', () => {
            const nodes1: IntiSchema[] = [
                { id: '1', type: 'article', slug: 'article-1', data: { title: 'Original' } }
            ];
            const nodes2: IntiSchema[] = [
                { id: '1', type: 'article', slug: 'article-1', data: { title: 'Updated' } }
            ];

            store.ingest(nodes1);
            store.ingest(nodes2);

            expect(store.size).toBe(1);
            const node = store.getNode('article', '1');
            expect(node?.data.title).toBe('Updated');
        });

        it('should handle empty array', () => {
            store.ingest([]);
            expect(store.size).toBe(0);
        });
    });

    describe('getCollection', () => {
        it('should return all nodes of a type', () => {
            const nodes: IntiSchema[] = [
                { id: '1', type: 'article', slug: 'article-1', data: {} },
                { id: '2', type: 'article', slug: 'article-2', data: {} },
                { id: '3', type: 'page', slug: 'page-1', data: {} }
            ];

            store.ingest(nodes);

            const articles = store.getCollection('article');
            expect(articles).toHaveLength(2);
        });

        it('should return typed data', () => {
            interface ArticleData {
                title: string;
            }

            const nodes: IntiSchema<ArticleData>[] = [
                { id: '1', type: 'article', slug: 'article-1', data: { title: 'Test' } }
            ];

            store.ingest(nodes);

            const articles = store.getCollection<ArticleData>('article');
            expect(articles[0].data.title).toBe('Test');
        });

        it('should return empty array for non-existent type', () => {
            const result = store.getCollection('nonexistent');
            expect(result).toBeArray();
            expect(result).toHaveLength(0);
        });
    });

    describe('getNode', () => {
        it('should return specific node by type and id', () => {
            const nodes: IntiSchema[] = [
                { id: '1', type: 'article', slug: 'article-1', data: { title: 'Article 1' } }
            ];

            store.ingest(nodes);

            const node = store.getNode('article', '1');
            expect(node).toBeDefined();
            expect(node?.data.title).toBe('Article 1');
        });

        it('should return undefined for non-existent node', () => {
            const node = store.getNode('article', '999');
            expect(node).toBeUndefined();
        });
    });

    describe('flush', () => {
        it('should clear all nodes', () => {
            const nodes: IntiSchema[] = [
                { id: '1', type: 'article', slug: 'article-1', data: {} },
                { id: '2', type: 'article', slug: 'article-2', data: {} }
            ];

            store.ingest(nodes);
            expect(store.size).toBe(2);

            store.flush();
            expect(store.size).toBe(0);
        });
    });

    describe('globalStore', () => {
        it('should be a singleton instance', () => {
            expect(globalStore).toBeInstanceOf(IntiStore);
        });

        it('should persist data across imports', () => {
            globalStore.ingest([{ id: 'global-1', type: 'test', slug: 'test', data: {} }]);
            expect(globalStore.size).toBeGreaterThan(0);
            
            // Clean up
            globalStore.flush();
        });
    });
});
