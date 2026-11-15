import { describe, expect, test } from 'bun:test';
import {
    FORMATS,
    contentBox,
    formatValue,
    infographicVocabulary,
    normalizeInfographic,
    parseDelimited,
    parseNumber,
    planInfographic,
    renderInfographic,
    renderInfographicHtml
} from '../src/index.js';
import { createInfographicRoute } from '../src/route.js';
import { dashboard, fonts } from './fixtures.js';

/** Width and height from a PNG's IHDR, or a JPEG's SOF0 */
function size(bytes: Uint8Array): { type: string; width: number; height: number } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return { type: 'png', width: view.getUint32(16), height: view.getUint32(20) };
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;
        while (offset < bytes.length) {
            const marker = bytes[offset + 1];
            const length = view.getUint16(offset + 2);
            if (marker >= 0xc0 && marker <= 0xc2) return { type: 'jpeg', height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
            offset += 2 + length;
        }
    }
    return { type: 'unknown', width: 0, height: 0 };
}

const small = {
    title: 'Sales by channel',
    source: 'CRM',
    locale: 'en',
    sections: [{ kind: 'bar', title: 'Channels', items: [{ label: 'Web', value: 120 }, { label: 'Store', value: 80 }] }]
};

describe('numbers from a CMS', () => {
    test('reads the separators people actually type', () => {
        expect(parseNumber('1.234,5')).toBe(1234.5);
        expect(parseNumber('1,234.5')).toBe(1234.5);
        expect(parseNumber('1.234.567')).toBe(1234567);
        expect(parseNumber('1,234')).toBe(1234);
        expect(parseNumber('12,5')).toBe(12.5);
        expect(parseNumber('0.75')).toBe(0.75);
        expect(parseNumber('45 %')).toBe(45);
        expect(parseNumber('$ 1 200')).toBe(1200);
        expect(parseNumber('-3,2')).toBe(-3.2);
        expect(parseNumber(7)).toBe(7);
    });

    test('anything that is not a number is missing, never zero', () => {
        expect(parseNumber('N/A')).toBeNull();
        expect(parseNumber('')).toBeNull();
        expect(parseNumber(undefined)).toBeNull();
        expect(parseNumber(Number.NaN)).toBeNull();
        expect(formatValue(null, { format: 'number' }, 'es')).toBe('–');
    });

    test('formats in the reader’s locale; percent takes 45 for 45 %', () => {
        expect(formatValue(45, { format: 'percent' }, 'es')).toMatch(/^45\s?%$/);
        expect(formatValue(1_284_500, { format: 'currency', currency: 'EUR' }, 'es')).toMatch(/1,3\s?M\s?€/);
        expect(formatValue(98_000, { format: 'currency', currency: 'EUR' }, 'es')).not.toContain(',00');
        expect(formatValue(98_000, { format: 'currency', currency: 'EUR', compact: true }, 'es')).toMatch(/98\s?mil\s?€/);
    });

    test('a pasted table: tab, semicolon or comma, quotes respected', () => {
        expect(parseDelimited('a;b\n1;"2;3"')).toEqual([['a', 'b'], ['1', '2;3']]);
        expect(parseDelimited('x\t1,5\ny\t2')).toEqual([['x', '1,5'], ['y', '2']]);
    });
});

describe('normalizing a block', () => {
    test('a table with a header becomes series for a line chart', () => {
        const { infographic } = normalizeInfographic({ sections: [{ kind: 'line', data: 'Month;A;B\nJan;1;2\nFeb;3;' }] });
        const line = infographic.sections[0];
        expect(line.kind).toBe('line');
        if (line.kind !== 'line') return;
        expect(line.labels).toEqual(['Jan', 'Feb']);
        expect(line.series.map((s) => s.name)).toEqual(['A', 'B']);
        // An empty cell breaks the line; it is not drawn at zero
        expect(line.series[1].values).toEqual([2, null]);
    });

    test('a donut with more slices than anyone can tell apart folds the rest into Other', () => {
        const items = Array.from({ length: 9 }, (_, i) => ({ label: `C${i}`, value: 10 - i }));
        const { infographic } = normalizeInfographic({ locale: 'es', sections: [{ kind: 'donut', items }] });
        const donut = infographic.sections[0];
        if (donut.kind !== 'donut') throw new Error('expected a donut');
        expect(donut.items).toHaveLength(6);
        expect(donut.items[5].label.text).toBe('Otros');
        expect(donut.items[5].value).toBe(5 + 4 + 3 + 2);
    });

    test('unknown kinds are skipped with a warning, not rendered', () => {
        const { infographic, warnings } = normalizeInfographic({ sections: [{ kind: 'iframe', html: '<x>' }, { kind: 'text', text: 'ok' }] });
        expect(infographic.sections.map((s) => s.kind)).toEqual(['text']);
        expect(warnings[0]).toContain('iframe');
    });

    test('only strings are bound for editing: a number edited as text would change its type', () => {
        const { infographic } = normalizeInfographic({ title: 'T', sections: [{ kind: 'bar', items: [{ label: 'a', value: 1 }, { label: 2, value: 2 }] }] });
        const bar = infographic.sections[0];
        if (bar.kind !== 'bar') throw new Error('expected bars');
        expect(bar.items[0].label.field).toBe('sections.0.items.0.label');
        expect(bar.items[1].label.field).toBeUndefined();
        expect(infographic.title?.field).toBe('title');
    });
});

