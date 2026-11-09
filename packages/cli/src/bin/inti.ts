#!/usr/bin/env node

import { syncCommand } from '../commands/sync.js';
import { devCommand } from '../commands/dev.js';

const args = process.argv.slice(2);
const command = args[0];

async function main() {
    switch (command) {
        case 'sync':
            await syncCommand();
            break;
        case 'dev':
            await devCommand();
            break;
        case 'help':
        default:
            console.log(`
Inti.js CLI — visual editing layer for Astro

Commands:
  inti sync    Generate TypeScript types from your CMS schema
  inti dev     Start development server with hot reload
  inti help    Show this help message

Examples:
  inti sync
  inti dev --port 3000
            `);
            break;
    }
}

main().catch(console.error);
