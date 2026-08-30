# js-bundlers

The reproducible local benchmark runner behind the [warefeats.com "Vite vs esbuild vs tsup" comparison](https://warefeats.com/benchmarks/vite-vs-esbuild-vs-tsup-library-build/).

It downloads zod's TypeScript source from a pinned GitHub tag (sha256-verified), then runs a cold production build with each bundler against the same corpus, collecting per-pass timing and summary statistics. Results live in this repo as `benchmark.json` (editorial metadata) plus one file per run under `runs/`.

## Corpus

zod 3.24.4 library source, vendored from [github.com/colinhacks/zod@v3.24.4](https://github.com/colinhacks/zod/tree/v3.24.4/src). 13 TypeScript files, 6,645 lines, 193 KB. Zero dependencies. The npm package ships only compiled JavaScript, so the runner downloads the source tarball from GitHub and verifies its sha256 hash (`d8f858db31bc9debc12ac278db107c67a726eda04e4d71250704d2c7d4c613fe`) before extraction.

## Configuration equivalence

Every candidate builds the same entry point (`src/index.ts`) with equivalent settings. Declaration files (.d.ts) are disabled for all — tsup generates them by default when configured with `dts: true`, which invokes the TypeScript compiler; disabling it keeps the comparison to bundling only.

| Setting | esbuild | Vite | tsup |
|---|---|---|---|
| Entry | `src/index.ts` | `src/index.ts` | `src/index.ts` |
| Format | `--format=esm` | `formats: ["es"]` | `--format esm` |
| Target | `--target=es2022` | `target: "es2022"` | `--target es2022` |
| Bundle | `--bundle` | implicit (library mode) | implicit |
| Minify | `--minify` | `minify: "esbuild"` | `--minify` |
| Sourcemap | off (default) | `sourcemap: false` | off (default) |
| DTS | N/A | N/A | off (default) |

Minification is ON because production builds are the real use case. All three tools delegate minification to esbuild's minifier — the difference is in the bundling and transformation pipeline: esbuild bundles natively in Go, Vite delegates to Rollup (JavaScript), and tsup wraps esbuild.

Config files for Vite (`configs/vite.config.ts`) and tsup (`configs/tsup.config.ts`) are in this repo for review. At runtime, the runner writes a simplified vite config to the scratch directory; esbuild and tsup use CLI flags only.

## Requirements

- [Bun](https://bun.sh/) 1.4+
- Internet access on first run (to download the zod source tarball; cached afterward)

## Setup

```sh
bun install
```

## Usage

Full benchmark (3 warmup passes, 20 measured passes):

```sh
bun run benchmark
```

Quick smoke test (1 warmup, 3 passes):

```sh
bun run smoke
```

Write results to a file instead of stdout:

```sh
bun run benchmark -- --output=results/run.json
```

### Flags

- `--quick` — shorthand for `--runs=3 --warmups=1`
- `--runs=N` — number of measured passes (default: 20)
- `--warmups=N` — number of warmup passes (default: 3)
- `--output=PATH` — write JSON to a file instead of stdout

## Publishing results

Convert a completed benchmark result into a run file and update `benchmark.json`:

```sh
bun run benchmark -- --output=results/run.json
just publish results/run.json
```

The publish step maps the runner's raw output into the site's `BenchmarkRun` shape, writes `runs/<date>-<rig>.json`, and appends it to `benchmark.json.runs` (idempotent — re-publishing the same run replaces it).

Optional flags: `--machine="MacBook Pro"` (display name for the machine; defaults to the chip label) and `--label="M2 Max (local)"` (toggle text shown on the page; defaults to chip name + "(local)").

### Updating the site

1. Merge the new run file and `benchmark.json` update here.
2. In [warefeats/warefeats.com](https://github.com/warefeats/warefeats.com): bump this slug's `ref` in `web/data/registry.json` to the merge commit SHA, run `bun run sync`, commit registry + cache together, PR, merge.

## Type checking and tests

```sh
bun run check   # tsc
bun run test     # bun test
```

## Repository

[github.com/warefeats/js-bundlers](https://github.com/warefeats/js-bundlers)
