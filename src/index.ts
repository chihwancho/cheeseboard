import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { cors } from 'hono/cors'
import { createServer } from 'node:http'
import { recipes } from './routes/recipes.js'
import { plans } from './routes/plans.js'

const app = new Hono().basePath('/')

// CORS — required for bookmarklet requests from any domain
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'x-api-key'],
}))

app.get('/', (c) => c.json({ status: 'ok' }))
app.route('/recipes', recipes)
app.route('/plans', plans)

// Vercel exports
export const GET = handle(app)
export const POST = handle(app)
export const PATCH = handle(app)
export const DELETE = handle(app)
export const OPTIONS = handle(app)

// Local dev server
if (process.env.NODE_ENV !== 'production') {
  const port = 3000
  createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`)
    const headers = new Headers()
    Object.entries(req.headers).forEach(([k, v]) => {
      if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
    })
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? Buffer.concat(chunks) : undefined

    const request = new Request(url, {
      method: req.method,
      headers,
      body: body && body.length > 0 ? body : undefined,
    })

    const response = await app.fetch(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  }).listen(port, () => {
    console.log(`Server running at http://localhost:${port}`)
  })
}