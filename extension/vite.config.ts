import { defineConfig } from 'vite'
import webExtension from 'vite-plugin-web-extension'

export default defineConfig({
  plugins: [
    webExtension({
      manifest: './manifest.json',
      watchFilePaths: ['manifest.json'],
      additionalInputs: [
        'content/overlay.ts'
      ]
    })
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: process.env.NODE_ENV !== 'production'
  },
  publicDir: 'public'
})
