/**
 * WOFF to TrueType/OpenType.
 *
 * WOFF (version 1) is the same font with each table compressed with zlib. Satori reads it,
 * but its text shaper (HarfBuzz) does not: given a WOFF file it finds no glyphs and draws
 * "NO GLYPH" boxes. Unwrapping it first lets any Satori build use the WOFF files that
 * Fontsource and most CDNs ship. `DecompressionStream` exists in Node 18+, Bun, Deno and
 * Workers, so this runs everywhere the renderer does.
 */

const WOFF = 0x774f4646; // 'wOFF'
const WOFF2 = 0x774f4632; // 'wOF2'

export function isWoff(data: Uint8Array): boolean {
    return data.byteLength >= 4 && new DataView(data.buffer, data.byteOffset, 4).getUint32(0) === WOFF;
}

export function isWoff2(data: Uint8Array): boolean {
    return data.byteLength >= 4 && new DataView(data.buffer, data.byteOffset, 4).getUint32(0) === WOFF2;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A WOFF file as the sfnt (TTF/OTF) it wraps. Anything else is returned untouched */
export async function woffToSfnt(input: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!isWoff(data)) return data;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const flavor = view.getUint32(4);
    const numTables = view.getUint16(12);

    const tables: { tag: number; checksum: number; data: Uint8Array }[] = [];
    for (let i = 0; i < numTables; i++) {
        const entry = 44 + i * 20;
        const tag = view.getUint32(entry);
        const offset = view.getUint32(entry + 4);
        const compLength = view.getUint32(entry + 8);
        const origLength = view.getUint32(entry + 12);
        const checksum = view.getUint32(entry + 16);
        const raw = data.subarray(offset, offset + compLength);
        const table = compLength < origLength ? await inflate(raw) : raw;
        if (table.byteLength !== origLength) throw new Error('Corrupt WOFF: a table does not inflate to its declared size');
        tables.push({ tag, checksum, data: table });
    }

    // sfnt header: the largest power of two not above numTables drives the binary search fields
    let power = 1;
    let log2 = 0;
    while (power * 2 <= numTables) {
        power *= 2;
        log2++;
    }
    const headerSize = 12 + numTables * 16;
    const total = tables.reduce((sum, table) => sum + ((table.data.byteLength + 3) & ~3), headerSize);

    const out = new Uint8Array(total);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, flavor);
    outView.setUint16(4, numTables);
    outView.setUint16(6, power * 16);
    outView.setUint16(8, log2);
    outView.setUint16(10, numTables * 16 - power * 16);

    let offset = headerSize;
    tables.forEach((table, i) => {
        const record = 12 + i * 16;
        outView.setUint32(record, table.tag);
        outView.setUint32(record + 4, table.checksum);
        outView.setUint32(record + 8, offset);
        outView.setUint32(record + 12, table.data.byteLength);
        out.set(table.data, offset);
        offset += (table.data.byteLength + 3) & ~3;
    });
    return out;
}
