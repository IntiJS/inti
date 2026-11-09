# Security Policy

Inti writes to your CMS and exposes HTTP endpoints, so security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Use [GitHub's private vulnerability reporting](https://github.com/intijs/inti/security/advisories/new).

Include the affected package and version, your Astro version and CMS adapter, and the steps to reproduce.

## Supported versions

Inti is in beta. Only the latest published release receives security fixes.

## Scope

Examples of what we want to hear about:

- Writing to a CMS, reading drafts, or opening the editor without an editor session
- Leaking CMS credentials or AI provider keys to the browser
- Cross-site scripting through content validated by `@intijs/genui`
- Spending a provider's quota past the limits of `createVisitorComposer`
- Reaching files outside the content root through `@intijs/adapter-keystatic`
- Uploading to R2 something other than an image through `createR2MediaStore`

## What you are responsible for

Inti refuses writes in production until a plugin decides who is editing, but deciding that is up to you:

- Register `resolveActor` and `beforeWrite` in `src/middleware.ts`, backed by a real session.
- Keep CMS credentials and model keys server-only. Never use a `PUBLIC_` prefix.
- `INTI_ALLOW_ANONYMOUS_WRITES=1` opens writes to anyone who can reach the server. Use it only behind a VPN or an authenticated proxy.
- `@intijs/mcp` writes with the credentials in its environment and does not pass through `beforeWrite`. Use `INTI_MCP_READONLY=1` or a restricted CMS user to limit it.
- `connectToRoom` and `createR2MediaStore().upload` do not authenticate. Check the session before calling them.
- Print a generated field with `set:html` only if it is declared `richtext`.
