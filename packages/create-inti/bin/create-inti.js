#!/usr/bin/env node
/**
 * create-inti — creates an Astro project with Inti.
 *
 *   npm create inti@latest
 *   npm create inti@latest my-site -- --cms wordpress
 *   npx create-inti my-site --cms local --yes --no-install
 *
 * Without an interactive terminal (CI) or with --yes it asks nothing: it uses the
 * flag values, and for anything missing, the defaults.
 */

import { intro, outro, text, select, confirm, isCancel, cancel } from '@clack/prompts';
import pc from 'picocolors';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

import { CMS, CMS_IDS, generateProject, nodeVersionError, validateName } from '../lib/generate.js';

const DEFAULT_NAME = 'my-inti-site';
const DEFAULT_CMS = 'local';
const DOCS = 'https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/guides/quickstart.mdx';

// ============================================
// Arguments
// ============================================

function parseArgs(argv) {
    const args = { name: undefined, cms: undefined, yes: false, install: true, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--yes' || arg === '-y') args.yes = true;
        else if (arg === '--no-install') args.install = false;
        else if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg === '--cms') args.cms = argv[++i];
        else if (arg.startsWith('--cms=')) args.cms = arg.slice('--cms='.length);
        else if (arg.startsWith('-')) fail(`Unknown option: ${arg}`);
        else if (!args.name) args.name = arg;
        else fail(`Extra argument: ${arg}`);
    }
    return args;
}

function fail(message) {
    console.error(pc.red(`✗ ${message}`));
    process.exit(1);
}

const HELP = `
${pc.bold('create-inti')} — creates an Astro project with Inti

${pc.bold('Usage')}
  npm create inti@latest [name] -- [options]
  npx create-inti [name] [options]

${pc.bold('Options')}
  --cms <${CMS_IDS.join('|')}>   CMS to connect to (default: ${DEFAULT_CMS})
  --yes, -y                  No prompts: use flags and defaults
  --no-install               Do not install dependencies
  --help, -h                 This help
`;

/** A folder that does not exist or is empty. Nothing is ever deleted. */
function targetError(dir) {
    if (!existsSync(dir)) return undefined;
    if (readdirSync(dir).length === 0) return undefined;
    return `The folder ${dir} already exists and is not empty`;
}

/** The package manager it was launched with (npm create, pnpm create…) */
function packageManager() {
    const agent = process.env.npm_config_user_agent ?? '';
    if (agent.startsWith('pnpm')) return 'pnpm';
    if (agent.startsWith('yarn')) return 'yarn';
    if (agent.startsWith('bun')) return 'bun';
    return 'npm';
}

// ============================================
// Main
// ============================================

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(HELP);
        return;
    }

    const nodeError = nodeVersionError(process.version);
    if (nodeError) fail(nodeError);

    if (args.cms !== undefined && !CMS[args.cms]) {
        fail(`Unknown CMS: "${args.cms}". Options: ${CMS_IDS.join(', ')}`);
    }
    if (args.name !== undefined) {
        const error = validateName(args.name);
        if (error) fail(`Invalid name: ${error}`);
    }

    // Without a terminal it cannot ask: it behaves like --yes
    const interactive = !args.yes && process.stdin.isTTY && process.stdout.isTTY;

    if (interactive) intro(pc.bgCyan(pc.black(' create-inti ')));

    let name = args.name;
    if (!name) {
        if (interactive) {
            name = await text({
                message: 'What is the project called?',
                placeholder: DEFAULT_NAME,
                defaultValue: DEFAULT_NAME,
                validate: (value) => (value ? validateName(value) : undefined)
            });
            if (isCancel(name)) return cancelled();
        } else {
            name = DEFAULT_NAME;
        }
    }

    const targetDir = resolve(name);
    const dirError = targetError(targetDir);
    if (dirError) fail(dirError);

    let cms = args.cms;
    if (!cms) {
        if (interactive) {
            cms = await select({
                message: 'Which CMS do you use?',
                initialValue: 'wordpress',
                options: CMS_IDS.map((id) => ({ value: id, label: CMS[id].label, hint: CMS[id].hint }))
            });
            if (isCancel(cms)) return cancelled();
        } else {
            cms = DEFAULT_CMS;
        }
    }

    let install = args.install;
    if (install && interactive) {
        install = await confirm({ message: 'Install dependencies?', initialValue: true });
        if (isCancel(install)) return cancelled();
    }

    // Write
    const files = generateProject({ name, cms });
    for (const [path, content] of Object.entries(files)) {
        const target = join(targetDir, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
    }
    console.log(pc.green(`✓ Project created in ${relative(process.cwd(), targetDir) || '.'} (${CMS[cms].label})`));

    // Install
    const pm = packageManager();
    let installed = false;
    if (install) {
        console.log(pc.cyan(`\nInstalling dependencies with ${pm}…`));
        const result = spawnSync(pm, ['install'], {
            cwd: targetDir,
            stdio: 'inherit',
            shell: process.platform === 'win32'
        });
        installed = result.status === 0;
        if (!installed) console.log(pc.yellow(`\nCould not install them. Run "${pm} install" inside the project.`));
    }

    // Next steps
    const steps = [`cd ${relative(process.cwd(), targetDir) || '.'}`];
    if (!installed) steps.push(`${pm} install`);
    if (cms !== 'local') steps.push('cp .env.example .env    # and fill in your CMS details');
    steps.push(`${pm} run dev`);

    const done = `${pc.bold('Next steps:')}\n${steps.map((s) => `  ${pc.cyan(s)}`).join('\n')}\n\n${pc.dim(`Guide: ${DOCS}`)}`;
    if (interactive) outro(done);
    else console.log(`\n${done}`);
}

function cancelled() {
    cancel('Cancelled');
    process.exit(0);
}

main().catch((error) => {
    console.error(pc.red('Error:'), error instanceof Error ? error.message : error);
    process.exit(1);
});
