/**
 * Output formats. Each one is a fixed canvas plus the margins its platform covers
 * with its own interface, so nothing important ends up under a button or a caption.
 *
 * Sizes and safe zones follow what each platform documents or what its interface
 * covers today. They change; override them with `defineFormat` instead of editing these.
 */

export interface Insets {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

/** Type and spacing for one canvas size, in pixels of that canvas */
export interface TypeScale {
    eyebrow: number;
    title: number;
    subtitle: number;
    heading: number;
    body: number;
    label: number;
    small: number;
    kpi: number;
    hero: number;
    gap: number;
    radius: number;
}

export interface InfographicFormat {
    id: string;
    label: string;
    width: number;
    height: number;
    /** Covered by the platform's interface: nothing is drawn there except the background */
    safe: Insets;
    /** Breathing room inside the safe area */
    padding: number;
    /** Sections side by side. Landscape canvases use 2, so a page reads like a dashboard */
    columns: 1 | 2;
    /** How many images a post can carry. Extra pages are dropped with a warning */
    maxSlides: number;
    /** What the platform accepts. Instagram's publishing API only takes JPEG */
    output: 'png' | 'jpeg';
    type: TypeScale;
}

const VERTICAL_TYPE: TypeScale = {
    eyebrow: 24,
    title: 64,
    subtitle: 32,
    heading: 34,
    body: 28,
    label: 26,
    small: 22,
    kpi: 72,
    hero: 150,
    gap: 36,
    radius: 20
};

const SQUARE_TYPE: TypeScale = { ...VERTICAL_TYPE, title: 56, subtitle: 30, heading: 30, body: 26, label: 24, kpi: 64, hero: 132, gap: 30 };

export const FORMATS = {
    /** Feed post, 4:5. The profile grid crops it to 3:4, about 34 px per side: the padding covers it */
    'instagram-portrait': {
        id: 'instagram-portrait',
        label: 'Instagram post (4:5)',
        width: 1080,
        height: 1350,
        safe: { top: 0, right: 0, bottom: 0, left: 0 },
        padding: 72,
        columns: 1,
        maxSlides: 20,
        output: 'jpeg',
        type: VERTICAL_TYPE
    },
    'instagram-square': {
        id: 'instagram-square',
        label: 'Instagram post (1:1)',
        width: 1080,
        height: 1080,
        safe: { top: 0, right: 0, bottom: 0, left: 0 },
        padding: 64,
        columns: 1,
        maxSlides: 20,
        output: 'jpeg',
        type: SQUARE_TYPE
    },
    /** Stories and the cover of a Reel: the top and bottom 250 px sit under the interface */
    'instagram-story': {
        id: 'instagram-story',
        label: 'Instagram story (9:16)',
        width: 1080,
        height: 1920,
        safe: { top: 250, right: 0, bottom: 250, left: 0 },
        padding: 72,
        columns: 1,
        maxSlides: 20,
        output: 'jpeg',
        type: VERTICAL_TYPE
    },
    /**
     * TikTok, video or photo mode. The caption and sound cover the bottom, the like and
     * share buttons the right edge, the tabs the top.
     */
    tiktok: {
        id: 'tiktok',
        label: 'TikTok (9:16)',
        width: 1080,
        height: 1920,
        safe: { top: 160, right: 140, bottom: 440, left: 0 },
        padding: 64,
        columns: 1,
        maxSlides: 35,
        output: 'jpeg',
        type: VERTICAL_TYPE
    },
    /** Inside a blog post, 16:9. Two columns, like a dashboard */
    blog: {
        id: 'blog',
        label: 'Blog post (16:9)',
        width: 1600,
        height: 900,
        safe: { top: 0, right: 0, bottom: 0, left: 0 },
        padding: 64,
        columns: 2,
        maxSlides: 10,
        output: 'png',
        type: {
            eyebrow: 18,
            title: 46,
            subtitle: 24,
            heading: 24,
            body: 21,
            label: 19,
            small: 16,
            kpi: 52,
            hero: 110,
            gap: 28,
            radius: 16
        }
    },
    /** The preview when the post is shared: Open Graph, X, LinkedIn, WhatsApp. One image */
    og: {
        id: 'og',
        label: 'Social preview (1.91:1)',
        width: 1200,
        height: 630,
        safe: { top: 0, right: 0, bottom: 0, left: 0 },
        padding: 56,
        columns: 2,
        maxSlides: 1,
        output: 'png',
        type: {
            eyebrow: 17,
            title: 44,
            subtitle: 22,
            heading: 21,
            body: 19,
            label: 17,
            small: 15,
            kpi: 46,
            hero: 96,
            gap: 22,
            radius: 14
        }
    }
} satisfies Record<string, InfographicFormat>;

export type FormatId = keyof typeof FORMATS;

/** A format of your own, starting from an existing one */
export function defineFormat(base: FormatId | InfographicFormat, overrides: Partial<InfographicFormat> & { id: string }): InfographicFormat {
    const from = typeof base === 'string' ? FORMATS[base] : base;
    return {
        ...from,
        ...overrides,
        safe: { ...from.safe, ...overrides.safe },
        type: { ...from.type, ...overrides.type }
    };
}

export function resolveFormat(format: FormatId | InfographicFormat | string | undefined, custom: InfographicFormat[] = []): InfographicFormat {
    if (format && typeof format === 'object') return format;
    const id = format ?? 'blog';
    const found = custom.find((candidate) => candidate.id === id) ?? (FORMATS as Record<string, InfographicFormat>)[id];
    if (!found) throw new Error(`Unknown infographic format "${id}". Known: ${[...Object.keys(FORMATS), ...custom.map((c) => c.id)].join(', ')}`);
    return found;
}

/** Width and height of the area sections are laid out in */
export function contentBox(format: InfographicFormat): { x: number; y: number; width: number; height: number } {
    const { safe, padding, width, height } = format;
    const x = safe.left + padding;
    const y = safe.top + padding;
    return { x, y, width: width - x - safe.right - padding, height: height - y - safe.bottom - padding };
}
