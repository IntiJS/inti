import { describe, test, expect } from 'bun:test';

import { EditHistory } from '../src/visual-bridge/edit-history.js';

const edit = (previous: string, value: string) => ({
    documentId: 'home',
    blockIndex: 0,
    field: 'heading',
    previous,
    value,
    target: null
});

describe('EditHistory', () => {
    test('undo writes the previous value, and redo the new one', async () => {
        const history = new EditHistory<null>();
        const written: string[] = [];
        const write = async (_: unknown, value: string) => void written.push(value);

        history.record(edit('A', 'B'));
        await history.undo(write);
        await history.redo(write);

        expect(written).toEqual(['A', 'B']);
    });

    test('undoes in reverse order', async () => {
        const history = new EditHistory<null>();
        const written: string[] = [];
        const write = async (_: unknown, value: string) => void written.push(value);

        history.record(edit('A', 'B'));
        history.record(edit('B', 'C'));
        await history.undo(write);
        await history.undo(write);

        expect(written).toEqual(['B', 'A']);
        expect(history.canUndo).toBe(false);
    });

    test('a new edit invalidates what could be redone', async () => {
        const history = new EditHistory<null>();
        history.record(edit('A', 'B'));
        await history.undo(async () => {});
        expect(history.canRedo).toBe(true);

        history.record(edit('A', 'C'));
        expect(history.canRedo).toBe(false);
    });

    test('if the write fails, the edit is kept to retry', async () => {
        const history = new EditHistory<null>();
        history.record(edit('A', 'B'));

        await expect(
            history.undo(async () => {
                throw new Error('403');
            })
        ).rejects.toThrow('403');

        expect(history.canUndo).toBe(true);
        expect(history.canRedo).toBe(false);
    });

    test('with no history it writes nothing', async () => {
        let writes = 0;
        expect(await new EditHistory<null>().undo(async () => void writes++)).toBeNull();
        expect(writes).toBe(0);
    });
});
