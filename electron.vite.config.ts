import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// CSP estricta solo en la versión compilada: en desarrollo Vite necesita scripts en línea para HMR.
// `unsafe-inline` en estilos lo exigen xterm y CodeMirror, que inyectan sus hojas de estilo.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

export default defineConfig({
  main: {
    // Todo dentro del bundle: la app empaquetada no necesita node_modules
    build: { externalizeDeps: false, rollupOptions: { external: ['electron', 'bufferutil', 'utf-8-validate'] } }
  },
  preload: {},
  renderer: {
    plugins: [
      react(),
      {
        name: 'codycube-csp',
        apply: 'build',
        transformIndexHtml: () => [
          { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }
        ]
      }
    ]
  }
})