describe('on the page', () => {
    test('real text, bound to its CMS field, scaled in container units', () => {
        const html = renderInfographicHtml(dashboard, { format: 'blog' });
        expect(html).toContain('data-inti-field="title"');
        expect(html).toContain('data-inti-field="sections.2.items.0.label"');
        expect(html).toContain('Mobile sales doubled in a year');
        expect(html).toContain('cqw');
        expect(html).toContain('role="img"');
        expect(html).not.toMatch(/\d+px/);
    });

    test('content is escaped: the CMS cannot inject markup', () => {
        const html = renderInfographicHtml({ title: '<script>alert(1)</script>', sections: [{ kind: 'text', text: '"><img src=x onerror=alert(1)>' }] });
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;script&gt;');
    });

    test('a logo loads only from a declared origin', () => {
        const from = (logo: string, imageOrigins?: string[]) => renderInfographicHtml({ logo, sections: [] }, { imageOrigins });
        expect(from('https://evil.example/x.png')).not.toContain('evil.example');
        expect(from('https://cdn.acme.com/logo.png', ['https://cdn.acme.com'])).toContain('https://cdn.acme.com/logo.png');
        expect(from('data:image/png;base64,AAAA')).toContain('data:image/png;base64,AAAA');
        expect(from('data:image/svg+xml;base64,AAAA')).not.toContain('svg+xml');
    });

    test('the block picks a declared theme; it cannot bring its own colours', () => {
        const dark = renderInfographicHtml({ theme: 'dark', sections: [] });
        expect(dark).toContain('#111110');
        const unknown = renderInfographicHtml({ theme: 'url(javascript:1)', sections: [] });
        expect(unknown).toContain('#f4f3ef');
    });
});

describe('as images', () => {
    test('each platform gets its size and the format it accepts', async () => {
        const cases = [
            ['instagram-portrait', 'jpeg', 1080, 1350],
            ['instagram-square', 'jpeg', 1080, 1080],
            ['instagram-story', 'jpeg', 1080, 1920],
            ['tiktok', 'jpeg', 1080, 1920],
            ['blog', 'png', 1600, 900],
            ['og', 'png', 1200, 630]
        ] as const;
        for (const [format, type, width, height] of cases) {
            const { slides } = await renderInfographic(small, { format, fonts });
            expect(slides).toHaveLength(1);
            expect(size(slides[0].bytes)).toEqual({ type, width, height });
            expect(slides[0].contentType).toBe(type === 'png' ? 'image/png' : 'image/jpeg');
        }
    }, 60_000);

    test('TikTok keeps content out of the area its interface covers', () => {
        const box = contentBox(FORMATS.tiktok);
        expect(box.y).toBeGreaterThanOrEqual(FORMATS.tiktok.safe.top);
        expect(box.y + box.height).toBeLessThanOrEqual(1920 - FORMATS.tiktok.safe.bottom);
        expect(box.x + box.width).toBeLessThanOrEqual(1080 - FORMATS.tiktok.safe.right);
    });

    test('a long table continues across a carousel without losing a row', async () => {
        const rows = Array.from({ length: 40 }, (_, i) => `Product ${i + 1};${(i + 1) * 10}`).join('\n');
        const data = { title: 'Catalogue', sections: [{ kind: 'table', data: `Product;Units\n${rows}` }] };
        const plan = await planInfographic(data, { format: 'instagram-portrait', fonts });
        expect(plan.slides.length).toBeGreaterThan(1);
        const alt = plan.slides.map((s) => s.alt).join(' ');
        for (let i = 1; i <= 40; i++) expect(alt).toContain(`Product ${i}. ${i * 10}.`);
        expect(plan.warnings).toEqual([]);
    }, 60_000);

    test('steps keep their numbering on the next image', async () => {
        const items = Array.from({ length: 14 }, (_, i) => ({ title: `A step with a long title, number ${i + 1}`, text: 'An explanation long enough to take two lines on a vertical image.' }));
        const plan = await planInfographic({ sections: [{ kind: 'steps', items }] }, { format: 'instagram-square', fonts });
        expect(plan.slides.length).toBeGreaterThan(1);
        expect(plan.slides[1].alt).toMatch(/\b(\d+)\b/);
        expect(plan.slides[1].alt).not.toMatch(/^1\b/);
    }, 60_000);

    test('the social preview is one image; what does not fit is reported', async () => {
        const { slides, warnings } = await renderInfographic(dashboard, { format: 'og', fonts });
        expect(slides).toHaveLength(1);
        expect(warnings.some((w) => w.includes('og takes 1'))).toBe(true);
    }, 60_000);

    test('alt text carries the numbers, for Instagram, TikTok and <img alt>', async () => {
        const { slides } = await renderInfographic(small, { format: 'instagram-portrait', fonts, output: 'svg' });
        expect(slides[0].alt).toContain('Sales by channel');
        expect(slides[0].alt).toContain('Web: 120');
        expect(slides[0].alt).toContain('Source: CRM');
    }, 30_000);
});

