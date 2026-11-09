import { describe, test, expect } from 'bun:test';
import { KitsudenAdapter, toGeneratorBlockTypes } from '../src/index.js';
import type { KitsudenBlockType } from '../src/index.js';

// ============================================
// Fixtures
// ============================================

function adapter() {
    return new KitsudenAdapter({ endpoint: 'https://cms.example.com' });
}

/** Rows returned UNSORTED on purpose: the API does not guarantee order */
const UNSORTED_PAGE = {
    id: 'p1',
    title: 'Home',
    slug: 'home',
    status: 'published' as const,
    updatedAt: '2026-09-01T10:00:00.000Z',
    blocks: [
        { id: 'c', type: 'footer', sortOrder: 30, content: { t: 'bottom' } },
        { id: 'a', type: 'hero', sortOrder: 10, content: { t: 'cover' } },
        { id: 'b', type: 'richtext', sortOrder: 20, content: { t: 'middle' } }
    ]
};

// ============================================
// Order
// ============================================

describe('parsePage — order by sortOrder', () => {
    test('sorts rows even if the API returns them out of order', () => {
        // Order is a property of the row, not its array position:
        // `moveBlock` writes `sortOrder` and the API does not guarantee order.
        const page = adapter().parsePage(UNSORTED_PAGE as any);
        expect(page.blocks.map((b) => b.type)).toEqual(['hero', 'richtext', 'footer']);
    });

    test('meta.index reflects the already-sorted position', () => {
        const page = adapter().parsePage(UNSORTED_PAGE as any);
        expect(page.blocks.map((b) => b.meta?.index)).toEqual([0, 1, 2]);
        expect(page.blocks.map((b) => b.id)).toEqual(['a', 'b', 'c']);
    });

    test('two rows with the same sortOrder keep their arrival order', () => {
        const page = adapter().parsePage({
            ...UNSORTED_PAGE,
            blocks: [
                { id: 'x', type: 'one', sortOrder: 5, content: {} },
                { id: 'y', type: 'two', sortOrder: 5, content: {} }
            ]
        } as any);
        expect(page.blocks.map((b) => b.id)).toEqual(['x', 'y']);
    });

    test('a row without sortOrder does not break ordering', () => {
        const page = adapter().parsePage({
            ...UNSORTED_PAGE,
            blocks: [
                { id: 'later', type: 'b', sortOrder: 10, content: {} },
                { id: 'missing', type: 'a', content: {} }
            ]
        } as any);
        expect(page.blocks.map((b) => b.id)).toEqual(['missing', 'later']);
    });
});

// ============================================
// Visibility
// ============================================

describe('parsePage — visibility', () => {
    test('propagates isVisible, visibleFrom and visibleUntil to meta', () => {
        const page = adapter().parsePage({
            ...UNSORTED_PAGE,
            blocks: [
                {
                    id: 'promo',
                    type: 'promo',
                    sortOrder: 0,
                    content: {},
                    isVisible: true,
                    visibleFrom: '2026-12-01T00:00:00.000Z',
                    visibleUntil: '2026-12-31T00:00:00.000Z'
                }
            ]
        } as any);

        expect(page.blocks[0].meta?.visible).toBe(true);
        expect(page.blocks[0].meta?.visibleFrom).toBe('2026-12-01T00:00:00.000Z');
        expect(page.blocks[0].meta?.visibleUntil).toBe('2026-12-31T00:00:00.000Z');
    });

    test('isVisible: false arrives as visible: false', () => {
        const page = adapter().parsePage({
            ...UNSORTED_PAGE,
            blocks: [{ id: 'x', type: 'promo', sortOrder: 0, content: {}, isVisible: false }]
        } as any);
        expect(page.blocks[0].meta?.visible).toBe(false);
    });

    test('a row without isVisible is treated as visible', () => {
        // The field is optional in the API; its absence must not hide anything.
        const page = adapter().parsePage(UNSORTED_PAGE as any);
        expect(page.blocks.every((b) => b.meta?.visible === true)).toBe(true);
    });

    test('null dates do not arrive as null', () => {
        // `null` is not an ISO date and consumers expect undefined.
        const page = adapter().parsePage({
            ...UNSORTED_PAGE,
            blocks: [
                { id: 'x', type: 'a', sortOrder: 0, content: {}, visibleFrom: null, visibleUntil: null }
            ]
        } as any);
        expect(page.blocks[0].meta?.visibleFrom).toBeUndefined();
        expect(page.blocks[0].meta?.visibleUntil).toBeUndefined();
    });
});

describe('parsePage — label', () => {
    test('is the native type even if the row has a display name', () => {
        // The composer offers the blocks it sees on the page as insertable
        // using `label` as the native type. With the display name ("Cover")
        // it asked to insert a type that Kitsuden's palette does not know.
        const page = adapter().parsePage({
            ...UNSORTED_PAGE,
            blocks: [{ id: 'x', type: 'hero', name: 'Cover', sortOrder: 0, content: {} }]
        } as any);
        expect(page.blocks[0].meta?.label).toBe('hero');
    });
});

// ============================================
// Palette → AI vocabulary
// ============================================

const PALETTE: KitsudenBlockType[] = [
    {
        type: 'hero',
        name: 'Cover',
        category: 'headers',
        description: 'Header with headline and button',
        schema: {
            headline: { type: 'string', required: true, description: 'Main headline' },
            body: { type: 'richtext' },
            columns: { type: 'number' },
            dark: { type: 'boolean' },
            align: { type: 'enum', options: ['left', 'center', 'right'] },
            background: { type: 'media' },
            relatedPage: { type: 'relation' },
            publishAt: { type: 'datetime' },
            raw: { type: 'object' }
        }
    },
    { type: 'spacer', name: 'Spacer' }
];

