# create-inti

Creates an Astro project with [Inti](https://github.com/intijs/inti): edit your content by double-clicking the rendered page, and it is saved to your CMS. Inti is currently in beta.

> **Not on npm yet.** `npm create inti@latest` will work once `create-inti` and the `@intijs` packages are published. Today, run it from a clone of the repository, which also makes the project install the packages from that clone:

```bash
git clone https://github.com/intijs/inti.git
cd inti && npm install && npm run build && cd ..
node inti/scripts/scaffold-local.mjs my-site     # same options as below
```

Once published:

```bash
npm create inti@latest
```

Requires Node 22.12 or later. It asks for your CMS and generates the complete setup: Astro adapter, actions, block registry and a starter block.

With no CMS it ships sample content you can edit straight away: `npm run dev`, double-click the heading, press Enter.

## Options

```bash
npm create inti@latest my-site -- --cms wordpress --yes
```

| Option | |
|---|---|
| `--cms <id>` | `wordpress`, `kitsuden`, `strapi`, `keystatic` or `local` |
| `--yes`, `-y` | No prompts: use the flags and the defaults |
| `--no-install` | Do not install dependencies |
| `--packages <dir>` | Depend on the tarballs in `<dir>` (made with `npm pack`) instead of the npm registry. `scripts/scaffold-local.mjs` sets it |
| `--help`, `-h` | Show the help |

It never overwrites anything: a folder that already has files is refused.

MIT
