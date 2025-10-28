import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import type { ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'api-proxy',
      configureServer(server: ViteDevServer) {
        server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          try {
            if (!req.url?.startsWith('/api/')) return next()
            let file = path.join(process.cwd(), 'api', req.url.replace('/api/', ''))
            if (!fs.existsSync(file)) {
              const tsCandidate = file.endsWith('.ts') ? file : file + '.ts'
              if (fs.existsSync(tsCandidate)) {
                file = tsCandidate
              } else {
                return next()
              }
            }
            // Load the module via Vite's SSR loader (handles TS & deps)
            const rel = path.relative(process.cwd(), file)
            const urlPath = '/' + rel.split(path.sep).join('/')
            const mod = (await server.ssrLoadModule(urlPath)) as unknown

            // Very small adapter to emulate a minimal Next.js-like response
            const vr = {
              status(code: number) { res.statusCode = code; return this },
              json(obj: unknown) {
                res.setHeader('content-type', 'application/json; charset=utf-8')
                res.end(JSON.stringify(obj))
              },
            }

            // Parse body for POST requests (JSON only)
            if (req.method === 'POST') {
              const chunks: Buffer[] = []
              await new Promise<void>((resolve) => {
                req.on('data', (c) => chunks.push(Buffer.from(c)))
                req.on('end', () => resolve())
              })
              const raw = Buffer.concat(chunks).toString('utf8')
              const parsed = raw ? JSON.parse(raw) : undefined
              const reqWithBody = req as unknown as { body?: unknown }
              reqWithBody.body = parsed
            }

            const handler = (mod as { default: (req: unknown, res: typeof vr) => Promise<void> }).default
            await handler(req as unknown, vr)
          } catch (err) {
            const msg = (err as Error)?.message || 'Internal server error'
            console.error('[api-proxy] Error handling request', req.url, err)
            res.statusCode = 500
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: msg }))
          }
        })
      },
    },
  ],
})
