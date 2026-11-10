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

> **Not on npm yet.** The `@intijs` packages will be published there. Until then, run the server from a clone of the repository that is installed and built (`npm install && npm run build`): the clone already contains every adapter.

Once published:

```bash
npm install -D @intijs/mcp
```

The server needs the adapter of your CMS installed alongside it. It works with the adapters that write: WordPress, Kitsuden, Strapi and Keystatic. Contentful and Sanity are read-only and the server does not start with them. With no `INTI_ADAPTER` it uses the local store (`.inti/content.json`).

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
# today, from the clone:
claude mcp add inti -- node /absolute/path/to/inti/packages/mcp/bin/inti-mcp.js

# once published:
claude mcp add inti -- npx -y @intijs/mcp
```

### Claude Desktop / Cursor

Once published (until then use `"command": "node"` with the path to `packages/mcp/bin/inti-mcp.js` in the clone as its only argument):

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
| `inti_get_vocabulary` | — | List the block types the agent may compose with, their fields and the items available for reference fields. Only with `INTI_MCP_VOCABULARY`. |
| `inti_update_field` | yes | Update one field of one block. Dot-paths supported (`cta.label`). |
| `inti_update_block` | yes | Replace a block's entire data object. |
| `inti_insert_block` | yes | Insert a new block of an existing CMS type. |
| `inti_insert_blocks` | yes | Insert several blocks at once, in order: they all go in or none does. |
| `inti_move_block` | yes | Reorder blocks. |
| `inti_duplicate_block` | yes | Duplicate a block in place. |
| `inti_remove_block` | yes | Delete a block. |
| `inti_create_draft` | yes | Create a working copy of a page and return its `documentId`. Visitors see nothing until it is published. |
| `inti_publish_draft` | yes | Publish a working copy over its page. |
| `inti_discard_draft` | yes | Throw away a working copy. The published page does not change. |

`inti_get_page` is the entry point: the write tools need a `documentId` and a block index, and that's where both come from.

## Safety

Writes go to your **live CMS** unless the agent works on a draft: with an adapter that supports drafts, `inti_create_draft` returns a working copy that visitors do not see until it is published. There is no undo from the agent's side.

The server writes with the credentials in its environment and does **not** pass through the `resolveActor` / `beforeWrite` plugins of your site: those protect the browser's editor, not this process. What limits an agent is listed here.

- Point it at a staging site while you get a feel for it.
- Use a WordPress Application Password scoped to an account with only the permissions you need, not an admin.
- Set `INTI_MCP_VOCABULARY` to a JSON file with the block types the agent may use: what it inserts is validated against it, and `inti_get_vocabulary` shows it to the agent. If the file cannot be read the server does not start.
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

**The agent reads sample or empty content instead of your CMS** — `INTI_ADAPTER` isn't set in the server's environment, so it is using the local store (the startup line on stderr says `adapter "local"`). MCP clients don't inherit your shell: set `INTI_ADAPTER` and its credentials in the `env` block of the client config, not just in `.env`.

**"does not support write-back"** — the adapter resolved but isn't writable. The WordPress, Kitsuden, Strapi and Keystatic adapters support writes; Contentful and Sanity are read-only.

**No tools appear** — check the client's MCP logs. This server writes diagnostics to stderr on startup, including the adapter name and the tool list.
