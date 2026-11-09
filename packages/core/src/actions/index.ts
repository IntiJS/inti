import { defineAction, ActionError } from 'astro:actions';
import { z } from 'astro:schema';
import { isDraftableAdapter, isSearchableAdapter } from '../adapters/index.js';
import type { DraftResult, WriteResult, EntrySummary } from '../adapters/index.js';
import { resolveWriteAdapter } from '../server/write-adapter.js';
import {
    resolveActor,
    runBeforeWrite,
    runAfterWrite,
    resolvePatternStore,
    resolveBlockGenerator,
    hasWriteGuard
} from '../plugins/index.js';
import type { WriteContext, Pattern, GeneratorBlockType } from '../plugins/index.js';
import { checkWriteAccess } from '../server/access.js';
import { sequentialInsertWithRollback } from '../server/batch-insert.js';
import type { PendingBlock } from '../server/batch-insert.js';

/**
 * A permission rejection has to reach the client as a 403.
 *
 * Astro turns any `Error` thrown by an action handler into a 500; only an
 * `ActionError` carries its own status. An anonymous write rejected by a
 * `beforeWrite` used to answer 500, and the editor (and any monitor) read
 * it as a server outage.
 */
function forbidden(reason: string | undefined, fallback: string): ActionError {
    return new ActionError({ code: 'FORBIDDEN', message: reason || fallback });
}

/** Default access control (see `server/access.ts`), as a 403 */
function requireWriteAccess(operation: string): void {
    const access = checkWriteAccess(operation, hasWriteGuard());
    if (!access.allowed) {
        throw forbidden(access.reason, 'Write denied');
    }
}

/** The adapter always exists: with no CMS configured, the local store is used */
async function requireAdapter() {
    const adapter = await resolveWriteAdapter();
    if (!adapter) {
        throw new Error(
            'No writable CMS adapter available. Check INTI_ADAPTER and its credentials.'
        );
    }
    return adapter;
}

async function requireDraftAdapter() {
    const adapter = await requireAdapter();
    if (!isDraftableAdapter(adapter)) {
        throw new Error(`The "${adapter.name}" adapter does not support drafts.`);
    }
    return adapter;
}

/**
 * Wraps a write with access control and plugin hooks.
 *
 * In development, and with a guard plugin registered, the behavior is
 * the usual one. In production without a guard the write is rejected
 * before touching the CMS: see `server/access.ts` for why.
 */
async function guardedWrite<T extends WriteResult>(
    ctx: WriteContext,
    exec: () => Promise<T>,
    failMessage: string
): Promise<T> {
    requireWriteAccess(ctx.operation);

    ctx.actor = await resolveActor(ctx);

    const decision = await runBeforeWrite(ctx);
    if (!decision.allowed) {
        throw forbidden(decision.reason, 'Write denied');
    }

    const result = await exec();

    // Failures are reported too: an audit log wants to see the attempts
    // the CMS rejected, not only the ones that succeeded.
    await runAfterWrite(ctx, result);

    if (!result.success) {
        throw new Error(result.error || failMessage);
    }

    return result;
}

/**
 * Inserts several blocks as a single unit.
 *
 * Two properties that do not come for free:
 *
 * 1. **Per-block permissions, checked before writing.** A pattern cannot
 *    sneak in a block type the policy forbids just because it comes in
 *    company. If any of the blocks is denied, none is written.
 * 2. **Atomicity.** If the adapter can insert in batch, it is a single
 *    write. If not, the blocks are inserted in sequence and what was
 *    already written is rolled back when something fails, so half a
 *    pattern is never left published.
 */
