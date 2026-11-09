import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { StrapiAdapter } from '../src/index.js';

// ============================================
// Fixtures: Strapi v4 entry with a dynamic zone
// ============================================

const strapiEntry = {
    data: {
        id: 42,
        attributes: {
            title: 'Home',
            slug: 'home',
            blocks: [
                {
                    id: 7,
                    __component: 'sections.hero',
                    heading: 'Welcome',
                    cta: { label: 'Get started', url: '/start' },
                    // Populated media relation (shape {data:...}) — must be omitted from the PUT
                    image: { data: { id: 1, attributes: { url: '/img.jpg' } } }
                },
                {
                    id: 8,
                    __component: 'sections.text',
                    body: 'Sample text'
                }
            ]
        }
    }
};

let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let originalFetch: typeof fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: any }) {
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });
        const result = handler(url, init);
        return new Response(JSON.stringify(result.body ?? {}), {
            status: result.status ?? 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }) as typeof fetch;
}

beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

// ============================================
// Tests
// ============================================

describe('StrapiAdapter.updateBlockField', () => {
    const adapter = new StrapiAdapter({
        endpoint: 'https://strapi.test.com',
        apiToken: 'test-token',
        contentType: 'pages',
        blocksField: 'blocks'
    });

    test('patches the field and sends the whole dynamic zone via PUT', async () => {
        let put: any = null;

        mockFetch((url, init) => {
            if (init?.method === 'PUT') {
                put = JSON.parse(String(init.body));
                return { body: { data: { id: 42 } } };
            }
            return { body: strapiEntry };
        });

        const result = await adapter.updateBlockField('42', 0, 'heading', 'Hello Strapi');

        expect(result.success).toBe(true);
        expect(result.source).toBe('strapi');

        expect(put.data.blocks).toHaveLength(2);
        expect(put.data.blocks[0].heading).toBe('Hello Strapi');
        // id and __component preserved → Strapi updates in place
        expect(put.data.blocks[0].id).toBe(7);
        expect(put.data.blocks[0].__component).toBe('sections.hero');
        expect(put.data.blocks[1].body).toBe('Sample text');
    });

    test('omits populated relations/media so validation does not break', async () => {
        let put: any = null;

        mockFetch((url, init) => {
            if (init?.method === 'PUT') {
                put = JSON.parse(String(init.body));
                return { body: { data: { id: 42 } } };
            }
            return { body: strapiEntry };
        });

        await adapter.updateBlockField('42', 0, 'heading', 'x');

        // Populated media {data:...} is not sent; Strapi preserves it by id
        expect(put.data.blocks[0].image).toBeUndefined();
    });

    test('supports dot-paths for nested component fields', async () => {
        let put: any = null;

        mockFetch((url, init) => {
            if (init?.method === 'PUT') {
                put = JSON.parse(String(init.body));
                return { body: { data: { id: 42 } } };
            }
            return { body: strapiEntry };
        });

        const result = await adapter.updateBlockField('42', 0, 'cta.label', 'Buy now');

        expect(result.success).toBe(true);
        expect(put.data.blocks[0].cta.label).toBe('Buy now');
        expect(put.data.blocks[0].cta.url).toBe('/start');
    });

    test('blockIndex -1 does a partial PUT of a top-level field without a round-trip', async () => {
        let put: any = null;

        mockFetch((url, init) => {
            if (init?.method === 'PUT') {
                put = JSON.parse(String(init.body));
                return { body: { data: { id: 42 } } };
            }
            return { body: strapiEntry };
        });

        const result = await adapter.updateBlockField('42', -1, 'title', 'New title');

        expect(result.success).toBe(true);
        expect(put.data.title).toBe('New title');
        // No prior GET: only one call (the PUT)
        expect(fetchCalls).toHaveLength(1);
    });

    test('a v5 entry (flat structure, no attributes) also works', async () => {
        const v5Entry = {
            data: {
                id: 42,
                documentId: 'abc123',
                title: 'Home',
                blocks: [{ id: 7, __component: 'sections.hero', heading: 'Welcome' }]
            }
        };
        let put: any = null;

        mockFetch((url, init) => {
            if (init?.method === 'PUT') {
                put = JSON.parse(String(init.body));
                return { body: { data: { id: 42 } } };
            }
            return { body: v5Entry };
        });

        const result = await adapter.updateBlockField('42', 0, 'heading', 'Hello v5');

        expect(result.success).toBe(true);
        expect(put.data.blocks[0].heading).toBe('Hello v5');
    });

    test('without apiToken returns a clear error', async () => {
        const noAuth = new StrapiAdapter({ endpoint: 'https://strapi.test.com' });
        const result = await noAuth.updateBlockField('42', 0, 'heading', 'x');

        expect(result.success).toBe(false);
        expect(result.error).toContain('API Token');
    });

    test('an out-of-range index fails without throwing', async () => {
        mockFetch(() => ({ body: strapiEntry }));

        const result = await adapter.updateBlockField('42', 99, 'heading', 'x');

        expect(result.success).toBe(false);
        expect(result.error).toContain('out of range');
    });

    test('a Strapi rejection is reported as a failure', async () => {
        mockFetch((url, init) => {
            if (init?.method === 'PUT') return { status: 400, body: { error: 'ValidationError' } };
            return { body: strapiEntry };
        });

        const result = await adapter.updateBlockField('42', 0, 'heading', 'x');

        expect(result.success).toBe(false);
        expect(result.error).toContain('400');
    });

    test('moveBlock reorders the dynamic zone preserving ids and components', async () => {
        let put: any = null;

        mockFetch((url, init) => {
            if (init?.method === 'PUT') {
                put = JSON.parse(String(init.body));
                return { body: { data: { id: 42 } } };
            }
            return { body: strapiEntry };
        });

        const result = await adapter.moveBlock('42', 0, 1);

        expect(result.success).toBe(true);
        expect(put.data.blocks[0].__component).toBe('sections.text');
        expect(put.data.blocks[0].id).toBe(8);
        expect(put.data.blocks[1].__component).toBe('sections.hero');
        expect(put.data.blocks[1].id).toBe(7);
        // Sanitization still applies (populated media omitted)
        expect(put.data.blocks[1].image).toBeUndefined();
    });

    test('moveBlock with out-of-range indexes fails without throwing', async () => {
        mockFetch(() => ({ body: strapiEntry }));

        const result = await adapter.moveBlock('42', 5, 0);

        expect(result.success).toBe(false);
        expect(result.error).toContain('out of range');
    });

    test('insertBlock adds a new component without an id (Strapi creates it)', async () => {
        let put: any = null;

        mockFetch((url, init) => {
            if (init?.method === 'PUT') {
                put = JSON.parse(String(init.body));
                return { body: { data: { id: 42 } } };
            }
            return { body: strapiEntry };
        });

        const result = await adapter.insertBlock('42', 1, 'sections.cta', { label: 'Buy' });

        expect(result.success).toBe(true);
        expect(put.data.blocks).toHaveLength(3);
        expect(put.data.blocks[1]).toEqual({ __component: 'sections.cta', label: 'Buy' });
        expect(put.data.blocks[1].id).toBeUndefined();
    });

    test('removeBlock removes the component at the given position', async () => {
        let put: any = null;

        mockFetch((url, init) => {
            if (init?.method === 'PUT') {
                put = JSON.parse(String(init.body));
                return { body: { data: { id: 42 } } };
            }
            return { body: strapiEntry };
        });

        const result = await adapter.removeBlock('42', 0);

        expect(result.success).toBe(true);
        expect(put.data.blocks).toHaveLength(1);
        expect(put.data.blocks[0].__component).toBe('sections.text');
    });

    test('duplicateBlock clones without an id so Strapi creates a real copy', async () => {
        let put: any = null;

        mockFetch((url, init) => {
            if (init?.method === 'PUT') {
                put = JSON.parse(String(init.body));
                return { body: { data: { id: 42 } } };
            }
            return { body: strapiEntry };
        });

        const result = await adapter.duplicateBlock('42', 0);

        expect(result.success).toBe(true);
        expect(put.data.blocks).toHaveLength(3);
        // The original keeps its id; the copy has NO id
        expect(put.data.blocks[0].id).toBe(7);
        expect(put.data.blocks[1].id).toBeUndefined();
        expect(put.data.blocks[1].__component).toBe('sections.hero');
        expect(put.data.blocks[1].heading).toBe('Welcome');
    });

    test('the PUT carries the Bearer token', async () => {
        mockFetch((url, init) => {
            if (init?.method === 'PUT') return { body: { data: { id: 42 } } };
            return { body: strapiEntry };
        });

        await adapter.updateBlockField('42', 0, 'heading', 'x');

        const put = fetchCalls.find(c => c.init?.method === 'PUT');
        expect((put?.init?.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');
    });
});
