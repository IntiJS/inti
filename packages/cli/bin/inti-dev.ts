#!/usr/bin/env bun

import { syncCommand } from '../src/commands/sync.ts';
import { devCommand } from '../src/commands/dev.ts';

const args = process.argv.slice(2);
const command = args[0];

async function main() {
    switch (command) {
        case 'sync':
            await syncCommand();
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
  bun inti sync              # Sync types from configured CMS

For more information, visit: https://github.com/intijs/inti
            `);
            break;
    }
}

main().catch(console.error);
