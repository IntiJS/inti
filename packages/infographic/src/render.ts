/**
 * Images. Satori lays the tree out with real fonts and returns SVG; a rasterizer
 * (resvg) turns that into pixels; PNG for the web, JPEG where the platform wants it.
 *
 * Nothing here needs a browser, so it runs in Node, in a serverless function or, with
 * `@resvg/resvg-wasm`, in a Cloudflare Worker.
 */

import satori from 'satori';
import { isRecord, normalizeInfographic, type Infographic } from './data.js';
import { isWoff2, woffToSfnt } from './fonts.js';
import { resolveFormat, type FormatId, type InfographicFormat } from './formats.js';
import { buildPage, buildWeb, altText, paginate, type LayoutOptions } from './layout.js';
import { resolveTheme, type InfographicTheme } from './themes.js';
import { toHtml } from './html.js';
import { forImage, type VNode } from './vnode.js';

export interface FontInput {
    name: string;
    data: ArrayBuffer | Uint8Array;
    weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
    style?: 'normal' | 'italic';
}

/** What renderInfographic needs from Satori: element tree and options in, SVG out */
export type SatoriLike = (node: never, options: never) => Promise<string>;

/** Turns SVG into RGBA pixels and PNG bytes */
export type Rasterizer = (svg: string, options: { width: number }) => Promise<{ png: Uint8Array; pixels: Uint8Array; width: number; height: number }>;

export interface RenderOptions {
    /** Default: `blog` */
    format?: FormatId | InfographicFormat | string;
    /** Your own formats, addressable by id */
    formats?: InfographicFormat[];
    /** A theme name; the block's own `theme` field wins when it names a declared theme */
    theme?: string;
    themes?: InfographicTheme[];
    locale?: string;
    /**
     * TTF, OTF or WOFF (not WOFF2). Default: the theme's font from an installed
     * `@fontsource/<family>` package (offline), else from Google Fonts, fetched once per
     * process.
     */
    fonts?: FontInput[];
    /**
     * The layout engine. Default: `satori`. In a Worker, where WebAssembly cannot be
     * compiled from bytes at runtime, pass the standalone build after `init(yogaWasm)`:
     * `import satori, { init } from 'satori/standalone'`.
     */
    satori?: SatoriLike;
    /** Default: `@resvg/resvg-js` (Node). In a Worker, `resvgRasterizer(Resvg)` from `@resvg/resvg-wasm` */
    rasterizer?: Rasterizer;
    /** Overrides the format's default */
    output?: 'png' | 'jpeg' | 'svg';
    /** JPEG quality, 1–100. Default 90 */
    quality?: number;
    /** Origins a logo may be loaded from. `data:` images are always allowed */
    imageOrigins?: string[];
    /**
     * Tables by id. A section whose `data` is an id (what @intijs/genui stores for a
     * `fromData` field) is drawn with the table it names. An object or a lookup function
     */
    datasets?: Record<string, unknown> | ((id: string) => unknown);
}

export interface RenderedSlide {
    index: number;
    total: number;
    width: number;
    height: number;
    contentType: 'image/png' | 'image/jpeg' | 'image/svg+xml';
    bytes: Uint8Array;
    svg: string;
    /** For Instagram's and TikTok's alt text and for <img alt> */
    alt: string;
}

export interface RenderResult {
    format: InfographicFormat;
    slides: RenderedSlide[];
    warnings: string[];
}

// ============================================
// Fonts
// ============================================

const fontCache = new Map<string, Promise<FontInput[]>>();

/**
 * A family from Google Fonts as TTF, which is what Satori reads. Without a browser
 * User-Agent the stylesheet points at TrueType files.
 */
export function loadGoogleFont(family: string, weights: FontInput['weight'][] = [400, 600, 800]): Promise<FontInput[]> {
    const key = `${family}:${weights.join(',')}`;
    let cached = fontCache.get(key);
    if (!cached) {
        cached = (async () => {
            const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${weights.join(';')}`;
            const css = await (await fetch(url)).text();
            const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
            const fonts = await Promise.all(
                faces.map(async (face) => {
                    const src = face.match(/src:\s*url\(([^)]+)\)\s*format\('(truetype|opentype|woff)'\)/);
                    const weight = Number(face.match(/font-weight:\s*(\d+)/)?.[1] ?? 400) as FontInput['weight'];
                    if (!src) return null;
                    const data = await (await fetch(src[1])).arrayBuffer();
                    return { name: family, data, weight, style: 'normal' as const };
                })
            );
            const found = fonts.filter((font): font is NonNullable<typeof font> => font !== null);
            if (!found.length) throw new Error(`Google Fonts returned no usable file for "${family}". Pass \`fonts\` explicitly.`);
            return found;
        })();
        cached.catch(() => fontCache.delete(key));
        fontCache.set(key, cached);
    }
    return cached;
}

/**
 * A family installed from Fontsource (`npm install @fontsource/inter`): WOFF files on
 * disk, so nothing is downloaded. Latin and Latin Extended, which cover the accents of
 * Spanish, Portuguese, French or German. Node only; resolves to `null` elsewhere or when
 * the package is not installed.
 */