async function guardedBatchInsert(
    documentId: string,
    index: number,
    blocks: PendingBlock[],
    context: ActionContext
): Promise<WriteResult> {
    requireWriteAccess('insertBlock');

    if (blocks.length === 0) {
        return { success: true, documentId };
    }

    // The per-block context reuses the 'insertBlock' operation: a policy
    // written for inserting blocks must still apply here. Inventing a new
    // operation would open a way around the permissions.
    const contexts: WriteContext[] = blocks.map((block, offset) => ({
        operation: 'insertBlock',
        documentId,
        blockIndex: index + offset,
        nativeType: block.nativeType,
        blockType: block.nativeType,
        data: block.data,
        request: context.request,
        cookies: context.cookies
    }));

    const actor = await resolveActor(contexts[0]);
    for (const ctx of contexts) {
        ctx.actor = actor;
        const decision = await runBeforeWrite(ctx);
        if (!decision.allowed) {
            throw forbidden(decision.reason, `Write denied for block "${ctx.nativeType}"`);
        }
    }

    const adapter = await requireAdapter();
    let result: WriteResult;

    if (adapter.insertBlocks) {
        result = await adapter.insertBlocks(documentId, index, blocks);
    } else {
        result = await sequentialInsertWithRollback(adapter, documentId, index, blocks);
    }

    for (const ctx of contexts) {
        await runAfterWrite(ctx, result);
    }

    if (!result.success) {
        throw new Error(result.error || 'Insert failed');
    }

    return result;
}

/** Request context Astro passes to an action handler */
interface ActionContext {
    request?: Request;
    cookies?: unknown;
}

