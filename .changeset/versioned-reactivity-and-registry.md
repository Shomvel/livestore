---
'@livestore/livestore': patch
'@livestore/react': patch
---

Preserve object identity and skip downstream notifications for deeply equal reactive results, while keeping table invalidation and dynamic SQL dependencies correct. Reduce loaded-store acquisition, React retain, and production query stack-capture overhead. Batch compatible INSERT statements within large events without changing materializer hashes, event atomicity, or rollback semantics.
