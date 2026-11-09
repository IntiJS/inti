---
title: Deployment
description: Taking a site with Inti to production, on a platform or on your own server
---

Inti is not deployed: **your Astro site** is deployed, and it carries Inti inside. There is no separate Inti server, no database and no panel. What your site needs in production is the same as any Astro project with SSR, plus three things specific to Inti.

## What Inti needs in production

1. **An Astro adapter with a server.** Without it, `astro:actions` does not exist and inline editing saves nothing. If in production you are only going to *read* content, a static build without an adapter works too.
2. **Deciding who can write.** In production Inti rejects writes if no plugin checks who makes them. Read [Securing writes](/guides/securing-writes/) before exposing the actions.
3. **Authorizing the CMS image domain**, or `<IntiImage>` will serve the images unoptimized:

   ```js
   // astro.config.mjs
   image: { domains: ['cms.yoursite.com'] }
   ```

The CMS credentials go in as server environment variables, never with a `PUBLIC_` prefix and never inside the image or the repository.

## Vercel, Netlify, Cloudflare

Use the platform's adapter (`npx astro add vercel`, `netlify` or `cloudflare`) and set the `INTI_*` variables in its dashboard. You need none of what follows.

## Your own server with Docker

For a VPS or your own infrastructure, with the node adapter in `standalone` mode:

```js
// astro.config.mjs
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  // ...
});
```

### `Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1

# --- Build -------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Dependencies first: that way a code edit does not invalidate the cache
# of `npm ci`, which is the slow layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- Runtime -----------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321

# Astro's server bundle does not include all its dependencies: the
# node adapter and `sharp` (which optimizes <IntiImage> images at
# request time) are resolved from node_modules.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

USER node
EXPOSE 4321
CMD ["node", "./dist/server/entry.mjs"]
```

### `.dockerignore`

It is not optional. Without it, `COPY . .` puts your machine's `node_modules` into the image —with native binaries for another platform, such as the Windows or macOS `sharp`— and a `dist/` that may be stale.

```text
node_modules
dist
.astro
.git

# CMS credentials are passed at runtime, never inside the image.
.env
.env.*
!.env.example
```

### Build and run

```bash
docker build -t my-site .
docker run -p 4321:4321 --env-file .env my-site
```

This template is verified by building a project with Inti's full setup on Astro 7: the page responds, `<IntiImage>` emits `srcset` in WebP, `sharp` works inside the container, anonymous writes are rejected and the process does not run as root.

`NODE_ENV=production` is not decorative: it is what turns on the rejection of unauthenticated writes. If you remove that line, Inti treats the container as development.

## Several instances: Valkey

With **one** instance, the editor's real-time channel works in memory and you need nothing else. With **more than one** behind a load balancer, each instance only sees its own editors, and two people on different servers do not see each other's changes.

For that, register a pub/sub backplane from `@intijs/core/team`. Any server speaking the Redis protocol works, and so does any client (`iovalkey`, `ioredis`, `node-redis`); this example uses Valkey:

```ts
// src/middleware.ts
import Valkey from 'iovalkey';
import { registerIntiPlugin } from '@intijs/core/plugins';
import { createValkeyBackplane } from '@intijs/core/team';

const url = process.env.INTI_VALKEY_URL;
if (url) {
  // Two connections: one in subscribe mode cannot publish. Created once, not per request.
  const backplane = createValkeyBackplane({ publisher: new Valkey(url), subscriber: new Valkey(url) });
  registerIntiPlugin({ name: 'realtime', getRealtimeBackplane: () => backplane });
}

export const onRequest = (_ctx, next) => next();
```

```yaml
# docker-compose.yml
services:
  app:
    build: .
    restart: always
    ports:
      - "4321:4321"
    env_file:
      - .env
    environment:
      - INTI_VALKEY_URL=redis://valkey:6379
    depends_on:
      valkey:
        condition: service_healthy

  valkey:
    image: valkey/valkey:8-alpine
    restart: always
    # Not published to the host: only the app needs to reach it
    expose:
      - "6379"
    command: valkey-server --save 60 1 --appendonly no
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
```

A serverless deployment (Vercel, Cloudflare) uses no containers and does not use this service either.

## The local store is not for production

With no CMS configured, Inti writes to `.inti/content.json`. It is for trying things out, not for production: inside a container that file is lost on rebuild, and with `USER node` the app directory is not writable. In production, connect a CMS.
