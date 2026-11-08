---
'@livestore/common': patch
'@livestore/sqlite-wasm': patch
---

Avoid redundant event-argument serialization for pure upstream advances and identical pending events during rebase, and read each OPFS pool file header once while preserving digest and truncated-input behavior.
