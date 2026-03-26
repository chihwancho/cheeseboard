import { createMiddleware } from 'hono/factory'

type AuthType = 'full' | 'any'

// Full auth — only accepts the full API key
// Used for read endpoints and meal planning
export const fullAuth = createMiddleware(async (c, next) => {
  const apiKey = c.req.header('x-api-key')

  if (!apiKey || apiKey !== process.env.API_KEY) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  await next()
})

// Any auth — accepts both full and write-only keys
// Used for recipe import so bookmarklet can write
export const anyAuth = createMiddleware(async (c, next) => {
  const apiKey = c.req.header('x-api-key')

  const isFullKey = apiKey === process.env.API_KEY
  const isWriteOnlyKey = apiKey === process.env.BOOKMARKLET_KEY

  if (!isFullKey && !isWriteOnlyKey) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  await next()
})
