# @intijs/mcp

MCP server for Inti.js. Exposes your headless CMS content as [Model Context Protocol](https://modelcontextprotocol.io) tools, so an AI agent can read and edit pages using the same operations the browser's inline editor uses.

```
Claude Code / Cursor / Claude Desktop
   │  tools/call → inti_update_field
   ▼
@intijs/mcp (stdio)
   │  WritableAdapter.updateBlockField()
   ▼
@intijs/adapter-wordpress
   ▼
WordPress REST (wp/v2 + Application Password)
```

Inti is currently in beta.

## Install

```bash
npm install -D @intijs/mcp
```

The server needs a write-capable adapter installed alongside it (`@intijs/adapter-wordpress` or `@intijs/adapter-strapi`).

## Configure

The server reads the same environment variables as the rest of Inti — see [`.env.example`](../../.env.example). At minimum:

```bash
INTI_ADAPTER=wordpress
INTI_WP_ENDPOINT=https://cms.yoursite.com
INTI_WP_USER=editor
INTI_WP_APP_PASSWORD=xxxx xxxx xxxx xxxx
```

### Claude Code

```bash
claude mcp add inti -- npx -y @intijs/mcp
```

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "inti": {
      "command": "npx",
      "args": ["-y", "@intijs/mcp"],
      "env": {
        "INTI_ADAPTER": "wordpress",
        "INTI_WP_ENDPOINT": "https://cms.yoursite.com",
        "INTI_WP_USER": "editor",
        "INTI_WP_APP_PASSWORD": "xxxx xxxx xxxx xxxx"
      }
    }
  }
}
```

## Tools

Tools are advertised **based on what your adapter actually implements** — an agent never sees a tool that would always fail.

| Tool | Writes | Purpose |
|---|---|---|
| `inti_get_page` | — | Read a page by slug. Returns `documentId` and the index of every block. |
| `inti_search_entries` | — | Search entries in a collection to find a relation target. |
| `inti_update_field` | yes | Update one field of one block. Dot-paths supported (`cta.label`). |
| `inti_update_block` | yes | Replace a block's entire data object. |
| `inti_insert_block` | yes | Insert a new block of an existing CMS type. |
| `inti_move_block` | yes | Reorder blocks. |
| `inti_duplicate_block` | yes | Duplicate a block in place. |
| `inti_remove_block` | yes | Delete a block. |

`inti_get_page` is the entry point: the write tools need a `documentId` and a block index, and that's where both come from.

## Safety

Writes go to your **live CMS** — there is no staging layer and no undo from the agent's side.

- Point it at a staging site while you get a feel for it.
- Use a WordPress Application Password scoped to an account with only the permissions you need, not an admin.
- Set `INTI_MCP_READONLY=1` to drop every write tool. The read tools keep working, so an agent can still inspect content it cannot change.

```json
"env": { "INTI_MCP_READONLY": "1" }
```

Credentials stay in this process — they are never sent to the model, only used to sign requests to your CMS.

## Example session

> **You:** Read the home page and make the hero heading more direct.

The agent calls `inti_get_page({ slug: "home" })`, sees block 0 is a `Hero` with `heading: "Welcome to our website"`, then calls `inti_update_field({ documentId: "42", blockIndex: 0, field: "heading", value: "Ship faster with Astro" })`.

The change is live in WordPress. Your Astro site picks it up on the next request.

## Troubleshooting

**"No CMS adapter configured"** — `INTI_ADAPTER` isn't set in the server's environment. MCP clients don't inherit your shell, so set it in the `env` block of the client config, not just in `.env`.

**"does not support write-back"** — the adapter resolved but isn't writable. Only `@intijs/adapter-wordpress` and `@intijs/adapter-strapi` support writes today; Contentful and Sanity are read-only.

**No tools appear** — check the client's MCP logs. This server writes diagnostics to stderr on startup, including the adapter name and the tool list.
