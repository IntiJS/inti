import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * MIT / Enterprise boundary.
 *
 * Everything in this repository is MIT. The commercial team features
 * (`@intijs/ee`) live in a separate, private repository. If an MIT package
 * imported them, or declared them as a dependency, whoever installs the MIT
 * core would end up running code under another license without knowing it.
 * The direction is always ee → core, through the public plugin API.
 */

const ROOT = join(import.meta.dir, '..', '..', '..');
const SCANNED = ['packages', 'apps'];
const CODE = /\.(ts|tsx|js|mjs|cjs|astro|svelte|vue)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro']);

/** A real import (not a comment) of @intijs/ee or of the ee folder */
const IMPORTS_EE = /^\s*(?:import|export)\b[^;]*?from\s*['"](?:@intijs\/ee(?:\/[^'"]*)?|(?:\.\.\/)+ee(?:\/[^'"]*)?)['"]|\b(?:import|require)\s*\(\s*['"](?:@intijs\/ee(?:\/[^'"]*)?|(?:\.\.\/)+ee(?:\/[^'"]*)?)['"]/m;

function* files(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
        if (SKIP_DIRS.has(entry)) continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) yield* files(path);
        else yield path;
    }
}

const mitPackages = (): string[] =>
    SCANNED.flatMap((base) =>
        readdirSync(join(ROOT, base))
            .map((name) => join(ROOT, base, name))
            .filter((dir) => existsSync(join(dir, 'package.json')))
            .filter((dir) => relative(ROOT, dir).replace(/\\/g, '/') !== 'packages/ee')
    );

describe('MIT / ee boundary', () => {
    test('no MIT package or app imports @intijs/ee', () => {
        const offenders: string[] = [];
        for (const dir of mitPackages()) {
            for (const file of files(dir)) {
                if (!CODE.test(file)) continue;
                if (file === import.meta.path) continue; // its own examples
                if (IMPORTS_EE.test(readFileSync(file, 'utf8'))) offenders.push(relative(ROOT, file));
            }
        }
        expect(offenders).toEqual([]);
        // It reads every source file of the repository: on a loaded machine that
        // takes longer than the default 5 s, and a timeout is not a boundary violation.
    }, 60_000);

    test('no MIT package declares @intijs/ee as a dependency', () => {
        const offenders: string[] = [];
        for (const dir of mitPackages()) {
            const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
            for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
                if (manifest[field]?.['@intijs/ee']) offenders.push(`${manifest.name} (${field})`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('every package in this repository is MIT', () => {
        const offenders: string[] = [];
        for (const dir of mitPackages().filter((d) => relative(ROOT, d).startsWith('packages'))) {
            const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
            if (manifest.license !== 'MIT') offenders.push(`${manifest.name} (${manifest.license})`);
        }
        expect(offenders).toEqual([]);
    });

    test('the detector recognizes a real import and not a comment', () => {
        expect(IMPORTS_EE.test("import { initEnterprise } from '@intijs/ee';")).toBe(true);
        expect(IMPORTS_EE.test("const ee = await import('../../ee/src/index.js');")).toBe(true);
        expect(IMPORTS_EE.test(' * Core NEVER imports @intijs/ee.')).toBe(false);
    });
});
