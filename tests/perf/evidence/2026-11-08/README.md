# Performance session closeout

This records the retained work from Kimi Code session
`session_43ed2f9e-7bd5-45b4-be2a-4b8630763011` against upstream
`85ddd7c96135761111844f7b35b7ba485f25ff92`. The session stopped at the provider's
weekly usage limit after its final agent completed a multi-store startup
experiment. The handoff recovered that experiment, added durable initialization
retry and store-isolation regressions, and collected final validation.

## Retained implementation

- Result versions stop propagation for equal reactive results and preserve their
  identity. Dynamic SQL refreshes its table dependencies. Repeated raw-result
  identities avoid decoding, and unchanged plain-array elements are reused.
- StoreRegistry retained hits bypass repeated Effect acquisition. React retention
  follows registry/storeId, methods keep stable identities, and production query
  subscriptions omit diagnostic component stacks.
- Explicit repository NoopTracer instances use a shared non-recording SQLite
  span. Real tracers retain normal dispatch and context behavior.
- Large events combine compatible adjacent INSERTs into at most 999-parameter
  statements. Original statements still determine materializer hashes, and
  changeset/journal/savepoint boundaries remain per event.
- Sync advances avoid redundant argument serialization. OPFS pool initialization
  reads headers once. Cloudflare pushes without subscribers skip response chunk
  encoding while preserving persistence and oversized-event errors.
- SQLite initialization is shared within a realm. Servers load lazily, browsers
  preload, and rejected initialization can retry. Databases and store lifetimes
  remain independent.
- The benchmark app uses one selection subscription, memoized rows, delegated
  clicks, a keyed fragment for empty/populated transitions and a set-based
  every-tenth-row UPDATE. The closeout uses SQL row numbers instead of id modulo
  so sparse ids and deletions keep the original row-selection behavior. These
  are application changes and affect its timings.

## Historical measurements

All timings below came from the original session on one Apple M3 Pro. Browser
runs used Node 24.22.2, Playwright 1.64.1 and Chromium 156.0.8078.4. The JSON
files preserve their original timestamps, dirty-tree flag and coverage fields.
The base commit identifies ancestry, not a committed candidate snapshot.

| Browser scenario       | Original app/runtime | Combined candidate after set-based UPDATE |
| ---------------------- | -------------------- | ----------------------------------------- |
| Create 10,000 rows     | 912 ms median        | 392 ms median, 15/15 measured             |
| Select a row           | 144 ms median        | 0/15 measured                             |
| Update every tenth row | 200 ms median        | 0/15 measured                             |
| Clear 1,000 rows       | 160 ms median        | 32 ms, 8/15 measured                      |

Missing Event Timing entries are unmeasured observations, not zero latency or
proof that every missing interaction took less than 16 ms. Chromium does not
emit entries below its collection threshold, and the harness waits 100 ms.
The before/after table combines library and benchmark-app changes made over the
session. It is not a controlled estimate of any one library optimization.
The historical set-based UPDATE report predates the row-number correctness fix.
Profiler runs are separate from normal timing runs.

The final interrupted work isolated just the SQLite loader on top of the
then-current candidate. Five alternating AB/BA rounds used fresh Node processes
for each variant/count, with module import and registry disposal outside the
timed region. Raw samples were recovered from the original tool output and are
stored in [multi-store-startup.json](./multi-store-startup.json).

| Sequential cold stores | Original loader median | Shared loader median |
| ---------------------- | ---------------------- | -------------------- |
| 1                      | 48.82 ms               | 48.57 ms             |
| 10                     | 202.18 ms              | 116.95 ms            |
| 100                    | 1,344.91 ms            | 474.14 ms            |

These numbers describe same-process realm reuse across independent stores.
They do not establish browser startup gains or savings across workers/processes.

## Experiments closed without a production change

- Row-level invalidation needs reliable old/new write keys across commit, sync
  and rollback. SQL-text or bind-position guesses cannot preserve correctness.
- Sharing Store scopes, databases or sync processors would cross isolation
  boundaries. Only WASM initialization was retained.
- Multi-tab warm fast-path diagnostics reduced snapshot RPCs from two to zero
  and leader VFS reads by 13 (90,144 bytes), but dual-page ready p50 improved only
  0.70 ms across three samples per configuration. No new startup change was made.
- OPFS flush diagnostics did not justify removing the six transaction-related
  flushes. UI completion, leader acknowledgement and physical durability remain
  different milestones.
- Commit-array and event fast-path experiments with unstable A/B gains were
  withdrawn. Their useful behavioral regressions remain.

## Reproduction and validation

The closeout's final source is commit `804ee196b`. Its
[source fingerprints](./validation/source-fingerprints.json),
[validation summary](./validation/summary.json) and
[final browser measurements](./validation/measurements.json) are archived here.
Related tests passed 548 cases with four existing skips. The two selected
real Chromium/OPFS integration tests and all 125 official browser tests passed.
Workspace TypeScript, intent-layer, changeset status and portable oxfmt 0.77.0
checks passed. The final browser run was serialized after other validation.

Names of individual logs in the summary are keys in
[stdout.json](./validation/stdout.json). Names of command record files are keys
in [commands.json](./validation/commands.json). Superseded runs remain identified
as such in the summary. The full source and remaining environment checklist are
tracked in [the fork pull request](https://github.com/Shomvel/livestore/pull/1).

Use the repository's Full Setup (`devenv shell`) for CI parity. Run
`devenv tasks run lint:full:fix`, `devenv tasks run test:run` and
`devenv tasks run ts:check` before treating this as the full CI bar.

This closeout host has no Nix/devenv executable. Those commands were attempted
and could not start. Portable Node 24 validation and real local Chromium/OPFS
tests are recorded separately in the final validation artifact. This limitation
keeps the pull request a draft until the full environment checks are completed.

For the browser suite, run from the repository root:

```sh
PATH="$PWD/node_modules/.bin:$PATH" \
  WORKSPACE_ROOT="$PWD" LIVESTORE_PERF_PORT=4183 ./scripts/bin/mono test perf
```

Other measured results from the source session remain outside the repository
as local diagnostics. The compact selected reports in this directory have SHA-256
digests in [manifest.json](./manifest.json).
