import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import * as path from 'path'
import * as fs from 'fs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Custom plugin to serve flame state from .opencode directory
    {
      name: 'serve-flame-state',
      configureServer(server) {
        server.middlewares.use('/api/flame/state', (_req, res) => {
          // Resolve path relative to project root (one level up from webapp)
          const statePath = path.resolve(__dirname, '..', '.opencode', 'flame', 'state.json')

          try {
            const content = fs.readFileSync(statePath, 'utf-8')
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(content)
          } catch (error) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: 'Failed to read flame state', path: statePath }))
          }
        })
      }
    }
  ],
})
