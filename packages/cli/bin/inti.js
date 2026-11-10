#!/usr/bin/env node

import { syncCommand } from '../dist/commands/sync.js';
import { devCommand } from '../dist/commands/dev.js';

const args = process.argv.slice(2);
const command = args[0];

/**
 * Value of a flag: `--config path` or `--config=path`. The help advertised
 * `--config` from the start, but it was never read: `sync` always used
 * ./inti.config.ts.
 */
function flag(name) {
    const prefix = `--${name}=`;
    const inline = args.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
    switch (command) {
        case 'sync':
            await syncCommand(flag('config'));
            break;
        case 'dev':
            await devCommand(args.slice(1));
            break;
        case 'help':
        case '--help':
        case '-h':
        default:
            console.log(`
╔══════════════════════════════════════════════════════════╗
║        Inti.js CLI — visual editing layer for Astro      ║
╚══════════════════════════════════════════════════════════╝

Commands:
  inti sync    Generate TypeScript types from CMS schema
  inti dev     Run "astro dev" (its arguments are passed through)
  inti help    Show this help message

Examples:
  npx @intijs/cli sync                              # Types from ./inti.config.ts
  npx @intijs/cli sync --config ./config/inti.ts    # Use another config file

For more information, visit: https://github.com/intijs/inti
            `);
            break;
    }
}

main().catch(console.error);
