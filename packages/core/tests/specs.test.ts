import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { KitsudenAdapter } from '../../adapter-kitsuden/src/index.js';

/**
 * Nothing ran the root specifications (tests.json, tests.feature), so they
 * ended up describing things that no longer existed: a network SDK,
 * Bun.serve, WebSockets, client directives from the registry. This test
 * keeps that from happening again:
 *
 * - every scenario has to say which test verifies it, and that file
 *   has to exist;
 * - scenarios with `testLogic` are run as they are.
 */

const ROOT = resolve(import.meta.dir, '../../..');

interface Scenario {
    feature: string;
    scenario: string;
    verifiedBy?: string[];
    testLogic?: {
        adapter: string;
        mockInput: unknown;
        expectedResult: {
            throws?: string;
            title?: string;
            blocksLength?: number;
            blockType?: string;
            blockId?: string;
            blockIds?: string[];
        };
    };
}

const spec = JSON.parse(readFileSync(resolve(ROOT, 'tests.json'), 'utf8')) as { scenarios: Scenario[] };

/** The adapters a testLogic can name */
const ADAPTERS: Record<string, () => { parsePage(raw: any): any }> = {
    KitsudenAdapter: () => new KitsudenAdapter({ endpoint: 'https://cms.test' })
};

describe('tests.json', () => {
    test('has scenarios', () => {
        expect(spec.scenarios.length).toBeGreaterThan(0);
    });

    for (const scenario of spec.scenarios) {
        describe(scenario.scenario, () => {
            test('declares what verifies it, and that it exists', () => {
                expect(scenario.verifiedBy?.length ?? 0).toBeGreaterThan(0);
                for (const path of scenario.verifiedBy ?? []) {
                    expect({ path, exists: existsSync(resolve(ROOT, path)) }).toEqual({ path, exists: true });
                }
            });

            const logic = scenario.testLogic;
            if (!logic) return;

            test('its testLogic holds', () => {
                const create = ADAPTERS[logic.adapter];
                expect(create).toBeDefined();
                const adapter = create();
                const expected = logic.expectedResult;

                if (expected.throws) {
                    expect(() => adapter.parsePage(logic.mockInput)).toThrow(expected.throws);
                    return;
                }

                const page = adapter.parsePage(logic.mockInput);
                if (expected.title !== undefined) expect(page.title).toBe(expected.title);
                if (expected.blocksLength !== undefined) expect(page.blocks).toHaveLength(expected.blocksLength);
                if (expected.blockType !== undefined) expect(page.blocks[0].type).toBe(expected.blockType);
                if (expected.blockId !== undefined) expect(page.blocks[0].id).toBe(expected.blockId);
                if (expected.blockIds !== undefined) {
                    expect(page.blocks.map((b: { id: string }) => b.id)).toEqual(expected.blockIds);
                }
            });
        });
    }
});

describe('tests.feature', () => {
    const lines = readFileSync(resolve(ROOT, 'tests.feature'), 'utf8').split(/\r?\n/);
    const scenarios = lines
        .map((line, i) => ({ line: line.trim(), i }))
        .filter(({ line }) => /^Scenario( Outline)?:/.test(line));

    test('has scenarios', () => {
        expect(scenarios.length).toBeGreaterThan(0);
    });

    for (const { line, i } of scenarios) {
        test(`${line} declares what verifies it, and that it exists`, () => {
            // Tags go on the lines immediately before
            const tags: string[] = [];
            for (let j = i - 1; j >= 0 && lines[j].trim().startsWith('@'); j--) {
                tags.push(...lines[j].trim().split(/\s+/));
            }
            const paths = tags
                .filter((tag) => tag.startsWith('@verifiedBy:'))
                .map((tag) => tag.slice('@verifiedBy:'.length));

            expect(paths.length).toBeGreaterThan(0);
            for (const path of paths) {
                expect({ path, exists: existsSync(resolve(ROOT, path)) }).toEqual({ path, exists: true });
            }
        });
    }
});
