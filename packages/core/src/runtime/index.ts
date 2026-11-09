import type { IntiSchema } from '../types/index.js';

/**
 * In-memory cache backed by runtime.
 * Retains mapped nodes during lifecycle for SSR/SSG.
 */
export class IntiStore {
    private cache = new Map<string, IntiSchema<any>>();

    public ingest(nodes: IntiSchema<any>[]) {
        for (const node of nodes) {
            const key = `${node.type}:${node.id}`;
            this.cache.set(key, node);
        }
    }

    public getCollection<T>(type: string): IntiSchema<T>[] {
        const results: IntiSchema<T>[] = [];
        for (const [key, node] of this.cache.entries()) {
            if (node.type === type) {
                results.push(node);
            }
        }
        return results;
    }

    public getNode<T>(type: string, id: string): IntiSchema<T> | undefined {
        return this.cache.get(`${type}:${id}`);
    }

    public flush() {
        this.cache.clear();
    }

    public get size(): number {
        return this.cache.size;
    }
}

export const globalStore = new IntiStore();
