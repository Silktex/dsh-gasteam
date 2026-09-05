import { defineConfig } from 'vitest/config'

// Fresh-process acceptance gate. Scenarios expand with each implemented autonomous milestone.
export default defineConfig({ test: { include: ['tests/**/*.acceptance.ts'], testTimeout: 30_000 } })
