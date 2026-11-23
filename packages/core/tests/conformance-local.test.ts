import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { LocalAdapter } from '../src/adapters/local.js';
import { adapterConformance } from '../src/testing/index.js';

async function seeded() {
    const local = new LocalAdapter({ file: join(tmpdir(), `inti-conformance-${Math.random().toString(36).slice(2)}.json`) });
    await local.putDocument({
        id: 'home',
        slug: 'home',
        title: 'Home',
        blocks: [
            { type: 'Hero', data: { heading: 'Welcome' } },
            { type: 'Text', data: { body: 'Text' } }
        ]
    });
    return local;
}

adapterConformance({ describe, test, expect }, { name: 'LocalAdapter', create: seeded, existingSlug: 'home', writableField: 'heading' });
