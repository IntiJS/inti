## What and why

## Packages touched

<!-- e.g. @intijs/core, @intijs/adapter-strapi -->

## How it was tested

- [ ] `npm run build`
- [ ] `npm test` (`bun test packages/`)
- [ ] A test that fails without this change, if it fixes a bug
- [ ] The end-to-end check that covers it, if any: `node scripts/astro-compat.mjs <5|6|7>`, `node scripts/create-inti-check.mjs`, `npm run test:genui`, `npm run test:cloudflare`, `npm run test:wordpress`, `npm run test:kitsuden`
- [ ] No package imports or depends on `@intijs/ee` (`packages/core/tests/ee-boundary.test.ts`)
- [ ] `README.md`, `AGENTS.md`, `llms.txt` and the package's own `README.md` still match the code
- [ ] An entry in `CHANGELOG.md`, if users will notice the change
- [ ] No secrets, tokens or `.env` files in the diff; CMS credentials stay server-only (never `PUBLIC_`)
