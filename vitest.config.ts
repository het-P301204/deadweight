import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Includes src/ui/tokens.test.ts, which asserts the palette's contrast
    // arithmetically -- no browser needed, and therefore no excuse.
    include: ['src/**/*.test.ts'],
  },
})
