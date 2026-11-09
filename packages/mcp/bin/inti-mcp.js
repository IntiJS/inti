#!/usr/bin/env node
import { startServer } from '../dist/server.js';

startServer().catch((error) => {
    process.stderr.write(`[inti-mcp] Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
