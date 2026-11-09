import { describe, test, expect } from 'bun:test';
import {
    parseGutenberg,
    patchBlockText,
    serializeGutenberg,
    extractText,
    isTextEditable,
    gutenbergNameToType
} from '../src/gutenberg.js';

// ============================================
// Fixture: real Gutenberg post_content
// ============================================

const CONTENT = `<!-- wp:heading {"level":2} -->
<h2 class="wp-block-heading">Bienvenido</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>Un párrafo simple de texto.</p>
<!-- /wp:paragraph -->

<!-- wp:spacer {"height":"40px"} /-->

<!-- wp:columns -->
<div class="wp-block-columns"><!-- wp:column -->
<div class="wp-block-column"><!-- wp:paragraph -->
<p>Anidado</p>
<!-- /wp:paragraph --></div>
<!-- /wp:column --></div>
<!-- /wp:columns -->

<!-- wp:acme/team-list {"count":3} -->
<div class="team">compleja <strong>con markup</strong></div>
<!-- /wp:acme/team-list -->`;

// ============================================
// Parser
// ============================================

describe('parseGutenberg', () => {
    test('parses only top-level blocks', () => {
        const blocks = parseGutenberg(CONTENT);

        expect(blocks).toHaveLength(5);
        expect(blocks.map(b => b.name)).toEqual([
            'core/heading',
            'core/paragraph',
            'core/spacer',
            'core/columns',
            'acme/team-list'
        ]);
    });

    test('extracts JSON attributes from the comment', () => {
        const blocks = parseGutenberg(CONTENT);

        expect(blocks[0].attrs).toEqual({ level: 2 });
        expect(blocks[1].attrs).toEqual({});
        expect(blocks[4].attrs).toEqual({ count: 3 });
    });

    test('self-closing blocks have an empty innerHTML', () => {
        const blocks = parseGutenberg(CONTENT);

        expect(blocks[2].name).toBe('core/spacer');
        expect(blocks[2].innerHTML).toBe('');
        expect(blocks[2].closeComment).toBe('');
    });

    test('nested blocks stay inside the parent innerHTML', () => {
        const blocks = parseGutenberg(CONTENT);
        const columns = blocks[3];

        expect(columns.innerHTML).toContain('<!-- wp:column -->');
        expect(columns.innerHTML).toContain('<p>Anidado</p>');
    });
});

// ============================================
// Editability and patch
// ============================================

describe('isTextEditable / extractText', () => {
    const blocks = parseGutenberg(CONTENT);

    test('simple heading and paragraph are editable', () => {
        expect(isTextEditable(blocks[0])).toBe(true);
        expect(isTextEditable(blocks[1])).toBe(true);
    });

    test('spacer, columns and blocks with markup are NOT editable', () => {
        expect(isTextEditable(blocks[2])).toBe(false); // self-closing
        expect(isTextEditable(blocks[3])).toBe(false); // nested
        expect(isTextEditable(blocks[4])).toBe(false); // inner <strong>
    });

    test('extractText returns the plain text of the simple block', () => {
        expect(extractText(blocks[0])).toBe('Bienvenido');
        expect(extractText(blocks[1])).toBe('Un párrafo simple de texto.');
        expect(extractText(blocks[4])).toBeNull();
    });
});

describe('patchBlockText', () => {
    test('replaces the text preserving tag, attributes and comments', () => {
        const blocks = parseGutenberg(CONTENT);
        const patched = patchBlockText(blocks[0], 'Hola Mundo');

        expect(patched.innerHTML).toContain('<h2 class="wp-block-heading">Hola Mundo</h2>');
        expect(patched.raw).toStartWith('<!-- wp:heading {"level":2} -->');
        expect(patched.raw).toEndWith('<!-- /wp:heading -->');
    });

    test('escapes HTML in the new text (no markup injection)', () => {
        const blocks = parseGutenberg(CONTENT);
        const patched = patchBlockText(blocks[1], 'a < b & <script>');

        expect(patched.innerHTML).toContain('a &lt; b &amp; &lt;script&gt;');
    });

    test('throws on complex blocks instead of corrupting them', () => {
        const blocks = parseGutenberg(CONTENT);

        expect(() => patchBlockText(blocks[4], 'x')).toThrow('too complex');
    });
});

// ============================================
// Serializer (round-trip)
// ============================================

describe('serializeGutenberg', () => {
    test('a round-trip without edits preserves each block byte for byte', () => {
        const blocks = parseGutenberg(CONTENT);
        const serialized = serializeGutenberg(blocks);

        // Each original raw is intact in the output
        for (const block of blocks) {
            expect(serialized).toContain(block.raw);
        }
    });

    test('after a patch, only the edited block changes', () => {
        const blocks = parseGutenberg(CONTENT);
        blocks[1] = patchBlockText(blocks[1], 'Texto nuevo');
        const serialized = serializeGutenberg(blocks);

        expect(serialized).toContain('<p>Texto nuevo</p>');
        expect(serialized).not.toContain('Un párrafo simple');
        // The rest intact
        expect(serialized).toContain('<h2 class="wp-block-heading">Bienvenido</h2>');
        expect(serialized).toContain('<!-- wp:spacer {"height":"40px"} /-->');
        expect(serialized).toContain('compleja <strong>con markup</strong>');
    });
});

// ============================================
// Name mapping
// ============================================

describe('gutenbergNameToType', () => {
    test('core drops the namespace; third parties keep it in PascalCase', () => {
        expect(gutenbergNameToType('core/paragraph')).toBe('Paragraph');
        expect(gutenbergNameToType('core/media-text')).toBe('MediaText');
        expect(gutenbergNameToType('acme/team-list')).toBe('AcmeTeamList');
    });
});
