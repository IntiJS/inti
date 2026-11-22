---
name: webtest
description: >-
  Drive a running Inti site in a real browser with Playwright (Node) to see a change working:
  render a page, double-click a field in the visual editor, capture the console and network, take
  a screenshot. Use when the user asks to test, verify, reproduce or screenshot something in the
  browser, or when a change to packages/core (BlockRenderer, visual-bridge, inline editor,
  actions) needs to be seen in a rendered page and not only in unit tests.
---

# Webtest

Browser checks for this repository, in Node. Unit tests (`npm test`) and the end-to-end scripts
(`scripts/astro-compat.mjs` and friends) stay the source of truth for CI; this skill is for
looking at the page and for reproducing what an editor or a visitor sees.

## Setup, once

```bash
npm install --prefix .claude/skills/webtest
npx --prefix .claude/skills/webtest playwright install chromium
```

No room for the download, or Chrome or Edge already installed? Skip the second command and set
`PW_CHANNEL=chrome` or `PW_CHANNEL=msedge`; the examples launch that browser instead.

The dependency lives in `.claude/skills/webtest/package.json`, not in the workspace: nothing else
in the monorepo needs a browser. `node_modules` there is ignored by git.

## Run a script against a server

`scripts/with-server.mjs` starts the server, waits for the port, runs your script and stops the
server (the whole process tree, also on Windows). Run it with `--help` before reading it.

```bash
# the demo site (Astro dev, port 4330)
node .claude/skills/webtest/scripts/with-server.mjs \
  --server "npm run dev" --port 4330 -- \
  node .claude/skills/webtest/examples/edit-field.mjs
```

The URL reaches your script as `BASE_URL` (default `http://localhost:<first port>`). If a server is
already running on the port, `with-server.mjs` uses it and does not stop it.

## Pattern: look first, then act

1. `page.goto(url, { waitUntil: 'networkidle' })`. On a dynamic page, do not read the DOM before it.
2. Take a screenshot or `page.content()` and choose selectors from what is really rendered.
3. Act, then assert on the page, not on what you expect it to be.

Select by what Inti renders, in this order: `[data-inti-field="heading"]` (a CMS field, accepts
dot-paths such as `cta.label`), `[data-inti-block-id]` (a block), then role or text.

## Inti specifics

- **The editor only exists for an editor.** In development `intiDelivery` treats every request as an
  editor's; in production there is no editor without a session cookie, so a script that expects
  `data-inti-field` against a built site must set that cookie first. A visitor must get none of it:
  asserting that `[data-inti-field]` is absent is a valid check.
- **Edit mode:** a double-click on a field makes it `contenteditable`; `Escape` restores the text and
  writes nothing; `Enter` or blur commits **and writes to the CMS** (the local JSON store, with the
  demo site). Use `Escape` unless the point is to test the write, and say so before committing.
- **Hidden blocks** are rendered for editors with `data-inti-block-hidden` and absent for visitors.
- **Saving fails with 404 on `/_actions/...`** means the Astro adapter is missing (see AGENTS.md,
  "The three mistakes").
- Screenshots go to a temp folder printed by the script (`os.tmpdir()/inti-webtest`), never into
  the repository.

## Examples

- `examples/edit-field.mjs`: opens the page, finds the first `[data-inti-field]`, double-clicks it,
  asserts it is editable, presses `Escape` and asserts the text came back. Writes nothing.
- `examples/console-log.mjs`: loads a page and prints console messages, page errors and failed
  requests; exits 1 on any page error. `PAGE_PATH` picks the path (default `/`).

Copy one, change it, run it through `with-server.mjs`. Do not add scripts to the repository unless
they will be reused; one-off scripts go in the scratchpad.

## Limits

Chromium only, headless, one browser. Not a replacement for the CI jobs, and not for a site behind a
CMS you cannot reach. Do not commit screenshots or traces.
