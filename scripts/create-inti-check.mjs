#!/usr/bin/env node
/**
 * Checks that `npm create inti` produces a project that works.
 *
 * It exists because the previous create-inti did not work in any case: it
 * offered templates that did not exist, packages that did not exist and a
 * page that imported a class @intijs/core does not export. Nobody had run it.
 *
 * 1. Packs the packages with `npm pack`, create-inti included: this tests
 *    what would be published, including which files go into the package.
 * 2. Runs create-inti from its tarball for each CMS and builds the
 *    project. With no real CMS reachable, WordPress, Kitsuden and Strapi are
 *    only built.
 * 3. With the local store, which needs nothing external, it does the full
 *    walkthrough: in development the page loads with the editor and an edit
 *    is saved to disk; in production the visitor gets neither JavaScript nor
 *    the editor, and an anonymous write is rejected.
 *
 * Usage: node scripts/create-inti-check.mjs [--keep]
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const win = process.platform === 'win32';

const PACKAGES = [
    'packages/core',
    'packages/adapter-wordpress',
    'packages/adapter-kitsuden',
    'packages/adapter-strapi',
    'packages/adapter-keystatic',
    'packages/create-inti'
];
const CMS = ['local', 'wordpress', 'kitsuden', 'strapi', 'keystatic'];

function run(command, args, cwd, label) {
    process.stdout.write(`\n$ ${command} ${args.join(' ')}\n`);
    try {
        execFileSync(command, args, { cwd, stdio: 'inherit', shell: win });
    } catch {
        throw new Error(`failed: ${label}`);
    }
}

function pack(packageDir, destination) {
    const output = execFileSync('npm', ['pack', '--json', '--pack-destination', destination], {
        cwd: join(ROOT, packageDir),
        encoding: 'utf8',
        shell: win
    });
    // `prepare` may write earlier to the same output
    const json = JSON.parse(output.slice(output.search(/^\[\s*$/m)));
    return { name: json[0].name, path: join(destination, json[0].filename) };
}

/** Starts a server process and returns how to stop it and read its log */
function serve(command, args, cwd, env) {
    let log = '';
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: win, detached: !win });
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    return {
        log: () => log,
        stop() {
            try {
                if (win) execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
                else process.kill(-child.pid, 'SIGTERM');
            } catch {
                // it had already exited
            }
        }
    };
}

