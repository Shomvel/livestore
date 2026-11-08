---
'@livestore/sync-cf': patch
---

Avoid redundant response chunk encoding for Cloudflare pushes with no subscribers while preserving persistence, head advancement, oversized-event errors, and subscribed responses.
