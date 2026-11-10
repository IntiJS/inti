import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { escapeHtml } from '../src/visual-bridge/escape.js';
import { createCmsConnector } from '../src/visual-bridge/engine.js';

const VISUAL_BRIDGE = resolve(import.meta.dir, '../src/visual-bridge');

/**
 * The editor shows titles, labels and names that come from the CMS, from the
 * block vocabulary and from other editors (a shared pattern's name). They used
 * to be interpolated into `innerHTML` as they came: an entry titled
 * `<img src=x onerror=…>` ran in the browser of whoever opened the relation
 * picker, and a pattern with that name in everyone's who opened the palette.
 */
describe('escapeHtml', () => {
    test('markup in a CMS title is shown as text', () => {
        expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    });

    test('escapes the five characters that matter in text and attributes', () => {
        expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;');
    });

    test('an ampersand is escaped once, not twice', () => {
        expect(escapeHtml('&lt;')).toBe('&amp;lt;');
    });

    test('accepts anything a CMS may return in place of a string', () => {
        expect(escapeHtml(undefined)).toBe('');
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(42)).toBe('42');
    });

    test('leaves ordinary text alone', () => {
        expect(escapeHtml('Ñandú, 100 % “quoted”')).toBe('Ñandú, 100 % “quoted”');
    });
});

describe('the editor never puts an unescaped value into HTML', () => {
    // A number computed in the editor is the only interpolation that needs no escaping
    const SAFE = /^(escapeHtml\(.*\)|[\w.]+\.length)$/;

    for (const file of readdirSync(VISUAL_BRIDGE).filter((name) => name.endsWith('.ts'))) {
        test(file, () => {
            const source = readFileSync(join(VISUAL_BRIDGE, file), 'utf8');
            const offenders: string[] = [];

            // Each `x.innerHTML = `…`` template, whatever it spans
            for (const match of source.matchAll(/\.innerHTML\s*=\s*`([\s\S]*?)`;/g)) {
                for (const interpolation of match[1].matchAll(/\$\{([^}]*)\}/g)) {
                    if (!SAFE.test(interpolation[1].trim())) offenders.push(interpolation[1].trim());
                }
            }

            expect(offenders).toEqual([]);
        });
    }
});

describe('the "Edit in CMS" link', () => {
    const block = (documentId: string) => ({ id: 'b1', type: 'hero', documentId, contentType: 'page' });

    test('Kitsuden: opens the page in the panel\'s page editor', () => {
        const connector = createCmsConnector('kitsuden', { adminUrl: 'https://panel.example.com/' });

        expect(connector.name).toBe('Kitsuden');
        expect(connector.getEditUrl(block('11111111-2222-3333-4444-555555555555'))).toBe(
            'https://panel.example.com/g/system-tools/builder?id=11111111-2222-3333-4444-555555555555'
        );
    });

    test('Kitsuden: a game sheet is not a Page Builder page, so it opens the panel', () => {
        const connector = createCmsConnector('kitsuden', { adminUrl: 'https://panel.example.com' });
        expect(connector.getEditUrl(block('game:11111111-2222-3333-4444-555555555555'))).toBe('https://panel.example.com');
    });

    test('WordPress: opens the post in wp-admin', () => {
        const connector = createCmsConnector('wordpress', { adminUrl: 'https://cms.example.com/wp-admin' });
        expect(connector.getEditUrl(block('42'))).toBe('https://cms.example.com/wp-admin/post.php?post=42&action=edit');
    });
});
