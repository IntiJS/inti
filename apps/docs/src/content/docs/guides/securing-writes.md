---
title: Securing writes
description: Why Inti's actions are public and how to decide who can edit
---

Astro actions are **HTTP endpoints**. When you add this:

```ts
// src/actions/index.ts
import { intiActions } from '@intijs/core/actions';

export const server = { inti: intiActions };
```

your site exposes routes such as `POST /_actions/inti.updateBlockField` that accept requests from anyone who can reach them.

This is not an Inti detail, it is how actions work. But in Inti's case it has a concrete consequence: **those actions write to your CMS with the server's credentials**. An unauthenticated request that gets there produces a change that WordPress records as legitimate.

## Hiding the editor does not close the endpoint

Inti turns off the editing interface outside development. That is useful, but it is a UI measure, not a server one: the endpoint still exists and still answers `curl`.

Astro's CSRF protection (`security.checkOrigin`) is not enough either. It stops **another site** from making the request from a user's browser, which is a different attack. Whoever calls directly sets whatever `Origin` header they want.

## What Inti does by default

If all three conditions hold at once:

- the process is **not** in development,
- **no** registered plugin declares `beforeWrite` or `resolveActor`,
- `INTI_ALLOW_ANONYMOUS_WRITES` is not set,

the write actions **fail** with an error that explains why. This covers `updateBlockField`, `updateBlock`, `moveBlock`, `insertBlock`, `insertBlocks`, `removeBlock`, `duplicateBlock`, patterns and `generateBlocks`.

The condition is *"someone is deciding"*, not *"there is an identified user"*. If you register a `beforeWrite` that allows anonymous writes on purpose, Inti does not contradict you: the decision becomes yours, which is exactly the point.

Nothing changes in development, so the quickstart keeps working without setting up authentication.

An environment that does not identify itself as development counts as production. If `NODE_ENV` is not set, Inti assumes the restrictive option.

## Option 1 — Publish static

If content is edited locally or in a private environment and the public site is read-only, **do not expose the actions in production**: remove the `export const server` from that build, or publish with `output: 'static'` without an adapter.

It is the safest option because there is no endpoint to protect. It fits a large share of agency sites.

## Option 2 — A guard plugin

If you need to edit on the published site, you decide who can. Register the plugin in **`src/middleware.ts`**:

```ts
// src/middleware.ts
import { registerIntiPlugin } from '@intijs/core/plugins';

registerIntiPlugin({
  name: 'own-session',

  // Who is making the request. `null` = nobody identified.
  async resolveActor(ctx) {
    const session = await mySession(ctx.request);
    if (!session) return null;
    return { id: session.userId, role: session.role, email: session.email };
  },

  // Whether they can write or not. Runs before touching the CMS.
  beforeWrite(ctx) {
    if (!ctx.actor) {
      return { allowed: false, reason: 'You need to sign in to edit' };
    }
    if (ctx.actor.role === 'viewer') {
      return { allowed: false, reason: 'Your role does not allow editing' };
    }
    return { allowed: true };
  },

  // Optional: log what happened, including failed attempts.
  afterWrite(ctx, result) {
    console.log(`[edit] ${ctx.actor?.id} ${ctx.operation} ${ctx.documentId} → ${result.success}`);
  }
});

// If you already have a middleware, just add the registration above to yours
export const onRequest = (_context, next) => next();
```

:::caution[Do not register it in `src/actions/index.ts`]
Astro only loads the actions module when the first request to an action arrives. Until then the plugin does not exist: writes are still protected —the action loads the module before running—, but **the editor does not appear for anyone**, and without the editor nobody can trigger that first action. The middleware, on the other hand, is loaded before serving any request.

If an editor session is requested in production and no plugin declares `resolveActor`, Inti warns about it once in the server log.
:::

`ctx` carries `request` and `cookies`, as well as the operation, the document and the value being written. With that you can build policies per document, per field or per time of day, not only per user.

These two hooks are the whole contract: any session or identity provider you already use plugs in here.

## Option 3 — Open it on purpose

```bash
INTI_ALLOW_ANONYMOUS_WRITES=1
```

It only makes sense when the server itself is already protected by something else: a VPN, an authenticating proxy in front, an internal network. Inti allows it but leaves a warning in the logs, because it should not go unnoticed.

Do not use it to "get by" on a public site. That is exactly the scenario the default prevents.

## The editor and the real-time channel

Actions are not the only thing the editor exposes. Outside development, all of this also requires an **editor session**:

| Piece | Without a session |
|---|---|
| `GET/POST /api/inti/sync` (changes between connected editors) | `401` |
| `GET /api/inti/search` (relation picker, queries the CMS) | `401` |
| `VisualBridgeAuto` / `InlineEditor` with `enabled={true}` | nothing is drawn |
| `BlockRenderer` with `editable={true}` | renders as in production: no block JSON and no hidden blocks |

There is a session when a `resolveActor` plugin returns an actor (it receives `operation: 'session'`), or when `INTI_ALLOW_ANONYMOUS_WRITES=1`. Unlike writes, a `beforeWrite` without `resolveActor` is **not** enough: it decides on a specific write, but it does not say who is looking.

Prerendered pages never carry the editor outside development: anyone receives their HTML. If a page with the editor goes through a CDN, it must not be cached for anyone with a session.

To use the same rule in your own routes: `resolveEditorSession({ request, cookies })` from `@intijs/core/server`.

## Check it

The direct way to verify you are covered, against your already deployed site:

```bash
curl -i -X POST https://yoursite.com/_actions/inti.updateBlockField -H "Content-Type: application/json" -d '{"documentId":"1","blockIndex":0,"field":"heading","value":"test"}'
```

What you want to see is `HTTP/1.1 403 Forbidden` with `"code":"FORBIDDEN"` and the reason. If the content changes, the endpoint is open. (Up to 0.1.0 the rejection came out as a `500`; a `500` today means a real failure: CMS down, adapter credentials, etc.)

## A note on CMS credentials

Separately from all this: the `INTI_WP_*`, `INTI_STRAPI_*` and `ANTHROPIC_API_KEY` variables must **never** carry the `PUBLIC_` prefix. That prefix makes Astro embed them in the browser bundle, and there they are truly public.
