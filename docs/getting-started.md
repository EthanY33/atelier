# Getting started

## Install

```bash
/plugin marketplace add EthanY33/atelier
```

Or clone and link locally:

```bash
git clone https://github.com/EthanY33/atelier
cd atelier
npm install
```

## First run

Run `/brand-init` to bootstrap your brand identity. This creates `.atelier/brand.json` in your project root, pre-populated with placeholder values for your brand name, colors, typography, logo, and voice settings. Edit this file to match your actual brand before running other skills.

## Demo

Run `/atelier-demo` to execute the full end-to-end pipeline against the bundled fixture data. Inspect the generated outputs in `examples/fixtures/output/` to see what each skill produces.

You can also invoke the demo script directly:

```bash
node scripts/run-demo.mjs
```

## Prerequisites

- **Node 20+** — required by all skills.
- **Playwright Chromium** — required by `og-card-generator`, `accessibility-design-audit`, and `html-to-video`.

  ```bash
  npx playwright install chromium
  ```

- **ffmpeg on PATH** — required only by `html-to-video`. Install via your OS package manager (`apt`, `brew`, `choco`) and confirm with `ffmpeg -version`.

## Preflight check

Each skill's entry point calls into `scripts/preflight.mjs` automatically and prints install instructions if a prerequisite is missing — you don't run it directly.
