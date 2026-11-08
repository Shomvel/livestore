---
'@livestore/adapter-web': patch
---

Share SQLite WASM initialization across in-memory stores in server runtimes while keeping each store's database and lifecycle independent. Retry failed initialization, including failed browser preloads, on the next request.
