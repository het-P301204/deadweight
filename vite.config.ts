import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    target: 'es2022',
    // DEADWEIGHT analyses a codebase in the browser tab it is opened in, and
    // claims that nothing about that codebase leaves the machine. CI enforces
    // the claim by scanning the built bundle for network APIs. Vite's
    // modulepreload polyfill is the only thing it injects that contains a
    // `fetch`, and there are no dynamic imports for it to preload, so dropping
    // it costs nothing and keeps the check honest.
    modulePreload: { polyfill: false },
  },
})
