/**
 * WordPress images as Inti's image contract.
 *
 * An ACF image field (`acf_format=standard`) and a REST attachment carry the
 * sizes WordPress already generated, their byte size (`filesize`) and, with
 * modern formats on, the same image as AVIF or WebP (`sources`, per size).
 * Some setups also turn an animated GIF into a video. All of that becomes
 * `srcset`, `sources` and `video`, so `IntiImage` uses what WordPress made
 * instead of transforming the image again.
 *
 * Nothing is removed: the original keys stay, so a block that read
 * `image.url` or `image.sizes.large` keeps working.
 */

import type { ImageCandidate, ImageSource, MediaAsset } from '@intijs/core/image';

type Raw = Record<string, any>;

const num = (value: unknown): number | undefined => {
    const n = typeof value === 'string' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
};

/** `https://cms/uploads/2026/11/a-300x200.jpg` + `a-300x200.webp` → the same folder */
function sibling(url: string | undefined, file: string | undefined): string | undefined {
    if (!file) return undefined;
    if (/^https?:\/\//.test(file)) return file;
    if (!url) return undefined;
    return url.replace(/[^/]+$/, file.split('/').pop()!);
}

/** `{ 'image/webp': { file | source_url, filesize } }` → type → url */
function sourceUrls(sources: unknown, base: string | undefined): Map<string, string> {
    const out = new Map<string, string>();
    if (!sources || typeof sources !== 'object') return out;
    for (const [type, entry] of Object.entries(sources as Raw)) {
        if (!type.startsWith('image/') || !entry || typeof entry !== 'object') continue;
        const url = entry.source_url ?? sibling(base, entry.file);
        if (typeof url === 'string') out.set(type, url);
    }
    return out;
}

function isAcfImage(value: Raw): boolean {
    return typeof value.url === 'string' && (value.type === 'image' || String(value.mime_type ?? '').startsWith('image/')) && ('sizes' in value || 'width' in value);
}

function isAttachment(value: Raw): boolean {
    return typeof value.source_url === 'string' && value.media_details && typeof value.media_details === 'object';
}

/** The contract's fields for one WordPress image, or null when it is not one */
export function wordpressImage(value: unknown): MediaAsset | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Raw;

    let url: string;
    let width: number | undefined;
    let height: number | undefined;
    const candidates: ImageCandidate[] = [];
    const byType = new Map<string, ImageCandidate[]>();
    const addSource = (type: string, candidate: ImageCandidate) => byType.set(type, [...(byType.get(type) ?? []), candidate]);
    let details: Raw;

    if (isAttachment(raw)) {
        details = raw.media_details;
        url = raw.source_url;
        width = num(details.width);
        height = num(details.height);
        for (const size of Object.values((details.sizes ?? {}) as Raw)) {
            const w = num(size?.width);
            if (!w || typeof size?.source_url !== 'string') continue;
            candidates.push({ url: size.source_url, width: w });
            for (const [type, source] of sourceUrls(size.sources, size.source_url)) addSource(type, { url: source, width: w });
        }
    } else if (isAcfImage(raw)) {
        details = raw;
        url = raw.url;
        width = num(raw.width);
        height = num(raw.height);
        const sizes = (raw.sizes ?? {}) as Raw;
        for (const [name, sizeUrl] of Object.entries(sizes)) {
            if (name.endsWith('-width') || name.endsWith('-height') || typeof sizeUrl !== 'string') continue;
            const w = num(sizes[`${name}-width`]);
            if (w) candidates.push({ url: sizeUrl, width: w });
        }
    } else {
        return null;
    }

    if (width) candidates.push({ url, width });
    const mimeType: string | undefined = raw.mime_type;
    for (const [type, source] of sourceUrls(details.sources ?? raw.sources, url)) {
        if (type !== mimeType && width) addSource(type, { url: source, width });
    }

    // Best format first: the browser takes the first <source> it supports
    const order = ['image/avif', 'image/webp'];
    const sources: ImageSource[] = [...byType.entries()]
        .sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
        .map(([type, srcset]) => ({ type, srcset }));

    // An animated GIF that the site also stores as a video
    const videoSource = details.sources?.['video/mp4'] ?? details.video ?? raw.video;
    const videoUrl =
        typeof videoSource === 'string' ? videoSource : (videoSource?.source_url ?? sibling(url, videoSource?.file) ?? videoSource?.url);

    return {
        id: String(raw.id ?? raw.ID ?? url),
        url,
        alt: raw.alt ?? raw.alt_text ?? undefined,
        width,
        height,
        mimeType,
        size: num(raw.filesize ?? details.filesize),
        srcset: candidates.length > 1 ? candidates : undefined,
        sources: sources.length ? sources : undefined,
        video: typeof videoUrl === 'string' ? { url: videoUrl, type: 'video/mp4' } : undefined
    };
}

/**
 * Adds the image contract to every WordPress image in a block's data, at any
 * depth (a repeater of cards with images). Other values are untouched.
 */
export function augmentMedia<T>(value: T, depth = 0): T {
    if (depth > 12 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => augmentMedia(item, depth + 1)) as T;
    const image = wordpressImage(value);
    if (image) {
        const extra = Object.fromEntries(Object.entries(image).filter(([, v]) => v !== undefined));
        return { ...(value as Raw), ...extra, id: (value as Raw).id ?? image.id } as T;
    }
    return Object.fromEntries(Object.entries(value as Raw).map(([key, item]) => [key, augmentMedia(item, depth + 1)])) as T;
}
