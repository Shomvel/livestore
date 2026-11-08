# 0002 — Versioned equality cutoff with stable result identity

Status: accepted (2026-11-08; evidence: `reactive.test.ts`,
`live-queries/signal.test.ts`, and the 125-test browser performance run).

## Context

Decision 0001 described schema-equivalence cutoff and said `map` disabled it.
The implementation actually falls back to the graph's default deep equality
when no schema equivalence is available, including mapped queries. The graph
also discarded previous object identity even when a recomputed result was
deeply equal, allowing redundant downstream effects and subscriber callbacks.

## Decision

Refs and thunks carry a result version. Equal ref writes do not advance the
version; equal thunk results retain `previousResult` and do not advance it.
Reactive effects execute when a direct dependency's version changes, while
manual effect execution remains unconditional. Queries may still recompute and
execute SQL to establish that their result is unchanged. Table refs retain
their always-unequal semantics so every real table write invalidates queries.

Schema-derived equivalence remains preferred where available. Otherwise the
graph's default deep equality applies, including queries with `map`.

## Evidence

Graph tests cover equivalent writes, result identity, dynamic dependencies,
partial changes, errors, disposal and `skipInitialRun`. Store tests demonstrate
that an unrelated write in the same table still recomputes the query but does
not notify subscribers with an equal result. The combined LiveStore package
suite passed 104 tests, and the combined browser suite passed 125 tests.

## Consequences

Equivalent results preserve object identity and avoid downstream effects and
notifications. Consumers must not rely on a callback for every recomputation.
Dynamic SQL re-resolves its table set on every execution and drops abandoned
table dependencies so newly referenced tables cannot miss updates.
