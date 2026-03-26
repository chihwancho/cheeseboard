import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { serve } from '@hono/node-server'
import { recipes } from './routes/recipes.js'

const app = new Hono().basePath('/')

app.get('/', (c) => c.json({ status: 'ok' }))
app.route('/recipes', recipes)

// Vercel exports
export const GET = handle(app)
export const POST = handle(app)
export const PATCH = handle(app)
export const DELETE = handle(app)

// Local dev server
if (process.env.NODE_ENV !== 'production') {
  serve({ fetch: app.fetch, port: 3000 }, () => {
    console.log('Server running at http://localhost:3000')
  })
}