describe('toGeneratorBlockTypes', () => {
    const [hero, spacer] = toGeneratorBlockTypes(PALETTE);

    test('preserves type, label and description', () => {
        expect(hero.nativeType).toBe('hero');
        expect(hero.label).toBe('Cover');
        expect(hero.description).toBe('Header with headline and button');
    });

    test('translates the types a model can fill in', () => {
        expect(hero.fields?.headline).toEqual({ type: 'string', description: 'Main headline' });
        expect(hero.fields?.body).toEqual({ type: 'richtext' });
        expect(hero.fields?.columns).toEqual({ type: 'number' });
        expect(hero.fields?.dark).toEqual({ type: 'boolean' });
    });

    test('drops media and relation', () => {
        // A made-up id points to nothing: it is the exact broken reference
        // that the closed schema exists to prevent.
        expect(hero.fields?.background).toBeUndefined();
        expect(hero.fields?.relatedPage).toBeUndefined();
    });

    test('drops dates and structures', () => {
        // A date is an editorial decision and its format matters; object/array
        // without properties cannot be represented in a flat field schema.
        expect(hero.fields?.publishAt).toBeUndefined();
        expect(hero.fields?.raw).toBeUndefined();
    });

    test('an enum with options becomes a closed variant', () => {
        expect(hero.fields?.align).toEqual({ type: 'string' });
        expect(hero.variants?.align).toEqual(['left', 'center', 'right']);
    });

    test('a type without a schema declares neither fields nor variants', () => {
        expect(spacer.nativeType).toBe('spacer');
        expect(spacer.fields).toBeUndefined();
        expect(spacer.variants).toBeUndefined();
    });

    test('an enum without options does not generate an empty variant', () => {
        const [single] = toGeneratorBlockTypes([
            { type: 'x', name: 'X', schema: { k: { type: 'enum' } } }
        ]);
        expect(single.fields?.k).toEqual({ type: 'string' });
        expect(single.variants).toBeUndefined();
    });

    test('an empty palette returns an empty list', () => {
        expect(toGeneratorBlockTypes([])).toEqual([]);
    });
});

describe('toGeneratorBlockTypes: rich fields', () => {
    const TYPES = [
        {
            type: 'hero',
            schema: {
                mediaId: { type: 'string', description: 'Background image' },
                ogImageId: { type: 'string' },
                background: { type: 'media' },
                author: { type: 'relation' },
                ctaUrl: { type: 'string' },
                body: { type: 'richtext' },
                ratio: { type: 'number', min: 0, max: 1 },
                focal: { type: 'object', properties: { x: { type: 'number' }, mediaId: { type: 'string' } } },
                items: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' } } } },
                mediaOnly: { type: 'object', properties: { imageId: { type: 'string' } } },
                published: { type: 'date' }
            }
        }
    ] as any;

    test('without a source, a model cannot invent a media or relation id', () => {
        const [{ fields }] = toGeneratorBlockTypes(TYPES);
        for (const field of ['mediaId', 'ogImageId', 'background', 'author', 'mediaOnly']) {
            expect(fields?.[field]).toBeUndefined();
        }
        expect((fields?.focal as any).fields.mediaId).toBeUndefined();
    });

    test('with a source they are references, including inside an object', () => {
        const [{ fields }] = toGeneratorBlockTypes(TYPES, { mediaSource: 'media', relationSources: { author: 'authors' } });
        expect(fields?.mediaId).toEqual({ type: 'media', source: 'media', description: 'Background image' });
        expect(fields?.background).toEqual({ type: 'media', source: 'media' });
        expect(fields?.author).toEqual({ type: 'relation', source: 'authors' });
        expect((fields?.focal as any).fields.mediaId).toEqual({ type: 'media', source: 'media' });
    });

    test('a link is declared as url, so its scheme is validated', () => {
        expect(toGeneratorBlockTypes(TYPES)[0].fields?.ctaUrl).toEqual({ type: 'url' });
    });

    test('preserves rich text, limits, objects and lists', () => {
        const [{ fields }] = toGeneratorBlockTypes(TYPES);
        expect(fields?.body).toEqual({ type: 'richtext' });
        expect(fields?.ratio).toEqual({ type: 'number', min: 0, max: 1 });
        expect(fields?.items).toEqual({ type: 'list', of: { type: 'object', fields: { title: { type: 'string' } } } });
    });

    test('a date remains an editorial decision', () => {
        expect(toGeneratorBlockTypes(TYPES)[0].fields?.published).toBeUndefined();
    });

    test('its output is accepted by @intijs/genui, and a made-up id does not pass', async () => {
        const { validateGenerated, buildBlockSchema } = await import('../../genui/src/index.js');
        const vocabulary = toGeneratorBlockTypes(TYPES, { mediaSource: 'media', relationSources: { author: 'authors' } }) as any;
        const candidates = { media: [{ id: 'm1', summary: 'Photo' }], authors: [] };

        expect(JSON.stringify(buildBlockSchema(vocabulary, candidates))).toContain('"enum":["m1"]');

        const result = validateGenerated(
            { blocks: [{ nativeType: 'hero', data: { mediaId: 'made-up', background: 'm1', ctaUrl: 'javascript:alert(1)' } }] },
            vocabulary,
            { candidates }
        );
        expect(result.blocks[0].data).toEqual({ background: 'm1' });
        expect(result.warnings.length).toBe(2);
    });
});
