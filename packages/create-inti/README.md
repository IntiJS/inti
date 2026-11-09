# create-inti

Creates an Astro project with [Inti](https://github.com/intijs/inti): edit your content by double-clicking the rendered page, and it is saved to your CMS. Inti is currently in beta.

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
| `--help`, `-h` | Show the help |

It never overwrites anything: a folder that already has files is refused.

MIT
