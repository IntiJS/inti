# @intijs/cloudflare

Optional Cloudflare backends for [Inti](https://github.com/intijs/inti), currently in beta. Inti does not depend on Cloudflare: each piece implements a contract that already existed and plugs in with a plugin, so you can use just one.

| Piece | What for |
|---|---|
| `D1ContentAdapter`, `createD1ExperimentStore`, `createD1PatternStore`, `createD1ComposeCache` | Content for a site with no CMS, measurement, team patterns, shared composition cache |
| `IntiRoom`, `IntiLimiter`, `connectToRoom`, `createDurableLimiter` (`@intijs/cloudflare/durable`) | Editing rooms over WebSockets, limits shared between instances |
| `createR2MediaStore` | Media, checked by their bytes, usable as a `@intijs/genui` data source |
| `createWorkersAiProvider` | A model in your account, with no external key |
| `createCloudflareImageService`, `cloudflareImageUrl` | Resizing at the edge |

See the [deployment guide](https://github.com/intijs/inti/blob/main/apps/docs/src/content/docs/guides/cloudflare.mdx).

MIT
