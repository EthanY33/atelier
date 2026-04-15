---
description: Run the end-to-end atelier pipeline against bundled fixtures and print the output tree.
---

Run the end-to-end atelier demo pipeline:

1. `cd` to the atelier repo root (the directory containing `package.json`).
2. Run `node scripts/run-demo.mjs`.
3. After it completes, print the directory tree under `examples/fixtures/output/` so the user can see every generated artifact.

If the script exits with a non-zero code, surface the error message and stop.
