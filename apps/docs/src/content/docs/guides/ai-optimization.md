---
title: AI-Native Development
description: How to optimize your workflow using Artificial Intelligence
---

Inti.js is designed from the ground up to be "AI-Friendly". This means AI assistants (such as Copilot, Cursor or ChatGPT) can understand your project with much greater precision than in other frameworks.

## What is AI-Native Development?

In a traditional workflow, AI often "hallucinates" CMS field names or component structures. In Inti.js, we remove the ambiguity with two key tools:

1.  **Strict Typing via `inti sync`**: The AI reads your CMS's real schema.
2.  **AI Discovery Manifest**: An inventory of all your UI components available to the AI.

## AI Discovery Manifest

When you run `npx @intijs/cli sync`, an `inti-manifest.json` file is generated in your output folder (by default `./src/lib/inti/`).

This file contains:
- A list of all the blocks registered in your `ComponentRegistry`.
- Metadata about what each component does.
- Instructions so the AI knows how to build valid page structures.

### How to use it with Cursor or Copilot

You can tell your AI assistant to read this file:

> "Based on the block inventory in `src/lib/inti/inti-manifest.json`, create a new block of type 'PricingTable' that fits the project's styles."

## Mock Data for Prompts

Along with the manifest, `inti-mocks.ts` is generated. These are examples of real data your CMS would expect to receive.

They are extremely useful for:
- Writing unit tests quickly.
- Trying components in development mode without the CMS connected.
- Giving the AI examples of how a block's JSON should be structured.

## MCP server: let the agent edit the content

The above helps the AI **write code**. The `@intijs/mcp` package goes one step further: it exposes your CMS as [Model Context Protocol](https://modelcontextprotocol.io) tools, so the agent can **read and edit the content** directly.

```bash
# today, from a clone of the repository that is installed and built:
claude mcp add inti -- node /absolute/path/to/inti/packages/mcp/bin/inti-mcp.js

# once the packages are published:
claude mcp add inti -- npx -y @intijs/mcp
```

It uses the same environment variables as the rest of Inti (`INTI_ADAPTER`, `INTI_WP_*`). With that, the agent has:

- `inti_get_page` — reads a page and each block's index.
- `inti_update_field` — changes a field of a block.
- `inti_insert_block`, `inti_move_block`, `inti_duplicate_block`, `inti_remove_block` — composition.
- `inti_search_entries` — searches entries to assign relations.

Only the tools your adapter really implements are announced, so the agent never sees an operation that is going to fail.

:::caution[Writes go to your real CMS]
There is no staging layer or undo on the agent's side. Point it at a test site while you get familiar with it, and use `INTI_MCP_READONLY=1` to leave only the read tools.
:::

See the [`@intijs/mcp` README](https://github.com/intijs/inti/tree/main/packages/mcp) for the full configuration.

## Example AI Workflow

1.  **Define your model in the CMS** (e.g. Strapi).
2.  **Run** `npx @intijs/cli sync`.
3.  **Ask the AI**: "Create the Astro component for the new 'TournamentBracket' block we just synced. Use the types from `inti.types.ts`."
4.  **The AI will generate** correct code because it knows the schema and the block inventory.
5.  **With the MCP server active**, you can also ask it: "read the home page and shorten the hero headline" — and the change lands in the CMS.
