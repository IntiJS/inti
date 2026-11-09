import { describe, test, expect } from 'bun:test';
import {
    isBlockVisible,
    visibleBlocks,
    hiddenBlocks,
    hiddenReason
} from '../src/blocks/visibility.js';
import type { IntiBlock } from '../src/types/index.js';

// ============================================
// Helpers
// ============================================

const NOW = new Date('2026-06-15T12:00:00.000Z');

function block(meta?: IntiBlock['meta'], type = 'Hero'): IntiBlock {
    return { type, data: {}, meta };
}

// ============================================
// The explicit switch
// ============================================

describe('isBlockVisible — visible', () => {
    test('without meta it counts as visible', () => {
        expect(isBlockVisible({ type: 'Hero', data: {} }, NOW)).toBe(true);
    });

    test('visible: false hides it', () => {
        expect(isBlockVisible(block({ visible: false }), NOW)).toBe(false);
    });

    test('visible: true shows it', () => {
        expect(isBlockVisible(block({ visible: true }), NOW)).toBe(true);
    });

    test('visible: false overrides a valid window', () => {
        const b = block({
            visible: false,
            visibleFrom: '2026-01-01T00:00:00.000Z',
            visibleUntil: '2026-12-31T00:00:00.000Z'
        });
        expect(isBlockVisible(b, NOW)).toBe(false);
    });
});

// ============================================
// The date window
// ============================================

describe('isBlockVisible — scheduled window', () => {
    test('a block scheduled for the future is not shown', () => {
        // This is the case that matters: publishing a promotion before its date
        // is a commercial promise the client had not made.
        expect(isBlockVisible(block({ visibleFrom: '2026-07-01T00:00:00.000Z' }), NOW)).toBe(false);
    });

    test('a block whose date has arrived is shown', () => {
        expect(isBlockVisible(block({ visibleFrom: '2026-01-01T00:00:00.000Z' }), NOW)).toBe(true);
    });

    test('an expired block is not shown', () => {
        expect(isBlockVisible(block({ visibleUntil: '2026-05-01T00:00:00.000Z' }), NOW)).toBe(false);
    });

    test('a block inside its window is shown', () => {
        const b = block({
            visibleFrom: '2026-06-01T00:00:00.000Z',
            visibleUntil: '2026-06-30T00:00:00.000Z'
        });
        expect(isBlockVisible(b, NOW)).toBe(true);
    });

    test('an unreadable date is ignored instead of hiding live content', () => {
        // Hiding what is published because of malformed data is a worse
        // regression than showing it; the explicit switch is
        // `visible`, and that one is not interpreted.
        expect(isBlockVisible(block({ visibleFrom: 'next week' }), NOW)).toBe(true);
        expect(isBlockVisible(block({ visibleUntil: '' }), NOW)).toBe(true);
    });
});

// ============================================
// Filtering lists
// ============================================

describe('visibleBlocks', () => {
    const list: IntiBlock[] = [
        block({ index: 0 }, 'Hero'),
        block({ index: 1, visible: false }, 'Promo'),
        block({ index: 2, visibleFrom: '2026-07-01T00:00:00.000Z' }, 'Future'),
        block({ index: 3 }, 'Footer')
    ];

    test('leaves out the hidden and the scheduled ones', () => {
        expect(visibleBlocks(list, NOW).map((b) => b.type)).toEqual(['Hero', 'Footer']);
    });

    test('does NOT renumber meta.index', () => {
        // `meta.index` is the address the editor and the actions use to
        // locate the block in the CMS. If filtering renumbered, editing a
        // block after a hidden one would write to the wrong block.
        expect(visibleBlocks(list, NOW).map((b) => b.meta?.index)).toEqual([0, 3]);
    });

    test('hiddenBlocks returns exactly the complement', () => {
        expect(hiddenBlocks(list, NOW).map((b) => b.type)).toEqual(['Promo', 'Future']);
        expect(visibleBlocks(list, NOW).length + hiddenBlocks(list, NOW).length).toBe(list.length);
    });

    test('an empty list breaks nothing', () => {
        expect(visibleBlocks([], NOW)).toEqual([]);
    });
});

// ============================================
// The reason, so as not to lose half an hour debugging
// ============================================

describe('hiddenReason', () => {
    test('a visible block has no reason', () => {
        expect(hiddenReason(block({ visible: true }), NOW)).toBeNull();
    });

    test('explains the CMS switch', () => {
        expect(hiddenReason(block({ visible: false }), NOW)).toMatch(/hidden/i);
    });

    test('explains the scheduling and includes the date', () => {
        const reason = hiddenReason(block({ visibleFrom: '2026-07-01T00:00:00.000Z' }), NOW);
        expect(reason).toMatch(/scheduled/i);
        expect(reason).toContain('2026-07-01');
    });

    test('explains the expiry and includes the date', () => {
        const reason = hiddenReason(block({ visibleUntil: '2026-05-01T00:00:00.000Z' }), NOW);
        expect(reason).toMatch(/expir/i);
        expect(reason).toContain('2026-05-01');
    });
});
