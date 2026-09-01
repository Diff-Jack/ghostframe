import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/frontend',
  plugins: [react()],
  server: {
    port: 7330,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7331',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
})