export async function loadFontsource(family: string, weights: FontInput['weight'][] = [400, 600, 800]): Promise<FontInput[] | null> {
    const slug = family.toLowerCase().replace(/\s+/g, '-');
    const key = `fontsource:${slug}:${weights.join(',')}`;
    const cached = fontCache.get(key);
    if (cached) return cached;
    try {
        const [{ createRequire }, { readFile }] = await Promise.all([import('node:module'), import('node:fs/promises')]);
        const require = createRequire(import.meta.url);
        const fonts: FontInput[] = [];
        for (const weight of weights) {
            for (const subset of ['latin', 'latin-ext']) {
                let path: string;
                try {
                    path = require.resolve(`@fontsource/${slug}/files/${slug}-${subset}-${weight}-normal.woff`);
                } catch {
                    continue;
                }
                fonts.push({ name: family, data: await readFile(path), weight, style: 'normal' });
            }
        }
        if (!fonts.length) return null;
        const loaded = Promise.resolve(fonts);
        fontCache.set(key, loaded);
        return loaded;
    } catch {
        return null;
    }
}

/** Your fonts, else an installed Fontsource package, else Google Fonts once per process */
const unwrapped = new WeakMap<object, Promise<FontInput>>();

/**
 * WOFF is unwrapped to TTF/OTF once per font object, so every Satori build can shape it.
 * WOFF2 is refused with a clear message instead of rendering "NO GLYPH" boxes.
 */
function prepareFont(font: FontInput): Promise<FontInput> {
    let pending = unwrapped.get(font);
    if (!pending) {
        pending = (async () => {
            const data = font.data instanceof Uint8Array ? font.data : new Uint8Array(font.data);
            if (isWoff2(data)) throw new Error(`Font "${font.name}" is WOFF2, which the renderer cannot read: pass TTF, OTF or WOFF.`);
            const sfnt = await woffToSfnt(data);
            return sfnt === data ? font : { ...font, data: sfnt };
        })();
        unwrapped.set(font, pending);
    }
    return pending;
}

let embeddedInter: Promise<FontInput[]> | null = null;

/**
 * Your fonts; else Inter, embedded in the package, for the themes that use it (no disk, no
 * network, so it works the same in Node, on Vercel or Netlify and in a Worker); else an
 * installed `@fontsource/<family>`; else Google Fonts, once per process.
 */
async function fontsFor(options: RenderOptions, theme: InfographicTheme): Promise<FontInput[]> {
    let fonts = options.fonts?.length ? options.fonts : null;
    if (!fonts && theme.fontFamily === 'Inter') {
        embeddedInter ??= import('./fonts/inter.js').then(({ interFonts }) => interFonts());
        fonts = await embeddedInter;
    }
    fonts ??= (await loadFontsource(theme.fontFamily)) ?? (await loadGoogleFont(theme.fontFamily));
    return Promise.all(fonts.map(prepareFont));
}

// ============================================
// Rasterizing
// ============================================

interface ResvgLike {
    new (svg: string, options?: Record<string, unknown>): { render(): { asPng(): Uint8Array; pixels: Uint8Array; width: number; height: number } };
}

/** A rasterizer from a resvg class: `@resvg/resvg-js` in Node, `@resvg/resvg-wasm` after `initWasm()` */
export function resvgRasterizer(Resvg: ResvgLike): Rasterizer {
    return async (svg, { width }) => {
        const image = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false }, shapeRendering: 2, textRendering: 1 }).render();
        return { png: image.asPng(), pixels: image.pixels, width: image.width, height: image.height };
    };
}

let nodeRasterizer: Promise<Rasterizer> | null = null;

function defaultRasterizer(): Promise<Rasterizer> {
    nodeRasterizer ??= import('@resvg/resvg-js')
        .then((mod) => resvgRasterizer((mod as unknown as { Resvg: ResvgLike }).Resvg))
        .catch(() => {
            nodeRasterizer = null;
            throw new Error('Rendering to PNG or JPEG needs a rasterizer: `npm install @resvg/resvg-js`, or pass `rasterizer` (e.g. resvgRasterizer from @resvg/resvg-wasm in a Worker).');
        });
    return nodeRasterizer;
}

type JpegEncode = (image: { data: Uint8Array; width: number; height: number }, quality: number) => { data: Uint8Array };

async function encodeJpeg(pixels: Uint8Array, width: number, height: number, quality: number): Promise<Uint8Array> {
    const mod = (await import('jpeg-js')) as unknown as { encode?: JpegEncode; default?: { encode: JpegEncode } };
    const encode = mod.encode ?? mod.default!.encode;
    // jpeg-js ends with `Buffer.from(bytes)`. A Worker without `nodejs_compat` has no
    // Buffer: lend it a byte array for the duration of the call, then take it back.
    const globals = globalThis as { Buffer?: unknown };
    const lent = globals.Buffer === undefined;
    if (lent) globals.Buffer = { from: (bytes: ArrayLike<number>) => Uint8Array.from(bytes) };
    try {
        return new Uint8Array(encode({ data: pixels, width, height }, quality).data);
    } finally {
        if (lent) delete globals.Buffer;
    }
}