export const intiActions = {
  /**
   * Inline-editing write-back: updates one field of a block
   * in the source CMS (WordPress, Strapi, or the local store).
   *
   * The client (VisualBridge's inline editor) calls this action;
   * the CMS credentials never leave the server.
   */
  updateBlockField: defineAction({
    input: z.object({
      documentId: z.string(),
      blockIndex: z.number().int(),
      // A dot-path with these keys would pollute Object.prototype in any adapter
      field: z.string().min(1).refine((field) => !/(^|\.)(__proto__|constructor|prototype)(\.|$)/.test(field), 'Invalid field path'),
      value: z.any()
    }),
    handler: async (input, context: ActionContext = {}): Promise<WriteResult> => {
      // Throw on failure so the client can rely on the HTTP status
      return guardedWrite(
        {
          operation: 'updateBlockField',
          documentId: input.documentId,
          blockIndex: input.blockIndex,
          field: input.field,
          value: input.value,
          request: context.request,
          cookies: context.cookies
        },
        async () => {
          const adapter = await requireAdapter();
          return adapter.updateBlockField(input.documentId, input.blockIndex, input.field, input.value);
        },
        'Write-back failed'
      );
    }
  }),

  /**
   * Block drag & drop: moves a block to another position.
   */
  moveBlock: defineAction({
    input: z.object({
      documentId: z.string(),
      fromIndex: z.number().int().min(0),
      toIndex: z.number().int().min(0)
    }),
    handler: async (input, context: ActionContext = {}): Promise<WriteResult> => {
      return guardedWrite(
        {
          operation: 'moveBlock',
          documentId: input.documentId,
          fromIndex: input.fromIndex,
          toIndex: input.toIndex,
          blockIndex: input.fromIndex,
          request: context.request,
          cookies: context.cookies
        },
        async () => {
          const adapter = await requireAdapter();
          if (!adapter.moveBlock) {
            throw new Error(`The "${adapter.name}" adapter does not support this operation.`);
          }
          return adapter.moveBlock(input.documentId, input.fromIndex, input.toIndex);
        },
        'Move failed'
      );
    }
  }),

  /**
   * Composition: inserts a new block at the given position.
   * `nativeType` is the CMS identifier (acf_fc_layout, uid, type).
   */
  insertBlock: defineAction({
    input: z.object({
      documentId: z.string(),
      index: z.number().int().min(0),
      nativeType: z.string().min(1),
      data: z.record(z.string(), z.any()).optional()
    }),
    handler: async (input, context: ActionContext = {}): Promise<WriteResult> => {
      return guardedWrite(
        {
          operation: 'insertBlock',
          documentId: input.documentId,
          blockIndex: input.index,
          nativeType: input.nativeType,
          blockType: input.nativeType,
          data: input.data,
          request: context.request,
          cookies: context.cookies
        },
        async () => {
          const adapter = await requireAdapter();
          if (!adapter.insertBlock) {
            throw new Error(`The "${adapter.name}" adapter does not support this operation.`);
          }
          return adapter.insertBlock(input.documentId, input.index, input.nativeType, input.data);
        },
        'Insert failed'
      );
    }
  }),

  /**
   * Composition: inserts several consecutive blocks as one unit.
   *
   * Pattern insertion uses it. It is separate from `insertBlock`
   * because a pattern must go in whole or not at all: with N separate
   * calls, a failure halfway through leaves the page published with
   * half a pattern.
   */
  insertBlocks: defineAction({
    input: z.object({
      documentId: z.string(),
      index: z.number().int().min(0),
      blocks: z.array(
        z.object({
          nativeType: z.string().min(1),
          data: z.record(z.string(), z.any()).optional()
        })
      ).min(1)
    }),
    handler: async (input, context: ActionContext = {}): Promise<WriteResult> => {
      return guardedBatchInsert(input.documentId, input.index, input.blocks, context);
    }
  }),

  /**
   * Drafts: working copy of a published page. Publishing and discarding
   * go through the same guard as any write: `publishDraft` is the
   * operation a plugin will want to reserve for certain roles.
   */
  createDraft: defineAction({
    input: z.object({ documentId: z.string() }),
    handler: async (input, context: ActionContext = {}): Promise<DraftResult> => {
      return guardedWrite(
        { operation: 'createDraft', documentId: input.documentId, request: context.request, cookies: context.cookies },
        async () => (await requireDraftAdapter()).createDraft(input.documentId),
        'Could not create the draft'
      );
    }
  }),

  publishDraft: defineAction({
    input: z.object({ documentId: z.string() }),
    handler: async (input, context: ActionContext = {}): Promise<DraftResult> => {
      return guardedWrite(
        { operation: 'publishDraft', documentId: input.documentId, request: context.request, cookies: context.cookies },
        async () => (await requireDraftAdapter()).publishDraft(input.documentId),
        'Could not publish the draft'
      );
    }
  }),

  discardDraft: defineAction({
    input: z.object({ documentId: z.string() }),
    handler: async (input, context: ActionContext = {}): Promise<DraftResult> => {
      return guardedWrite(
        { operation: 'discardDraft', documentId: input.documentId, request: context.request, cookies: context.cookies },
        async () => (await requireDraftAdapter()).discardDraft(input.documentId),
        'Could not discard the draft'
      );
    }
  }),

  /**
   * Composition: removes the block at the given position.
   */
  removeBlock: defineAction({
    input: z.object({
      documentId: z.string(),
      index: z.number().int().min(0)
    }),
    handler: async (input, context: ActionContext = {}): Promise<WriteResult> => {
      return guardedWrite(
        {
          operation: 'removeBlock',
          documentId: input.documentId,
          blockIndex: input.index,
          request: context.request,
          cookies: context.cookies
        },
        async () => {
          const adapter = await requireAdapter();
          if (!adapter.removeBlock) {
            throw new Error(`The "${adapter.name}" adapter does not support this operation.`);
          }
          return adapter.removeBlock(input.documentId, input.index);
        },
        'Remove failed'
      );
    }
  }),

  /**
   * Composition: duplicates the block at the given position.
   */
  duplicateBlock: defineAction({
    input: z.object({
      documentId: z.string(),
      index: z.number().int().min(0)
    }),
    handler: async (input, context: ActionContext = {}): Promise<WriteResult> => {
      return guardedWrite(
        {
          operation: 'duplicateBlock',
          documentId: input.documentId,
          blockIndex: input.index,
          request: context.request,
          cookies: context.cookies
        },
        async () => {
          const adapter = await requireAdapter();
          if (!adapter.duplicateBlock) {
            throw new Error(`The "${adapter.name}" adapter does not support this operation.`);
          }
          return adapter.duplicateBlock(input.documentId, input.index);
        },
        'Duplicate failed'
      );
    }
  }),

  /**
   * Settings panel: replaces the whole data of a block.
   */
  updateBlock: defineAction({
    input: z.object({
      documentId: z.string(),
      blockIndex: z.number().int().min(0),
      data: z.record(z.string(), z.any())
    }),
    handler: async (input, context: ActionContext = {}): Promise<WriteResult> => {
      return guardedWrite(
        {
          operation: 'updateBlock',
          documentId: input.documentId,
          blockIndex: input.blockIndex,
          data: input.data,
          request: context.request,
          cookies: context.cookies
        },
        async () => {
          const adapter = await requireAdapter();
          if (!adapter.updateBlock) {
            throw new Error(`The "${adapter.name}" adapter does not support this operation.`);
          }
          return adapter.updateBlock(input.documentId, input.blockIndex, input.data);
        },
        'Update failed'
      );
    }
  }),

  /**
   * Lists the team's shared patterns.
   *
   * `shared: false` means no store is configured and the client must
   * use its localStorage — that is the MIT core's behavior.
   */
  listPatterns: defineAction({
    handler: async (): Promise<{ shared: boolean; patterns: Pattern[] }> => {
      const store = resolvePatternStore();
      if (!store) return { shared: false, patterns: [] };

      return { shared: true, patterns: await store.list() };
    }
  }),

  /** Saves a pattern to the shared store, if there is one */
  savePattern: defineAction({
    input: z.object({
      name: z.string().min(1),
      blocks: z.array(
        z.object({
          nativeType: z.string().min(1),
          data: z.record(z.string(), z.any())
        })
      ).min(1)
    }),
    handler: async (input, context: ActionContext = {}): Promise<{ shared: boolean }> => {
      const store = resolvePatternStore();
      if (!store) return { shared: false };

      requireWriteAccess('savePattern');

      const actor = await resolveActor({
        operation: 'insertBlock',
        documentId: '',
        request: context.request,
        cookies: context.cookies
      });

      await store.save(
        { name: input.name, blocks: input.blocks, createdBy: actor?.id ?? null, updatedAt: new Date().toISOString() },
        actor
      );

      return { shared: true };
    }
  }),

  /** Deletes a pattern from the shared store, if there is one */
  deletePattern: defineAction({
    input: z.object({ name: z.string().min(1) }),
    handler: async (input, context: ActionContext = {}): Promise<{ shared: boolean }> => {
      const store = resolvePatternStore();
      if (!store) return { shared: false };

      requireWriteAccess('deletePattern');

      const actor = await resolveActor({
        operation: 'removeBlock',
        documentId: '',
        request: context.request,
        cookies: context.cookies
      });

      await store.remove(input.name, actor);
      return { shared: true };
    }
  }),

  /**
   * Assisted composition: proposes blocks from an instruction.
   *
   * `available: false` means no generator is configured — the MIT
   * core ships none; @intijs/genui provides one.
   */
  generateBlocks: defineAction({
    input: z.object({
      prompt: z.string().min(1),
      blockTypes: z.array(
        z.object({
          nativeType: z.string().min(1),
          label: z.string().optional(),
          description: z.string().optional(),
          when: z.string().optional(),
          fields: z.record(z.string(), z.any()).optional(),
          variants: z.record(z.string(), z.array(z.string())).optional()
        })
      ),
      max: z.number().int().min(1).max(20).optional()
    }),
    handler: async (input) => {
      const generator = resolveBlockGenerator();
      if (!generator) return { available: false as const, blocks: [], warnings: [] };

      // This action spends the customer's key on every call. Without a
      // guard, an open endpoint is an open bill.
      requireWriteAccess('generateBlocks');

      // The model key lives here, on the server: the browser only sees
      // the instruction and the blocks that come back.
      const result = await generator.generate(
        input.prompt,
        input.blockTypes as GeneratorBlockType[],
        { max: input.max }
      );

      return { available: true as const, ...result };
    }
  }),

  /**
   * Entry search for the relation picker
   * (inline-editing mini-panel for relation fields)
   */
  searchEntries: defineAction({
    input: z.object({
      collection: z.string().min(1),
      query: z.string()
    }),
    handler: async (input): Promise<EntrySummary[]> => {
      const adapter = await resolveWriteAdapter();

      return adapter && isSearchableAdapter(adapter)
        ? adapter.searchEntries(input.collection, input.query)
        : [];
    }
  })
};
