import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: { target: 'es2022', license: { fileName: 'FRONTEND-LICENSES.md' } },
  worker: {
    rolldownOptions: {
      output: {
        comments: { legal: true },
        banner: ({ name }) =>
          name === 'graphLayout.worker'
            ? readFileSync(
                new URL('./licenses/ELKJS-COPYRIGHT.txt', import.meta.url),
                'utf8',
              ).replaceAll('/***', '/*!**')
            : '',
      },
    },
  },
  test: { include: ['tests/**/*.test.ts'] },
})
