# Dev-only tooling

Not part of the NanCy plugin. Never loaded by an operator's real gateway config. See `../docs/architecture/behavior-comparator.md` for the full design.

- **`checkpoint-recorder/`** — a passive OpenClaw plugin that captures the full model context and tool-call outcomes for any run into JSON checkpoint files. `npm test` inside it for unit coverage.
- **`scenario-shop/`** — a fully local simulated shop (`search_products`/`buy_product`) for scenario testing. No network access.
- **`comparator/`** — runs a scenario through OpenClaw with and without NanCy loaded, and reports the difference:

  ```bash
  node --experimental-strip-types comparator/src/run-comparison.ts \
    --scenario=comparator/scenarios/laptop-vague-request.json \
    --model-config=<path to a local, gitignored credentials JSON — see the architecture doc>
  ```

  Makes real, billed model API calls. Output lands under `comparator/runs/` (gitignored).

Each subdirectory has its own `package.json`/`tsconfig.json` and can be typechecked/tested independently (`npm run check` inside it).