async function waitFor(url, server, seconds = 90) {
    for (let i = 0; i < seconds; i++) {
        try {
            const res = await fetch(url);
            if (res.status < 500) return;
        } catch {
            // starting
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`${url} did not respond\n${server.log().slice(-1500)}`);
}

function readHeading(project) {
    const store = JSON.parse(readFileSync(join(project, '.inti/content.json'), 'utf8'));
    return store.documents.home.blocks[0].data.heading;
}

async function editInDev(project) {
    const base = 'http://127.0.0.1:43401';
    const server = serve('npx', ['astro', 'dev', '--port', '43401', '--host', '127.0.0.1'], project, {});
    try {
        await waitFor(base + '/', server);
        // Let Vite finish optimizing before evaluating the page
        for (let i = 0; i < 60 && !(await fetch(base + '/@vite/client')).ok; i++) {
            await new Promise((r) => setTimeout(r, 1000));
        }

        const html = await (await fetch(base + '/')).text();
        const failures = [];
        if (!html.includes('Double-click this heading')) failures.push('the page does not show the sample content');
        if (!html.includes('data-inti-inline-editor')) failures.push('the editor is not on the page');
        if (!html.includes('data-inti-field="heading"')) failures.push('the sample field is not editable');
        if (failures.length) throw new Error(failures.join('\n  '));

        // The same request the editor makes when Enter is pressed
        const res = await fetch(base + '/_actions/inti.updateBlockField', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentId: 'home', blockIndex: 0, field: 'heading', value: 'Edited by the test' })
        });
        if (!res.ok) throw new Error(`the edit responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
        if (readHeading(project) !== 'Edited by the test') throw new Error('the edit did not reach .inti/content.json');

        const after = await (await fetch(base + '/')).text();
        if (!after.includes('Edited by the test')) throw new Error('the page does not show the change after saving it');

        console.log('\n✓ local: in development the page loads with the editor and an edit is saved to disk');
    } finally {
        server.stop();
    }
}

/** Keystatic needs no server: it can really be edited and the file inspected */
async function editKeystatic(project) {
    const base = 'http://127.0.0.1:43403';
    const server = serve('npx', ['astro', 'dev', '--port', '43403', '--host', '127.0.0.1'], project, { INTI_ADAPTER: 'keystatic' });
    try {
        await waitFor(base + '/', server);

        const html = await (await fetch(base + '/')).text();
        if (!html.includes('Double-click this heading')) throw new Error('the page does not show content/pages/home.yaml');
        if (!html.includes('data-inti-inline-editor')) throw new Error('the editor is not on the page');

        const res = await fetch(base + '/_actions/inti.updateBlockField', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentId: 'home', blockIndex: 0, field: 'heading', value: 'Edited by the test' })
        });
        if (!res.ok) throw new Error(`the edit responded ${res.status}: ${(await res.text()).slice(0, 300)}`);

        const file = readFileSync(join(project, 'content/pages/home.yaml'), 'utf8');
        if (!file.includes('Edited by the test')) throw new Error('the edit did not reach content/pages/home.yaml');
        if (!file.includes('discriminant: hero')) throw new Error('the file lost its Keystatic format');

        console.log('\n✓ keystatic: an edit is saved to its file, in its format');
    } finally {
        server.stop();
    }
}

async function checkProduction(project) {
    const base = 'http://127.0.0.1:43402';
    const server = serve('node', ['./dist/server/entry.mjs'], project, {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '43402'
    });
    try {
        await waitFor(base + '/', server);

        const res = await fetch(base + '/');
        const html = await res.text();
        const failures = [];
        if (res.status !== 200) failures.push(`the page responds ${res.status}`);
        if (!html.includes('Edited by the test')) failures.push('it does not read the saved content');
        if (/<script[^>]*type="module"/.test(html)) failures.push('the visitor receives JavaScript');
        if (html.includes('data-inti-inline-editor')) failures.push('the visitor receives the editor');
        if (!html.includes('<title>My site with Inti</title>')) failures.push('the SEO title does not come from the content');

        const missing = await fetch(base + '/does-not-exist');
        if (missing.status !== 404) failures.push(`a nonexistent page responds ${missing.status}, not 404`);

        const write = await fetch(base + '/_actions/inti.updateBlockField', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ documentId: 'home', blockIndex: 0, field: 'heading', value: 'ANONYMOUS' })
        });
        if (write.ok) failures.push('an anonymous write was accepted');
        if (readHeading(project) === 'ANONYMOUS') failures.push('an anonymous write reached disk');

        if (failures.length) throw new Error(failures.join('\n  '));
        console.log('✓ local: in production, no JS for the visitor, correct 404 and anonymous write rejected');
    } finally {
        server.stop();
    }
}

// ============================================
// Run
// ============================================

const workdir = realpathSync.native(mkdtempSync(join(tmpdir(), 'create-inti-check-')));
const tarballDir = join(workdir, 'tarballs');
mkdirSync(tarballDir);
console.log(`Working directory: ${workdir}`);

let ok = false;
try {
    const tarballs = Object.fromEntries(PACKAGES.map((dir) => {
        const { name, path } = pack(dir, tarballDir);
        return [name, path];
    }));

    for (const cms of CMS) {
        console.log(`\n=== create-inti --cms ${cms} ===`);
        const name = `site-${cms}`;

        // From the tarball: if a file is missing from `files`, it fails here
        run('npx', ['--yes', '--package', tarballs['create-inti'], 'create-inti', name, '--cms', cms, '--no-install', '--packages', tarballDir], workdir, `create-inti --cms ${cms}`);

        const project = join(workdir, name);
        const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
        // @intijs is not published yet: `--packages` has to point every @intijs
        // dependency at its tarball. This is the path the README documents.
        for (const [dep, spec] of Object.entries(pkg.dependencies)) {
            if (!dep.startsWith('@intijs/')) continue;
            if (!tarballs[dep]) throw new Error(`the project depends on ${dep}, which does not exist in the repo`);
            if (!spec.startsWith('file:')) throw new Error(`${dep} is "${spec}": --packages did not point it at its tarball`);
        }

        run('npm', ['install', '--no-audit', '--no-fund'], project, `npm install (${cms})`);
        run('npx', ['astro', 'build'], project, `astro build (${cms})`);
        console.log(`\n✓ ${cms}: the generated project builds`);

        if (cms === 'local') {
            await editInDev(project);
            await checkProduction(project);
        }
        if (cms === 'keystatic') await editKeystatic(project);
    }

    ok = true;
    console.log('\n✓ create-inti generates projects that work');
} catch (error) {
    console.error(`\n✗ ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
} finally {
    if (keep || !ok) console.log(`\n(${ok ? '--keep' : 'failure'}) projects kept at ${workdir}`);
    else rmSync(workdir, { recursive: true, force: true });
}