// ============================================
// Public API
// ============================================

function prepare(data: unknown, options: RenderOptions) {
    const format = resolveFormat(options.format, options.formats);
    const { infographic, warnings } = normalizeInfographic(resolveDatasets(data, options.datasets), { locale: options.locale });
    // The block can choose among declared themes; it cannot bring its own colours
    const theme = resolveTheme(infographic.theme ?? options.theme, options.themes, options.theme ?? 'light');
    const layout: LayoutOptions = { theme, format, imageOrigins: options.imageOrigins };
    return { format, infographic, warnings, theme, layout };
}

/** Replaces a dataset id in `sections[].data` with the table it names */
export function resolveDatasets(data: unknown, datasets: RenderOptions['datasets']): unknown {
    if (!datasets || !isRecord(data) || !Array.isArray(data.sections)) return data;
    const lookup = typeof datasets === 'function' ? datasets : (id: string) => (Object.hasOwn(datasets, id) ? datasets[id] : undefined);
    return {
        ...data,
        sections: data.sections.map((section) => {
            if (!isRecord(section)) return section;
            const ref = section.data ?? section.dataset;
            // An id is a short token; a pasted table has line breaks or separators
            if ((typeof ref !== 'string' && typeof ref !== 'number') || /[\n;\t]/.test(String(ref))) return section;
            const table = lookup(String(ref));
            return table === undefined ? section : { ...section, data: table };
        })
    };
}

function svgHeight(svg: string): number {
    return Number(svg.match(/^<svg[^>]*\sheight="([\d.]+)"/)?.[1] ?? 0);
}

async function measurer(fonts: FontInput[], engine: SatoriLike) {
    return async (node: VNode, width: number) => {
        const svg = await engine(forImage(node) as never, { width, fonts } as never);
        return svgHeight(svg);
    };
}

/** How many images the infographic needs in a format, and what each says. No pixels */
export async function planInfographic(data: unknown, options: RenderOptions = {}): Promise<{ format: InfographicFormat; slides: { index: number; alt: string }[]; warnings: string[] }> {
    const { format, infographic, warnings, theme, layout } = prepare(data, options);
    const fonts = await fontsFor(options, theme);
    const result = await paginate(infographic, layout, await measurer(fonts, options.satori ?? (satori as SatoriLike)));
    return {
        format,
        slides: result.pages.map((_, index) => ({ index, alt: altText(buildPage(infographic, layout, result.pages, index)) })),
        warnings: [...warnings, ...result.warnings]
    };
}

/**
 * Every image the infographic needs in one format: one for a short one, a carousel
 * for a long one. Pass `slide` to render only that one.
 */
export async function renderInfographic(data: unknown, options: RenderOptions & { slide?: number } = {}): Promise<RenderResult> {
    const { format, infographic, warnings, theme, layout } = prepare(data, options);
    const fonts = await fontsFor(options, theme);
    const { pages, warnings: layoutWarnings } = await paginate(infographic, layout, await measurer(fonts, options.satori ?? (satori as SatoriLike)));
    const output = options.output ?? format.output;
    const quality = Math.max(1, Math.min(100, Math.round(options.quality ?? 90)));
    const rasterizer = output === 'svg' ? null : options.rasterizer ?? (await defaultRasterizer());

    const indexes = options.slide === undefined ? pages.map((_, i) => i) : [options.slide].filter((i) => Number.isInteger(i) && i >= 0 && i < pages.length);
    const slides: RenderedSlide[] = [];
    for (const index of indexes) {
        const node = buildPage(infographic, layout, pages, index);
        const svg = await (options.satori ?? (satori as SatoriLike))(forImage(node) as never, { width: format.width, height: format.height, fonts } as never);
        const base = { index, total: pages.length, width: format.width, height: format.height, svg, alt: altText(node) };
        if (!rasterizer) {
            slides.push({ ...base, contentType: 'image/svg+xml', bytes: new TextEncoder().encode(svg) });
            continue;
        }
        const raster = await rasterizer(svg, { width: format.width });
        slides.push(
            output === 'jpeg'
                ? { ...base, contentType: 'image/jpeg', bytes: await encodeJpeg(raster.pixels, raster.width, raster.height, quality) }
                : { ...base, contentType: 'image/png', bytes: raster.png }
        );
    }
    return { format, slides, warnings: [...warnings, ...layoutWarnings] };
}

/**
 * The infographic as HTML for the page: real text, inline SVG charts, editable with
 * `data-inti-field`. Synchronous and font-independent: the browser lays it out.
 */
export function renderInfographicHtml(data: unknown, options: Omit<RenderOptions, 'fonts' | 'rasterizer' | 'output' | 'quality'> & { label?: string; className?: string } = {}): string {
    const { infographic, layout, format } = prepare(data, options);
    const node = buildWeb(infographic, layout);
    return toHtml(node, { width: format.width, label: options.label ?? labelOf(infographic), className: options.className });
}

function labelOf(info: Infographic): string | undefined {
    return info.title?.text;
}
