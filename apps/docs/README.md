# Inti.js Documentation

Official documentation for Inti.js (AI for any CMS, without changing the CMS; for Astro sites), built with [Astro Starlight](https://starlight.astro.build/).

## Structure

```
src/
├── content/docs/       # Documentation content
│   ├── core/          # Core concepts
│   ├── guides/        # Getting-started guides
│   ├── cli/           # CLI documentation
│   ├── registry/      # Component Registry
│   └── adapters/      # Building adapters
├── components/        # Astro components
├── assets/            # Images and logos
└── styles/            # Custom styles
```

## Development

```bash
# Install dependencies (once, at the repository root)
npm install

# Development server
npm run dev -w @intijs/docs

# Build
npm run build:docs

# Preview
npm run preview -w @intijs/docs
```

## Features

- 📚 **Complete documentation** of every Inti.js module
- 🎨 **Real source code** imported straight from the packages
- 🔗 **Integration** with the demo-site through the toolbar
- ⚡ **Performance** with Astro Islands and partial hydration

## Contents

### Core Concepts

- [Overview](src/content/docs/core/overview.mdx)
- [Block Orchestrator](src/content/docs/core/block-orchestrator.mdx)
- [Architecture](src/content/docs/core/architecture.mdx)

### Guides

- [Installation](src/content/docs/guides/installation.mdx)
- [Configuration](src/content/docs/guides/configuration.mdx)
- [First Project](src/content/docs/guides/quickstart.mdx)

### Reference

- [CLI: inti sync](src/content/docs/cli/sync.mdx)
- [Type Generation](src/content/docs/cli/typegen.mdx)
- [BlockRenderer](src/content/docs/registry/block-renderer.mdx)
- [Component Registry](src/content/docs/registry/components.mdx)
- [Client Directives](src/content/docs/registry/client-directives.mdx)
- [Adapter Contract](src/content/docs/adapters/contract.mdx)
- [Creating an Adapter](src/content/docs/adapters/creating.mdx)
- [Kitsuden Adapter](src/content/docs/adapters/kitsuden.mdx)
- [Introspection](src/content/docs/adapters/introspection.mdx)
