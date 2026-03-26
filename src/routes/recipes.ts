import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and, sql } from 'drizzle-orm'
import { db } from '../db/db.js'
import { recipes as recipesTable, users } from '../db/schema.js'
import { fullAuth, anyAuth } from '../middleware/auth.js'
import { parseRecipeFromHtml, parseRecipeFromText } from '../services/parser.js'
import { enrichRecipe } from '../services/claude.js'
import { buildRecipeEmbeddingText, embedRecipe, embedQuery } from '../services/embeddings.js'

export const recipes = new Hono()

// ─────────────────────────────────────────────
// POST /recipes/import/url
// Fetch a URL, parse recipe, enrich, embed, store
// Accepts both full and write-only keys
// ─────────────────────────────────────────────

recipes.post(
  '/import/url',
  anyAuth,
  zValidator('json', z.object({ url: z.string().url() })),
  async (c) => {
    const { url } = c.req.valid('json')
    const userId = await getOrCreateUserId()

    // Fetch the page
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    })

    if (!response.ok) {
      return c.json({ error: `Failed to fetch URL: ${response.status}` }, 422)
    }

    const html = await response.text()

    // Parse recipe from HTML
    const parsed = await parseRecipeFromHtml(html)
    if (!parsed) {
      return c.json({ error: 'No recipe found at this URL' }, 422)
    }

    // Enrich with nutrition and dietary tags if not already present
    const needsEnrichment =
      !parsed.dietaryTags ||
      parsed.dietaryTags.length === 0 ||
      (!parsed.calories && !parsed.proteinGrams)

    const enriched = needsEnrichment
      ? await enrichRecipe({
          name: parsed.name,
          ingredients: parsed.ingredients,
          instructions: parsed.instructions,
        })
      : { dietaryTags: [] }

    // Generate embedding
    const embeddingText = buildRecipeEmbeddingText({
      name: parsed.name,
      description: parsed.description,
      ingredients: parsed.ingredients,
      dietaryTags: parsed.dietaryTags ?? enriched.dietaryTags,
      cuisine: parsed.cuisine,
      category: parsed.category,
    })

    const embedding = await embedRecipe(embeddingText)

    // Store recipe
    const [recipe] = await db
      .insert(recipesTable)
      .values({
        userId,
        name: parsed.name,
        description: parsed.description ?? null,
        ingredients: parsed.ingredients,
        instructions: parsed.instructions,
        yield: parsed.yield ?? null,
        prepTimeMinutes: parsed.prepTimeMinutes ?? null,
        cookTimeMinutes: parsed.cookTimeMinutes ?? null,
        category: parsed.category ?? null,
        cuisine: parsed.cuisine ?? null,
        keywords: parsed.keywords ?? [],
        dietaryTags: parsed.dietaryTags ?? enriched.dietaryTags ?? [],
        calories: parsed.calories ?? enriched.calories ?? null,
        proteinGrams: parsed.proteinGrams ?? enriched.proteinGrams ?? null,
        fatGrams: parsed.fatGrams ?? enriched.fatGrams ?? null,
        carbGrams: parsed.carbGrams ?? enriched.carbGrams ?? null,
        sourceUrl: url,
        embedding,
      })
      .returning()

    const { embedding: _e, ...recipeData } = recipe
    return c.json({ success: true, recipe: recipeData })
  }
)

// ─────────────────────────────────────────────
// POST /recipes/import/text
// Parse recipe from raw text, enrich, embed, store
// Accepts both full and write-only keys
// ─────────────────────────────────────────────

recipes.post(
  '/import/text',
  anyAuth,
  zValidator('json', z.object({ text: z.string().min(10) })),
  async (c) => {
    const { text } = c.req.valid('json')
    const userId = await getOrCreateUserId()

    const parsed = await parseRecipeFromText(text)
    if (!parsed) {
      return c.json({ error: 'Could not extract a recipe from the provided text' }, 422)
    }

    const enriched = await enrichRecipe({
      name: parsed.name,
      ingredients: parsed.ingredients,
      instructions: parsed.instructions,
    })

    const embeddingText = buildRecipeEmbeddingText({
      name: parsed.name,
      description: parsed.description,
      ingredients: parsed.ingredients,
      dietaryTags: enriched.dietaryTags,
      cuisine: parsed.cuisine,
      category: parsed.category,
    })

    const embedding = await embedRecipe(embeddingText)

    const [recipe] = await db
      .insert(recipesTable)
      .values({
        userId,
        name: parsed.name,
        description: parsed.description ?? null,
        ingredients: parsed.ingredients,
        instructions: parsed.instructions,
        yield: parsed.yield ?? null,
        prepTimeMinutes: parsed.prepTimeMinutes ?? null,
        cookTimeMinutes: parsed.cookTimeMinutes ?? null,
        category: parsed.category ?? null,
        cuisine: parsed.cuisine ?? null,
        keywords: parsed.keywords ?? [],
        dietaryTags: enriched.dietaryTags ?? [],
        calories: parsed.calories ?? enriched.calories ?? null,
        proteinGrams: parsed.proteinGrams ?? enriched.proteinGrams ?? null,
        fatGrams: parsed.fatGrams ?? enriched.fatGrams ?? null,
        carbGrams: parsed.carbGrams ?? enriched.carbGrams ?? null,
        sourceUrl: null,
        embedding,
      })
      .returning()

    const { embedding: _e2, ...recipeData } = recipe
    return c.json({ success: true, recipe: recipeData })
  }
)

