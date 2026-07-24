import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and, sql, inArray } from 'drizzle-orm'
import { db } from '../db/db.js'
import { recipes as recipesTable, users, recipeColumns } from '../db/schema.js'
import { fullAuth, anyAuth } from '../middleware/auth.js'
import { parseRecipeFromHtml, parseRecipeFromText } from '../services/parser.js'
import { enrichRecipe, rankRecipesByIngredients } from '../services/claude.js'
import { buildRecipeEmbeddingText, embedRecipe, embedQuery } from '../services/embeddings.js'
import { generateShoppingListItems } from './plans.js'

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
        images: parsed.images ?? [],
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
        images: parsed.images ?? [],
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
// POST /recipes/match-ingredients
// Rank recipes by how well they utilize a list
// of on-hand ingredients
// ─────────────────────────────────────────────

recipes.post(
  '/match-ingredients',
  fullAuth,
  zValidator(
    'json',
    z.object({
      ingredients: z.array(z.string().min(1)).min(1),
      limit: z.number().min(1).max(20).optional().default(5),
    })
  ),
  async (c) => {
    const { ingredients, limit } = c.req.valid('json')
    const userId = await getOrCreateUserId()

    // Narrow the whole library to a relevant candidate pool before
    // asking Claude to do the actual ingredient-coverage ranking
    const queryEmbedding = await embedQuery(ingredients.join(', '))
    const embeddingStr = `[${queryEmbedding.join(',')}]`

    const candidates = await db
      .select({
        id: recipesTable.id,
        name: recipesTable.name,
        ingredients: recipesTable.ingredients,
      })
      .from(recipesTable)
      .where(eq(recipesTable.userId, userId))
      .orderBy(sql`embedding <=> ${embeddingStr}::vector`)
      .limit(30)

    if (candidates.length === 0) {
      return c.json({ error: 'No recipes in your library yet' }, 404)
    }

    let ranked
    try {
      ranked = await rankRecipesByIngredients(
        ingredients,
        candidates.map((r) => ({ id: r.id, name: r.name, ingredients: r.ingredients as string[] })),
        limit
      )
    } catch {
      return c.json({ error: 'Failed to match ingredients to recipes' }, 500)
    }

    const top = ranked.slice(0, limit)
    const recipeDetails = await db
      .select(recipeColumns)
      .from(recipesTable)
      .where(inArray(recipesTable.id, top.map((r) => r.recipeId)))

    const recipeById = new Map(recipeDetails.map((r) => [r.id, r]))

    const matches = top
      .map((t) => {
        const recipe = recipeById.get(t.recipeId)
        if (!recipe) return null
        return {
          recipe,
          usedIngredients: t.usedIngredients,
          missingIngredients: t.missingIngredients,
        }
      })
      .filter((m): m is NonNullable<typeof m> => m !== null)

    return c.json({ matches })
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
      description: recipesTable.description,
      cuisine: recipesTable.cuisine,
      category: recipesTable.category,
      dietaryTags: recipesTable.dietaryTags,
      prepTimeMinutes: recipesTable.prepTimeMinutes,
      cookTimeMinutes: recipesTable.cookTimeMinutes,
      calories: recipesTable.calories,
      rating: recipesTable.rating,
      images: recipesTable.images,
      createdAt: recipesTable.createdAt,
    })
    .from(recipesTable)
    .where(eq(recipesTable.userId, userId))
    .orderBy(recipesTable.createdAt)

  return c.json({ recipes: results, total: results.length })
})

// ─────────────────────────────────────────────
// GET /recipes/random
// A random recipe, optionally filtered by a
// dietary tag, plus a shopping list for it
// ─────────────────────────────────────────────

recipes.get('/random', fullAuth, async (c) => {
  const userId = await getOrCreateUserId()
  const tag = c.req.query('tag')

  const conditions = tag
    ? and(eq(recipesTable.userId, userId), sql`${recipesTable.dietaryTags} @> ARRAY[${tag}]::text[]`)
    : eq(recipesTable.userId, userId)

  const [recipe] = await db
    .select(recipeColumns)
    .from(recipesTable)
    .where(conditions)
    .orderBy(sql`random()`)
    .limit(1)

  if (!recipe) {
    return c.json({ error: tag ? `No recipes found with tag "${tag}"` : 'No recipes found' }, 404)
  }

  let shoppingList: Record<string, { item: string; recipes: string[] }[]>
  try {
    shoppingList = await generateShoppingListItems([
      { name: recipe.name, ingredients: recipe.ingredients as string[] },
    ])
  } catch {
    return c.json({ error: 'Failed to generate shopping list' }, 500)
  }

  return c.json({
    date: null,
    meals: [{ mealSlot: null, recipe }],
    shoppingList,
  })
})

// ─────────────────────────────────────────────
// GET /recipes/:id
// Fetch a single recipe by id
// ─────────────────────────────────────────────

recipes.get('/:id', fullAuth, async (c) => {
  const id = c.req.param('id')
  const userId = await getOrCreateUserId()

  const [recipe] = await db
    .select(recipeColumns)
    .from(recipesTable)
    .where(and(eq(recipesTable.id, id), eq(recipesTable.userId, userId)))
    .limit(1)

  if (!recipe) {
    return c.json({ error: 'Recipe not found' }, 404)
  }

  return c.json({ recipe })
})

// ─────────────────────────────────────────────
// DELETE /recipes/:id
// Permanently delete a recipe. Also removes it
// from any meal plans it was scheduled in
// (meal_plan_recipes has an onDelete cascade).
// ─────────────────────────────────────────────

recipes.delete('/:id', fullAuth, async (c) => {
  const id = c.req.param('id')
  const userId = await getOrCreateUserId()

  const [deleted] = await db
    .delete(recipesTable)
    .where(and(eq(recipesTable.id, id), eq(recipesTable.userId, userId)))
    .returning({ id: recipesTable.id, name: recipesTable.name })

  if (!deleted) {
    return c.json({ error: 'Recipe not found' }, 404)
  }

  return c.json({ success: true, deleted })
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