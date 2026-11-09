import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectTailwind } from '../src/integrations/inti-styles.js';

const dirs: string[] = [];

/** A project with the given package.json and files */
function project(pkg: Record<string, unknown> | null, files: string[] = []): string {
    const dir = mkdtempSync(join(tmpdir(), 'inti-styles-'));
    dirs.push(dir);
    if (pkg) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    for (const file of files) writeFileSync(join(dir, file), 'export default {}');
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('detectTailwind', () => {
    test('without Tailwind it detects nothing', () => {
        expect(detectTailwind(project({ dependencies: { astro: '^5.0.0' } }))).toBeNull();
    });

    test('Tailwind 4 without a config file is detected', () => {
        // This is the case that slipped through: v4 is configured from CSS
        const dir = project({ devDependencies: { tailwindcss: '^4.1.0', '@tailwindcss/vite': '^4.1.0' } });
        expect(detectTailwind(dir)).toEqual({ major: 4, via: 'tailwindcss' });
    });

    test('@tailwindcss/vite alone implies v4', () => {
        const dir = project({ devDependencies: { '@tailwindcss/vite': '^4.0.0' } });
        expect(detectTailwind(dir)).toEqual({ major: 4, via: '@tailwindcss/vite' });
    });

    test('Tailwind 3 with a config file', () => {
        const dir = project({ devDependencies: { tailwindcss: '^3.4.0' } }, ['tailwind.config.mjs']);
        expect(detectTailwind(dir)).toEqual({ major: 3, via: 'tailwind.config.mjs' });
    });

    test('the old Astro integration also counts', () => {
        const dir = project({ dependencies: { '@astrojs/tailwind': '^5.0.0' } });
        expect(detectTailwind(dir)?.via).toBe('@astrojs/tailwind');
    });

    test('without package.json it decides by the file', () => {
        expect(detectTailwind(project(null, ['tailwind.config.js']))).toEqual({ major: null, via: 'tailwind.config.js' });
        expect(detectTailwind(project(null))).toBeNull();
    });
});
