import { describe, test, expect } from 'bun:test';

import { normalizeAcfForWrite, normalizeForWrite } from '../src/acf-write.js';
import type { RestSchema } from '../src/acf-write.js';

/** The shape WordPress publishes for a Flexible Content (`OPTIONS` on the post) */
const SCHEMA: RestSchema = {
    type: 'object',
    properties: {
        content_blocks: {
            type: ['array', 'null'],
            items: {
                oneOf: [
                    {
                        type: 'object',
                        properties: {
                            acf_fc_layout: { type: 'string', pattern: '^hero_banner$' },
                            heading: { type: ['string', 'null'] },
                            image: { type: ['integer', 'null'] },
                            gallery: { type: ['array', 'null'], items: { type: 'number' } },
                            related: { type: ['integer', 'array', 'null'], items: { type: 'integer' }, minItems: 1 },
                            link: { type: ['object', 'null'], properties: { url: { type: 'string' } } },
                            enabled: { type: ['boolean', 'null'] }
                        }
                    },
                    {
                        type: 'object',
                        properties: {
                            acf_fc_layout: { type: 'string', pattern: '^cards$' },
                            items: {
                                type: ['array', 'null'],
                                items: {
                                    type: 'object',
                                    properties: {
                                        id: { type: ['string', 'null'] },
                                        url: { type: ['string', 'null'] },
                                        photo: { type: ['integer', 'null'] }
                                    }
                                }
                            }
                        }
                    }
                ]
            }
        }
    }
};

const image = { ID: 14, id: 14, url: 'http://x/a.png', alt: '', sizes: {} };
const post = { ID: 7, post_title: 'Otra', post_type: 'page' };

describe('normalizeAcfForWrite', () => {
    test('an image, a gallery and a relation become ids again', () => {
        const out = normalizeAcfForWrite(
            {
                content_blocks: [{ acf_fc_layout: 'hero_banner', heading: 'H', image, gallery: [image], related: [post] }]
            },
            SCHEMA
        );
        expect(out.content_blocks[0]).toEqual({ acf_fc_layout: 'hero_banner', heading: 'H', image: 14, gallery: [14], related: [7] });
    });

    test('an empty field read as false becomes null, except booleans', () => {
        const [block] = normalizeAcfForWrite(
            { content_blocks: [{ acf_fc_layout: 'hero_banner', image: false, gallery: false, enabled: false }] },
            SCHEMA
        ).content_blocks;
        expect(block.image).toBeNull();
        expect(block.gallery).toBeNull();
        expect(block.enabled).toBe(false);
    });

    test('a link stays an object: the schema decides its shape', () => {
        const link = { title: 'Ir', url: 'https://x.com', target: '' };
        const [block] = normalizeAcfForWrite({ content_blocks: [{ acf_fc_layout: 'hero_banner', link }] }, SCHEMA).content_blocks;
        expect(block.link).toEqual(link);
    });

    test('a row with id and url fields is not mistaken for an image', () => {
        const row = { id: 'abc', url: 'https://x.com', photo: image };
        const [block] = normalizeAcfForWrite({ content_blocks: [{ acf_fc_layout: 'cards', items: [row] }] }, SCHEMA).content_blocks;
        expect(block.items[0]).toEqual({ id: 'abc', url: 'https://x.com', photo: 14 });
    });

    test('an empty relation is sent as null: the schema does not allow an empty list', () => {
        const [block] = normalizeAcfForWrite({ content_blocks: [{ acf_fc_layout: 'hero_banner', related: [] }] }, SCHEMA).content_blocks;
        expect(block.related).toBeNull();
    });

    test('what the schema does not declare is not resent', () => {
        const out = normalizeAcfForWrite({ content_blocks: [], content_blocks_source: { label: 'x' } }, SCHEMA);
        expect(Object.keys(out)).toEqual(['content_blocks']);
    });

    test('without a schema it is sent as is', () => {
        const acf = { content_blocks: [{ image }] };
        expect(normalizeAcfForWrite(acf, undefined)).toBe(acf);
    });

    test('an unknown layout is left untouched', () => {
        const row = { acf_fc_layout: 'new_layout', image };
        expect(normalizeAcfForWrite({ content_blocks: [row] }, SCHEMA).content_blocks[0]).toEqual(row);
    });

    test('an id that is already correct does not change', () => {
        expect(normalizeForWrite(14, { type: ['integer', 'null'] })).toBe(14);
    });
});