// ─────────────────────────────────────────────
// POST /recipes/search
// RAG vector search with optional filters
// ─────────────────────────────────────────────

recipes.post(
  '/search',
  fullAuth,
  zValidator(
    'json',
    z.object({
      query: z.string().min(1),
      limit: z.number().min(1).max(20).optional().default(10),
      minRating: z.number().min(1).max(5).optional(),
      dietaryTags: z.array(z.string()).optional(),
      excludeRecentDays: z.number().optional(), // exclude recipes used in last N days
    })
  ),
  async (c) => {
    const { query, limit, minRating, dietaryTags, excludeRecentDays } = c.req.valid('json')
    const userId = await getOrCreateUserId()

    // Embed the search query
    const queryEmbedding = await embedQuery(query)
    const embeddingStr = `[${queryEmbedding.join(',')}]`

    // Build the query using cosine similarity
    // Lower distance = more similar
    let baseQuery = db
      .select({
        id: recipesTable.id,
        name: recipesTable.name,
        description: recipesTable.description,
        cuisine: recipesTable.cuisine,
        category: recipesTable.category,
        dietaryTags: recipesTable.dietaryTags,
        prepTimeMinutes: recipesTable.prepTimeMinutes,
        cookTimeMinutes: recipesTable.cookTimeMinutes,
        calories: recipesTable.calories,
        proteinGrams: recipesTable.proteinGrams,
        rating: recipesTable.rating,
        ratingNote: recipesTable.ratingNote,
        sourceUrl: recipesTable.sourceUrl,
        similarity: sql<number>`1 - (embedding <=> ${embeddingStr}::vector)`,
      })
      .from(recipesTable)
      .where(eq(recipesTable.userId, userId))

    const results = await baseQuery
      .orderBy(sql`embedding <=> ${embeddingStr}::vector`)
      .limit(limit * 3) // over-fetch so we can filter in JS

    // Apply filters in JS — simpler than building complex SQL
    let filtered = results

    if (minRating) {
      filtered = filtered.filter(
        (r) => r.rating !== null && r.rating >= minRating
      )
    }

    if (dietaryTags && dietaryTags.length > 0) {
      filtered = filtered.filter((r) =>
        dietaryTags.every((tag) => r.dietaryTags?.includes(tag))
      )
    }

    if (excludeRecentDays) {
      const cutoffDate = new Date()
      cutoffDate.setDate(cutoffDate.getDate() - excludeRecentDays)
      const cutoff = cutoffDate.toISOString().split('T')[0]

      // Get recently used recipe IDs
      const recentlyUsed = await db.execute(
        sql`SELECT DISTINCT recipe_id FROM meal_plan_recipes 
            WHERE user_id = ${userId} 
            AND scheduled_date > ${cutoff}`
      )
      const recentIds = new Set(recentlyUsed.rows.map((r: any) => r.recipe_id))
      filtered = filtered.filter((r) => !recentIds.has(r.id))
    }

    return c.json({
      results: filtered.slice(0, limit),
      total: filtered.length,
    })
  }
)

// ─────────────────────────────────────────────
// PATCH /recipes/:id/rating
// Rate a recipe 1-5 with optional note
// ─────────────────────────────────────────────

recipes.patch(
  '/:id/rating',
  fullAuth,
  zValidator(
    'json',
    z.object({
      rating: z.number().min(1).max(5).int(),
      note: z.string().optional(),
    })
  ),
  async (c) => {
    const id = c.req.param('id')
    const { rating, note } = c.req.valid('json')
    const userId = await getOrCreateUserId()

    const [updated] = await db
      .update(recipesTable)
      .set({
        rating,
        ratingNote: note ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(recipesTable.id, id), eq(recipesTable.userId, userId)))
      .returning()

    if (!updated) {
      return c.json({ error: 'Recipe not found' }, 404)
    }

    return c.json({ success: true, recipe: updated })
  }
)

// ─────────────────────────────────────────────
// GET /recipes
// List all recipes for the user
// ─────────────────────────────────────────────

recipes.get('/', fullAuth, async (c) => {
  const userId = await getOrCreateUserId()

  const results = await db
    .select({
      id: recipesTable.id,
      name: recipesTable.name,
      cuisine: recipesTable.cuisine,
      category: recipesTable.category,
      dietaryTags: recipesTable.dietaryTags,
      prepTimeMinutes: recipesTable.prepTimeMinutes,
      cookTimeMinutes: recipesTable.cookTimeMinutes,
      calories: recipesTable.calories,
      rating: recipesTable.rating,
      createdAt: recipesTable.createdAt,
    })
    .from(recipesTable)
    .where(eq(recipesTable.userId, userId))
    .orderBy(recipesTable.createdAt)

  return c.json({ recipes: results, total: results.length })
})

// ─────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────

async function getOrCreateUserId(): Promise<string> {
  const existing = await db.select().from(users).limit(1)
  if (existing[0]) return existing[0].id

  const [created] = await db
    .insert(users)
    .values({ email: process.env.OWNER_EMAIL ?? 'owner@localhost' })
    .returning()

  return created.id
}