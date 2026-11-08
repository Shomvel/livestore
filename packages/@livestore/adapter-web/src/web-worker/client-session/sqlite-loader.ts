import { loadSqlite3Wasm } from '@livestore/sqlite-wasm/load-wasm'

/**
 * Browser sessions benefit from downloading and compiling the wasm binary as soon as
 * possible to hide network and IO latency behind the rest of the boot process. We kick
 * that work off eagerly on the client while still returning the shared promise.
 *
 * The Cloudflare / Workerd runtime has stricter rules: async fetches during module
 * evaluation are blocked, so we defer loading until the worker asks for it.
 */
const isServerRuntime = String(import.meta.env?.SSR) === 'true' || typeof window === 'undefined'

let sqlite3Promise: ReturnType<typeof loadSqlite3Wasm> | undefined

/** Shares WASM initialization across stores, but retries failed initialization on a later call. */
export const loadSqlite3 = () => {
  if (sqlite3Promise === undefined) {
    sqlite3Promise = loadSqlite3Wasm()
    void sqlite3Promise.catch(() => {
      sqlite3Promise = undefined
    })
  }
  return sqlite3Promise
}

if (isServerRuntime === false) {
  void loadSqlite3()
}
