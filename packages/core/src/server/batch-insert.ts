/**
 * Inserting several blocks when the adapter cannot do it as a batch.
 *
 * It lives outside `actions/` on purpose: that module imports `astro:actions`
 * and cannot be loaded in a test. The rollback is exactly the part worth
 * having tested, so it stays here.
 */
import type { WriteResult } from '../adapters/index.js';

export interface PendingBlock {
    nativeType: string;
    data?: Record<string, any>;
}

/** The minimum an adapter must offer to insert in sequence */
export interface SequentialInsertAdapter {
    name: string;
    insertBlock?(
        documentId: string,
        index: number,
        nativeType: string,
        data?: Record<string, any>
    ): Promise<WriteResult>;
    removeBlock?(documentId: string, index: number): Promise<WriteResult>;
}

/**
 * N writes, rolled back if one fails.
 *
 * It is not truly atomic —the rollback can fail in turn— but it turns
 * "page silently broken" into "nothing happened" or, at worst, into an
 * error that says exactly what was left half done.
 */
export async function sequentialInsertWithRollback(
    adapter: SequentialInsertAdapter,
    documentId: string,
    index: number,
    blocks: PendingBlock[]
): Promise<WriteResult> {
    if (!adapter.insertBlock) {
        throw new Error(`The "${adapter.name}" adapter does not support inserting blocks.`);
    }

    let inserted = 0;

    try {
        for (const block of blocks) {
            const step = await adapter.insertBlock(
                documentId,
                index + inserted,
                block.nativeType,
                block.data
            );
            if (!step.success) {
                throw new Error(step.error || `Failed inserting "${block.nativeType}"`);
            }
            inserted++;
        }
        return { success: true, documentId };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // Nothing written: the failure is reported as is, with nothing to roll back.
        if (inserted === 0) return { success: false, documentId, error: message };

        if (!adapter.removeBlock) {
            throw new Error(
                `${message}. ${inserted} of ${blocks.length} blocks were inserted and the ` +
                `"${adapter.name}" adapter cannot remove them: check document ${documentId} by hand.`
            );
        }

        // Back to front: removing the first one would shift the rest.
        for (let offset = inserted - 1; offset >= 0; offset--) {
            try {
                const undo = await adapter.removeBlock(documentId, index + offset);
                if (!undo.success) throw new Error(undo.error || 'rollback rejected');
            } catch {
                throw new Error(
                    `${message}. The rollback also failed: document ${documentId} may ` +
                    `have been left with extra blocks from position ${index} on.`
                );
            }
        }

        throw new Error(`${message}. No block was inserted (what was written was rolled back).`);
    }
}