describe('endpoint', () => {
    const blocks = [
        { type: 'hero', data: { heading: 'x' }, meta: { index: 0 } },
        { type: 'infographic', data: small, meta: { index: 1 } },
        { type: 'infographic', data: small, meta: { index: 2, visible: false } }
    ];
    const GET = createInfographicRoute({ readPage: async (slug) => (slug === 'blog/ventas' ? { blocks } : null), blockTypes: ['infographic'], fonts });
    const call = (path: string, query = '', headers: Record<string, string> = {}) =>
        GET({ params: { path }, request: new Request(`https://acme.com/infographics/${path}${query}`, { headers }) });

    test('serves the image in the format asked for, cached by content', async () => {
        const response = await call('blog/ventas/1.jpg', '?format=instagram-portrait');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('image/jpeg');
        const etag = response.headers.get('etag')!;
        expect((await call('blog/ventas/1.jpg', '?format=instagram-portrait', { 'if-none-match': etag })).status).toBe(304);
    }, 30_000);

    test('a manifest tells an automation how many images to post and their alt text', async () => {
        const response = await call('blog/ventas/1.json', '?format=tiktok');
        const manifest = (await response.json()) as { slides: { url: string; alt: string }[]; width: number; height: number };
        expect(manifest.width).toBe(1080);
        expect(manifest.height).toBe(1920);
        expect(manifest.slides[0].url).toBe('https://acme.com/infographics/blog/ventas/1.jpg?format=tiktok&slide=1');
        expect(manifest.slides[0].alt).toContain('Web: 120');
    }, 30_000);

    test('only declared, visible blocks of a published page', async () => {
        expect((await call('blog/ventas/0.png')).status).toBe(404);
        expect((await call('blog/ventas/2.png')).status).toBe(404);
        expect((await call('blog/otra/1.png')).status).toBe(404);
        expect((await call('blog/ventas/1.png', '?format=poster')).status).toBe(400);
        expect((await call('blog/ventas/1.png', '?slide=0')).status).toBe(400);
    });
});

describe('vocabulary for @intijs/genui', () => {
    test('with a data source, no number can come from the model', () => {
        const block = infographicVocabulary({ datasets: 'metrics' });
        const sections = block.fields!.sections;
        if (sections.type !== 'list' || sections.of.type !== 'object') throw new Error('expected a list of objects');
        const section = sections.of.fields;
        expect(section.value).toBeUndefined();
        expect(section.data).toMatchObject({ type: 'data', source: 'metrics' });
        const items = section.items;
        if (items.type !== 'list' || items.of.type !== 'object') throw new Error('expected items');
        expect(items.of.fields.value).toBeUndefined();
        expect(items.of.fields.delta).toBeUndefined();
    });

    test('a stored dataset id is drawn with the table it names', () => {
        const stored = { sections: [{ kind: 'bar', title: 'Sales', data: 'q3-sales' }, { kind: 'bar', data: 'Web;1\nStore;2' }] };
        const html = renderInfographicHtml(stored, { datasets: { 'q3-sales': [{ label: 'North', value: 42 }] } });
        expect(html).toContain('North');
        // A pasted table is never taken for an id
        expect(html).toContain('Store');
        // An id with no table draws nothing rather than inventing one
        expect(renderInfographicHtml(stored, { datasets: {} })).not.toContain('North');
    });

    test('themes are a closed list', () => {
        expect(infographicVocabulary({ themes: ['brand'] }).variants).toEqual({ theme: ['brand'] });
    });
});
