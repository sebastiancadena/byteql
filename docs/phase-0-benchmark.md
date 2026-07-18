# ByteQL Phase 0 benchmark

## Recorded observation

The automated acceptance test measured **285.55 ms** from the `Try sample` click to the first
visible data row in the result grid. This observation is below the Phase 0 reporting target of
10,000 ms.

This is one real observation, not a CI performance guarantee. The Playwright test always reports
and attaches its timing and does not fail merely because a later shared runner exceeds the target.

| Field                  | Recorded value                                                           |
| ---------------------- | ------------------------------------------------------------------------ |
| Measured at            | 2026-07-18T07:13:54.012Z                                                 |
| Host                   | `spark1`                                                                 |
| OS                     | Linux 6.17.0-1026-nvidia, arm64                                          |
| CPU                    | ARM Cortex-X925/Cortex-A725, 20 logical processors                       |
| Browser                | system snap Chromium 150.0.7871.100, headless                            |
| Delivery               | Vite production-format E2E build in `dist-e2e`, served on `127.0.0.1`    |
| Browser state          | newly launched Playwright run and fresh isolated browser context         |
| Fixture                | `demo.mid`, 98 uncompressed bytes                                        |
| Fixture SHA-256        | `487018c42a265f4a32aeff9ccc0d32295c73ef28eb446f45b5f6c288821d7eea`       |
| Start                  | immediately before clicking `Try sample` after `[data-app-ready="true"]` |
| Stop                   | first result-grid data row became visible                                |
| Elapsed                | 285.549839 ms                                                            |
| Target                 | under 10,000 ms                                                          |
| Observed target result | met for this observation                                                 |

The benchmark build differs from deployable `dist` only by narrowly compile-time-gated parser/audio
instrumentation used by the recovery and audio lifecycle tests. The static-delivery regression proves
the preview serves `dist-e2e` while normal `dist` contains none of those markers.

The timer intentionally excludes initial page and DuckDB-WASM startup. That matches the Task 12
acceptance definition: sample acceptance begins at the explicit `Try sample` action in a fresh
context. The complete browser process was newly launched for this dedicated one-test observation.

## Reproduce

From `apps/web`, run:

```bash
BYTEQL_BENCHMARK_CPU='your CPU model; logical processor count' \
  pnpm exec playwright test performance.spec.ts
```

The list reporter prints `BYTEQL_BENCHMARK` JSON and Playwright attaches the same structured record
as `byteql-phase-0-benchmark.json`. Record the actual runner description; do not copy the reference
machine label onto results from another machine.
