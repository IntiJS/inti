#!/usr/bin/env node
/**
 * Creates an Inti project from this checkout, while the packages are not on npm.
 *
 *   git clone https://github.com/intijs/inti.git
 *   cd inti && npm install && npm run build && cd ..
 *   node inti/scripts/scaffold-local.mjs my-site        # same options as create-inti
 *
 * 1. Packs `@intijs/core` and the writable adapters with `npm pack` into
 *    `.inti/tarballs` of this checkout (ignored by git).
 * 2. Runs `packages/create-inti` in the folder it was called from, with
 *    `--packages` pointing at those tarballs: the generated project depends on
 *    them with `file:` instead of on the npm registry.
 *
 * It is the path `scripts/create-inti-check.mjs` checks in CI.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARBALLS = join(ROOT, '.inti', 'tarballs');
const win = process.platform === 'win32';

const PACKAGES = ['core', 'adapter-wordpress', 'adapter-kitsuden', 'adapter-strapi', 'adapter-keystatic'];

const args = process.argv.slice(2);
if (args.includes('--packages') || args.some((arg) => arg.startsWith('--packages='))) {
    console.error('✗ --packages is set by this script: call packages/create-inti/bin/create-inti.js directly to choose the folder.');
    process.exit(1);
}

const wantsHelp = args.includes('--help') || args.includes('-h');

if (!wantsHelp) {
    for (const name of PACKAGES) {
        if (!existsSync(join(ROOT, 'packages', name, 'dist'))) {
            console.error(`✗ packages/${name} is not built. Run "npm install" and "npm run build" in ${ROOT} first.`);
            process.exit(1);
        }
    }

    mkdirSync(TARBALLS, { recursive: true });
    console.log(`Packing the Inti packages into ${TARBALLS}…`);
    for (const name of PACKAGES) {
        // dist/ is already built: `prepare` would only compile it again
        execFileSync('npm', ['pack', '--silent', '--pack-destination', TARBALLS], {
            cwd: join(ROOT, 'packages', name),
            env: { ...process.env, INTI_SKIP_PREPARE: '1' },
            stdio: ['ignore', 'ignore', 'inherit'],
            shell: win
        });
    }
}

const result = spawnSync(
    process.execPath,
    [join(ROOT, 'packages', 'create-inti', 'bin', 'create-inti.js'), ...args, ...(wantsHelp ? [] : ['--packages', TARBALLS])],
    { stdio: 'inherit' }
);
process.exit(result.status ?? 1);
