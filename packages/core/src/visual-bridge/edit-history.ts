/**
 * History of this tab's text edits, for undo and redo.
 *
 * An inline edit is saved to the CMS instantly, and without this a mistake
 * meant remembering what it said before. Undo is another write with the
 * previous value: it goes through the same permissions and lands in the same audit log.
 *
 * It keeps only what it needs to repeat the write; the DOM element is supplied
 * by the caller, because this class does not touch the browser.
 */

export interface EditRecord<Target = unknown> {
    documentId: string;
    blockIndex: number;
    field: string;
    previous: string;
    value: string;
    target: Target;
}

const LIMIT = 100;

export class EditHistory<Target = unknown> {
    private done: EditRecord<Target>[] = [];
    private undone: EditRecord<Target>[] = [];

    /** A new edit invalidates whatever could be redone */
    record(edit: EditRecord<Target>): void {
        this.done.push(edit);
        if (this.done.length > LIMIT) this.done.shift();
        this.undone = [];
    }

    get canUndo(): boolean {
        return this.done.length > 0;
    }

    get canRedo(): boolean {
        return this.undone.length > 0;
    }

    /**
     * Takes the last edit and applies it with `write`. If the write fails, the
     * edit stays where it was: it can be retried.
     */
    async undo(write: (edit: EditRecord<Target>, value: string) => Promise<void>): Promise<EditRecord<Target> | null> {
        const edit = this.done.pop();
        if (!edit) return null;

        try {
            await write(edit, edit.previous);
        } catch (error) {
            this.done.push(edit);
            throw error;
        }

        this.undone.push(edit);
        return edit;
    }

    async redo(write: (edit: EditRecord<Target>, value: string) => Promise<void>): Promise<EditRecord<Target> | null> {
        const edit = this.undone.pop();
        if (!edit) return null;

        try {
            await write(edit, edit.value);
        } catch (error) {
            this.undone.push(edit);
            throw error;
        }

        this.done.push(edit);
        return edit;
    }
}
