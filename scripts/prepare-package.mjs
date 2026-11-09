#!/usr/bin/env node
/**
 * `prepare` for the publishable packages: builds `dist/` when installing from git.
 *
 * `dist/` is not versioned, so a git dependency
 * (`pnpm add "github:intijs/inti#<commit>&path:/packages/core"`)
 * arrived without executable code. pnpm clones the ENTIRE repository, installs
 * the workspace with npm at the root and runs `prepare` inside the requested
 * package; then it packs only that package according to its `files`. This
 * script is that `prepare`.
 *
 * Three cases:
 *
 * - `npm install` at the monorepo root: npm runs every workspace's
 *   `prepare`, in no particular order. Nothing is built here (`npm run build`
 *   does it, in order): building core from five `prepare` scripts at once
 *   is a race over the same files. It is detected because `INIT_CWD`
 *   (where the package manager was launched) is the repository root.
 * - Install from git: `INIT_CWD` is the package folder. The internal
 *   packages it depends on that do not have `dist/` yet are built first
 *   (the adapters import the types from `@intijs/core`), and then the
 *   package itself with its `build` script.
 * - `INTI_SKIP_PREPARE=1`: does nothing.
 *
 * Usage (in each package's package.json):
 *   "prepare": "node ../../scripts/prepare-package.mjs"
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = join(ROOT, 'packages');
const pkgDir = process.cwd();

function log(message) {
    console.log(`[inti prepare] ${message}`);
}

/** Compares paths regardless of case or separators (Windows) */
function samePath(a, b) {
    const norm = (p) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();
    return norm(a) === norm(b);
}

function readManifest(dir) {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

/** Package name → folder, for the packages of this monorepo */
function workspacePackages() {
    const byName = new Map();
    for (const entry of readdirSync(PACKAGES)) {
        const dir = join(PACKAGES, entry);
        if (!existsSync(join(dir, 'package.json'))) continue;
        byName.set(readManifest(dir).name, dir);
    }
    return byName;
}

function build(dir) {
    const manifest = readManifest(dir);
    if (!manifest.scripts?.build) return;
    log(`building ${manifest.name}`);
    execSync('npm run build', { cwd: dir, stdio: 'inherit' });
}

if (process.env.INTI_SKIP_PREPARE === '1') {
    log('INTI_SKIP_PREPARE=1, skipping');
    process.exit(0);
}

if (process.env.INIT_CWD && samePath(process.env.INIT_CWD, ROOT)) {
    // Install of the monorepo itself: it is built with `npm run build`
    process.exit(0);
}

const manifest = readManifest(pkgDir);
const internal = workspacePackages();
const deps = {
    ...manifest.peerDependencies,
    ...manifest.dependencies,
    ...manifest.devDependencies
};

for (const name of Object.keys(deps)) {
    const dir = internal.get(name);
    if (!dir || samePath(dir, pkgDir)) continue;
    if (existsSync(join(dir, 'dist'))) continue;
    build(dir);
}

build(pkgDir);
