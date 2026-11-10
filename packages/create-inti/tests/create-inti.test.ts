import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { CMS_IDS, generateProject, nodeVersionError, validateName, VERSIONS } from '../lib/generate.js';
import { LocalAdapter } from '../../core/src/adapters/local.js';

const BIN = resolve(import.meta.dir, '../bin/create-inti.js');
const dirs: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'create-inti-'));
    dirs.push(dir);
    return dir;
}

function run(cwd: string, ...args: string[]) {
    return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env } });
}

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ============================================
// Generator
// ============================================

describe('generateProject', () => {
    for (const cms of CMS_IDS) {
        describe(cms, () => {
            const files = generateProject({ name: 'my-site', cms });
            const pkg = JSON.parse(files['package.json']);

            test('the complete setup from AGENTS.md: no step is missing', () => {
                expect(files['astro.config.mjs']).toContain("output: 'server'");
                expect(files['astro.config.mjs']).toContain("adapter: node({ mode: 'standalone' })");
                expect(files['astro.config.mjs']).toContain('integrations: [inti()]');
                expect(files['src/actions/index.ts']).toContain('export const server = { inti: intiActions }');
                expect(files['src/pages/[...slug].astro']).toContain("registerBlocks(import.meta.glob('/src/blocks/*.astro'))");
                expect(files['src/pages/[...slug].astro']).toContain('<BlockRenderer blocks={page.blocks} page={page} />');
                expect(files['src/pages/[...slug].astro']).toContain('<VisualBridgeAuto />');
            });

            test('dependencies on the right package and on the Astro/node adapter pair', () => {
                expect(pkg.dependencies.astro).toBe(VERSIONS.astro);
                expect(pkg.dependencies['@astrojs/node']).toBe(VERSIONS.node);
                expect(pkg.dependencies['@intijs/core']).toBe(VERSIONS.inti);
                const adapters = Object.keys(pkg.dependencies).filter((d) => d.startsWith('@intijs/adapter-'));
                expect(adapters).toEqual(cms === 'local' ? [] : [`@intijs/adapter-${cms}`]);
            });

            test('no dependency points to a package that does not exist in the repo', () => {
                for (const dep of Object.keys(pkg.dependencies).filter((d) => d.startsWith('@intijs/'))) {
                    const dir = resolve(import.meta.dir, '../..', dep.replace('@intijs/', ''));
                    expect({ dep, exists: existsSync(join(dir, 'package.json')) }).toEqual({ dep, exists: true });
                }
            });

            test('the production plugin is documented in the middleware, and no permissive one is registered', () => {
                expect(files['src/middleware.ts']).toContain('registerIntiPlugin');
                // The whole example is commented out: without a plugin, production stays closed
                expect(files['src/middleware.ts']).not.toMatch(/^registerIntiPlugin/m);
            });

            test('credentials never carry PUBLIC_', () => {
                expect(Object.values(files).join('\n')).not.toMatch(/PUBLIC_INTI/);
            });

            test('.env stays out of the repository', () => {
                expect(files['.gitignore']).toMatch(/^\.env$/m);
            });
        });
    }

    test('LocalAdapter reads the sample local content', async () => {
        const dir = tmp();
        const file = join(dir, 'content.json');
        writeFileSync(file, generateProject({ name: 'x', cms: 'local' })['.inti/content.json']);

        const page = await new LocalAdapter({ file }).fetchPageBySlug('home');

        expect(page.blocks.map((b) => b.type)).toEqual(['Hero', 'Text']);
        // Each type in the sample content has its component
        const files = generateProject({ name: 'x', cms: 'local' });
        for (const block of page.blocks) expect(files[`src/blocks/${block.type}.astro`]).toBeDefined();
    });

    test('the sample block uses the file name each CMS produces', () => {
        expect(generateProject({ name: 'x', cms: 'wordpress' })['src/blocks/HeroBanner.astro']).toBeDefined();
        expect(generateProject({ name: 'x', cms: 'kitsuden' })['src/blocks/hero.astro']).toBeDefined();
        expect(generateProject({ name: 'x', cms: 'strapi' })['src/blocks/Hero.astro']).toBeDefined();
        expect(generateProject({ name: 'x', cms: 'keystatic' })['src/blocks/hero.astro']).toBeDefined();
    });

    test('the CMS connection works with variables injected at startup, not only at build time', () => {
        for (const cms of ['wordpress', 'kitsuden', 'strapi', 'keystatic']) {
            const module = generateProject({ name: 'x', cms })['src/lib/cms.ts'];
            expect(module).not.toMatch(/=\s*import\.meta\.env\./);
            expect(module).toContain("from '@intijs/core/server'");
        }
    });

    test('rejects an unknown CMS', () => {
        expect(() => generateProject({ name: 'x', cms: 'gremius' })).toThrow(/Unknown CMS/);
    });
});

describe('nodeVersionError', () => {
    test('accepts the minimum version and later ones', () => {
        for (const version of ['v22.12.0', 'v22.19.0', 'v23.0.0', 'v24.1.0']) expect(nodeVersionError(version)).toBeUndefined();
    });

    test('rejects earlier ones with a clear message', () => {
        for (const version of ['v18.20.0', 'v20.19.0', 'v22.11.0']) expect(nodeVersionError(version)).toContain(version);
    });

    test('the Astro version is pinned: an open range would change the Node version needed', () => {
        expect(VERSIONS.astro.startsWith('~')).toBe(true);
    });
});

