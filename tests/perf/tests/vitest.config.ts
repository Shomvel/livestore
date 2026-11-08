import { defineProject } from 'vitest/config'

export default defineProject({
  root: import.meta.dirname,
  test: {
    name: '@local/tests-perf',
    include: ['**/*.unit.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
  },
  resolve: {
    alias: {
      '@livestore/wa-sqlite/dist/wa-sqlite.mjs': '@livestore/wa-sqlite/dist/wa-sqlite.node.mjs',
    },
  },
})