describe('validateName', () => {
    test('accepts valid package names', () => {
        expect(validateName('my-site')).toBeUndefined();
        expect(validateName('site_2.0')).toBeUndefined();
    });
    test('rejects uppercase, spaces and empty', () => {
        expect(validateName('MySite')).toBeDefined();
        expect(validateName('my site')).toBeDefined();
        expect(validateName('')).toBeDefined();
        expect(validateName('../outside')).toBeDefined();
    });
});

// ============================================
// Command line
// ============================================

describe('bin/create-inti', () => {
    test('without a terminal it does not ask: creates the project from the flags', () => {
        const cwd = tmp();
        const result = run(cwd, 'my-site', '--cms', 'wordpress', '--no-install');

        expect(result.status).toBe(0);
        expect(existsSync(join(cwd, 'my-site/src/blocks/HeroBanner.astro'))).toBe(true);
        expect(JSON.parse(readFileSync(join(cwd, 'my-site/package.json'), 'utf8')).name).toBe('my-site');
    });

    test('--yes with no name uses the default name and CMS', () => {
        const cwd = tmp();
        const result = run(cwd, '--yes', '--no-install');

        expect(result.status).toBe(0);
        expect(existsSync(join(cwd, 'my-inti-site/.inti/content.json'))).toBe(true);
    });

    test('never deletes an existing folder with content', () => {
        const cwd = tmp();
        mkdirSync(join(cwd, 'taken'));
        writeFileSync(join(cwd, 'taken/important.txt'), 'do not delete me');

        const result = run(cwd, 'taken', '--yes', '--no-install');

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('is not empty');
        expect(readFileSync(join(cwd, 'taken/important.txt'), 'utf8')).toBe('do not delete me');
    });

    test('uses an existing empty folder', () => {
        const cwd = tmp();
        mkdirSync(join(cwd, 'empty'));
        expect(run(cwd, 'empty', '--yes', '--no-install').status).toBe(0);
    });

    test('rejects an unknown CMS without creating anything', () => {
        const cwd = tmp();
        const result = run(cwd, 'x', '--cms', 'gremius', '--no-install');

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Unknown CMS');
        expect(existsSync(join(cwd, 'x'))).toBe(false);
    });

    test('rejects an invalid name', () => {
        const result = run(tmp(), 'My Site', '--yes', '--no-install');
        expect(result.status).toBe(1);
    });

    test('--help describes the real options', () => {
        const result = run(tmp(), '--help');
        expect(result.status).toBe(0);
        for (const cms of CMS_IDS) expect(result.stdout).toContain(cms);
    });
});

// ============================================
// Local tarballs (while the packages are not on npm)
// ============================================

describe('--packages', () => {
    test('generateProject uses the given spec for each @intijs package and nothing else', () => {
        const files = generateProject({
            name: 'x',
            cms: 'wordpress',
            packages: {
                '@intijs/core': 'file:../t/intijs-core-0.1.0.tgz',
                '@intijs/adapter-wordpress': 'file:../t/intijs-adapter-wordpress-0.1.0.tgz'
            }
        });
        const deps = JSON.parse(files['package.json']).dependencies;

        expect(deps['@intijs/core']).toBe('file:../t/intijs-core-0.1.0.tgz');
        expect(deps['@intijs/adapter-wordpress']).toBe('file:../t/intijs-adapter-wordpress-0.1.0.tgz');
        expect(deps.astro).toBe(VERSIONS.astro);
    });

    test('points every @intijs dependency at its tarball, relative to the project', () => {
        const cwd = tmp();
        mkdirSync(join(cwd, 'tarballs'));
        for (const file of ['intijs-core-0.1.0.tgz', 'intijs-adapter-strapi-0.1.0.tgz', 'intijs-adapter-wordpress-0.1.0.tgz']) {
            writeFileSync(join(cwd, 'tarballs', file), '');
        }

        const result = run(cwd, 'site', '--cms', 'strapi', '--yes', '--no-install', '--packages', 'tarballs');
        expect(result.status).toBe(0);

        const deps = JSON.parse(readFileSync(join(cwd, 'site/package.json'), 'utf8')).dependencies;
        expect(deps['@intijs/core']).toBe('file:../tarballs/intijs-core-0.1.0.tgz');
        expect(deps['@intijs/adapter-strapi']).toBe('file:../tarballs/intijs-adapter-strapi-0.1.0.tgz');
        expect(deps['@intijs/adapter-wordpress']).toBeUndefined();
        for (const spec of [deps['@intijs/core'], deps['@intijs/adapter-strapi']]) {
            expect(existsSync(resolve(cwd, 'site', spec.slice('file:'.length)))).toBe(true);
        }
    });

    test('a missing tarball is an error and nothing is created', () => {
        const cwd = tmp();
        mkdirSync(join(cwd, 'tarballs'));
        writeFileSync(join(cwd, 'tarballs', 'intijs-core-0.1.0.tgz'), '');

        const result = run(cwd, 'site', '--cms', 'kitsuden', '--yes', '--no-install', '--packages', 'tarballs');

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('@intijs/adapter-kitsuden');
        expect(existsSync(join(cwd, 'site'))).toBe(false);
    });

    test('without --packages the project depends on the npm range', () => {
        const deps = JSON.parse(generateProject({ name: 'x', cms: 'local' })['package.json']).dependencies;
        expect(deps['@intijs/core']).toBe(VERSIONS.inti);
    });
});
