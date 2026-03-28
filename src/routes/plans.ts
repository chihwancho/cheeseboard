import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and, inArray } from 'drizzle-orm'
import { db } from '../db/db.js'
import { recipes as recipesTable, mealPlans, mealPlanRecipes, shoppingLists, users } from '../db/schema.js'
import { fullAuth } from '../middleware/auth.js'
import { embedQuery } from '../services/embeddings.js'
import { sql } from 'drizzle-orm'
import Anthropic from '@anthropic-ai/sdk'

export const plans = new Hono()

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─────────────────────────────────────────────
// POST /plans
// Generate a meal plan for N days across
// breakfast, lunch, dinner, snack slots
// ─────────────────────────────────────────────

plans.post(
  '/',
  fullAuth,
  zValidator(
    'json',
    z.object({
      name: z.string().optional(),
      days: z.number().min(1).max(14).default(7),
      slots: z.array(z.enum(['breakfast', 'lunch', 'dinner', 'snack'])).default(['breakfast', 'lunch', 'dinner']),
      constraints: z.object({
        dietaryTags: z.array(z.string()).optional(),
        excludeIngredients: z.array(z.string()).optional(),
        maxCaloriesPerDay: z.number().optional(),
        minRating: z.number().min(1).max(5).optional(),
        excludeRecentDays: z.number().optional().default(14),
      }).optional().default({}),
    })
  ),
  async (c) => {
    const { name, days, slots, constraints } = c.req.valid('json')
    const userId = await getOrCreateUserId()
    const startDate = new Date()

    // ─────────────────────────────────────────
    // Fetch candidate recipes for each slot type
    // ─────────────────────────────────────────

    const slotQueries: Record<string, string> = {
      breakfast: 'breakfast morning meal eggs pancakes oats yogurt',
      lunch: 'lunch sandwich salad soup light meal',
      dinner: 'dinner main course hearty meal',
      snack: 'snack light bite appetizer',
    }

    // Build exclude list from recent meal plans
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - (constraints.excludeRecentDays ?? 14))
    const cutoffStr = cutoff.toISOString().split('T')[0]

    const recentlyUsed = await db.execute(
      sql`SELECT DISTINCT recipe_id FROM meal_plan_recipes 
          WHERE user_id = ${userId} 
          AND scheduled_date > ${cutoffStr}`
    )
    const recentIds = new Set(recentlyUsed.rows.map((r: any) => r.recipe_id))

    // Fetch candidates per slot
    const candidatesBySlot: Record<string, any[]> = {}

    for (const slot of slots) {
      const query = slotQueries[slot]
      const queryEmbedding = await embedQuery(query)
      const embeddingStr = `[${queryEmbedding.join(',')}]`

      let results = await db
        .select({
          id: recipesTable.id,
          name: recipesTable.name,
          ingredients: recipesTable.ingredients,
          category: recipesTable.category,
          dietaryTags: recipesTable.dietaryTags,
          calories: recipesTable.calories,
          prepTimeMinutes: recipesTable.prepTimeMinutes,
          cookTimeMinutes: recipesTable.cookTimeMinutes,
          rating: recipesTable.rating,
        })
        .from(recipesTable)
        .where(eq(recipesTable.userId, userId))
        .orderBy(sql`embedding <=> ${embeddingStr}::vector`)
        .limit(20)

      // Apply filters
      if (recentIds.size > 0) {
        results = results.filter(r => !recentIds.has(r.id))
      }
      if (constraints.minRating) {
        results = results.filter(r => r.rating !== null && r.rating >= constraints.minRating!)
      }
      if (constraints.dietaryTags && constraints.dietaryTags.length > 0) {
        results = results.filter(r =>
          constraints.dietaryTags!.every(tag => r.dietaryTags?.includes(tag))
        )
      }

      candidatesBySlot[slot] = results.slice(0, 10)
    }

    // ─────────────────────────────────────────
    // Ask Claude to assign recipes to days/slots
    // ─────────────────────────────────────────

    const prompt = `You are a meal planner. Create a ${days}-day meal plan using only the recipes provided below.

Slots per day: ${slots.join(', ')}
${constraints.maxCaloriesPerDay ? `Max calories per day: ${constraints.maxCaloriesPerDay}` : ''}
${constraints.excludeIngredients ? `Avoid ingredients: ${constraints.excludeIngredients.join(', ')}` : ''}

Rules:
- Use each recipe at most twice across the whole plan
- Vary meals — don't repeat the same recipe on consecutive days
- Prefer higher-rated recipes when available
- If not enough candidates for a slot, leave it null

Available recipes by slot:
${Object.entries(candidatesBySlot).map(([slot, recipes]) =>
  `${slot.toUpperCase()}:\n${recipes.map(r =>
    `  - id: ${r.id}, name: "${r.name}", calories: ${r.calories ?? 'unknown'}, rating: ${r.rating ?? 'unrated'}`
  ).join('\n')}`
).join('\n\n')}

Return ONLY a JSON array, no markdown, no explanation:
[
  {
    "date": "YYYY-MM-DD",
    "slots": {
      "breakfast": { "recipeId": "uuid or null", "recipeName": "name or null" },
      "lunch": { "recipeId": "uuid or null", "recipeName": "name or null" },
      "dinner": { "recipeId": "uuid or null", "recipeName": "name or null" },
      "snack": { "recipeId": "uuid or null", "recipeName": "name or null" }
    }
  }
]
Only include slot keys for: ${slots.join(', ')}`

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    let planDays: any[] = []

    try {
      const clean = text.replace(/```json|```/g, '').trim()
      planDays = JSON.parse(clean)
    } catch {
      return c.json({ error: 'Failed to generate meal plan' }, 500)
    }

    // Fill dates starting from today
    planDays = planDays.map((day: any, i: number) => {
      const date = new Date(startDate)
      date.setDate(date.getDate() + i)
      return { ...day, date: date.toISOString().split('T')[0] }
    })

    // ─────────────────────────────────────────
    // Check for overlapping active plans
    // ─────────────────────────────────────────

    const planName = name ?? `Meal plan — ${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    const endDate = new Date(startDate)
    endDate.setDate(endDate.getDate() + days - 1)

    const startDateStr = startDate.toISOString().split('T')[0]
    const endDateStr = endDate.toISOString().split('T')[0]

    const overlapping = await db
      .select({ id: mealPlans.id, name: mealPlans.name, startDate: mealPlans.startDate, endDate: mealPlans.endDate })
      .from(mealPlans)
      .where(
        and(
          eq(mealPlans.userId, userId),
          eq(mealPlans.isActive, true),
          sql`${mealPlans.startDate} <= ${endDateStr}`,
          sql`${mealPlans.endDate} >= ${startDateStr}`
        )
      )

    // If overlapping plans exist, return a warning so the user can confirm
    const { force } = await c.req.json().catch(() => ({})) as any
    if (overlapping.length > 0 && !force) {
      return c.json({
        conflict: true,
        message: `This overlaps with ${overlapping.length} existing plan${overlapping.length > 1 ? 's' : ''}: ${overlapping.map(p => `"${p.name}" (${p.startDate} to ${p.endDate})`).join(', ')}. Pass force: true to replace.`,
        overlapping,
      }, 409)
    }

    // Deactivate overlapping plans
    if (overlapping.length > 0) {
      for (const plan of overlapping) {
        await db
          .update(mealPlans)
          .set({ isActive: false })
          .where(eq(mealPlans.id, plan.id))
      }
    }

    // ─────────────────────────────────────────
    // Save meal plan
    // ─────────────────────────────────────────

    const [mealPlan] = await db
      .insert(mealPlans)
      .values({
        userId,
        name: planName,
        startDate: startDateStr,
        endDate: endDateStr,
        constraints,
        plan: planDays,
        isActive: true,
      })
      .returning()

    // Save meal plan recipes for recency tracking
    const mealPlanRecipeRows: any[] = []
    for (const day of planDays) {
      for (const slot of slots) {
        const entry = day.slots[slot]
        if (entry?.recipeId) {
          mealPlanRecipeRows.push({
            mealPlanId: mealPlan.id,
            recipeId: entry.recipeId,
            userId,
            scheduledDate: day.date,
            mealSlot: slot,
          })
        }
      }
    }

    if (mealPlanRecipeRows.length > 0) {
      await db.insert(mealPlanRecipes).values(mealPlanRecipeRows)
    }

    return c.json({ success: true, mealPlan })
  }
)

// ─────────────────────────────────────────────
// GET /plans
// List active meal plans only
// ─────────────────────────────────────────────

plans.get('/', fullAuth, async (c) => {
  const userId = await getOrCreateUserId()
  const includeInactive = c.req.query('includeInactive') === 'true'

  const conditions = includeInactive
    ? and(eq(mealPlans.userId, userId), sql`${mealPlans.deletedAt} IS NULL`)
    : and(eq(mealPlans.userId, userId), eq(mealPlans.isActive, true), sql`${mealPlans.deletedAt} IS NULL`)

  const results = await db
    .select({
      id: mealPlans.id,
      name: mealPlans.name,
      startDate: mealPlans.startDate,
      endDate: mealPlans.endDate,
      isActive: mealPlans.isActive,
      createdAt: mealPlans.createdAt,
    })
    .from(mealPlans)
    .where(conditions)
    .orderBy(mealPlans.startDate)

  return c.json({ mealPlans: results, total: results.length })
})

// ─────────────────────────────────────────────
// DELETE /plans/:id
// Soft delete a meal plan
// ─────────────────────────────────────────────

plans.delete('/:id', fullAuth, async (c) => {
  const id = c.req.param('id')
  const userId = await getOrCreateUserId()

  const [updated] = await db
    .update(mealPlans)
    .set({ deletedAt: new Date(), isActive: false })
    .where(and(eq(mealPlans.id, id), eq(mealPlans.userId, userId)))
    .returning()

  if (!updated) {
    return c.json({ error: 'Meal plan not found' }, 404)
  }

  return c.json({ success: true })
})

// ─────────────────────────────────────────────
// GET /plans/:id
// Get a single meal plan with full detail
// ─────────────────────────────────────────────

plans.get('/:id', fullAuth, async (c) => {
  const id = c.req.param('id')
  const userId = await getOrCreateUserId()

  const result = await db
    .select()
    .from(mealPlans)
    .where(and(eq(mealPlans.id, id), eq(mealPlans.userId, userId)))
    .limit(1)

  if (!result[0]) {
    return c.json({ error: 'Meal plan not found' }, 404)
  }

  return c.json({ mealPlan: result[0] })
})

// ─────────────────────────────────────────────
// POST /plans/:id/shopping-list
// Generate a shopping list from a meal plan
// ─────────────────────────────────────────────

plans.post('/:id/shopping-list', fullAuth, async (c) => {
  const mealPlanId = c.req.param('id')
  const userId = await getOrCreateUserId()

  // Get meal plan
  const planResult = await db
    .select()
    .from(mealPlans)
    .where(and(eq(mealPlans.id, mealPlanId), eq(mealPlans.userId, userId)))
    .limit(1)

  if (!planResult[0]) {
    return c.json({ error: 'Meal plan not found' }, 404)
  }

  // Get all recipes in this plan
  const planRecipeRows = await db
    .select()
    .from(mealPlanRecipes)
    .where(and(
      eq(mealPlanRecipes.mealPlanId, mealPlanId),
      eq(mealPlanRecipes.userId, userId)
    ))

  if (planRecipeRows.length === 0) {
    return c.json({ error: 'No recipes in this meal plan' }, 422)
  }

  const recipeIds = [...new Set(planRecipeRows.map(r => r.recipeId))]

  const recipeDetails = await db
    .select({
      id: recipesTable.id,
      name: recipesTable.name,
      ingredients: recipesTable.ingredients,
    })
    .from(recipesTable)
    .where(inArray(recipesTable.id, recipeIds))

  // Build ingredient list with recipe attribution
  const ingredientLines = recipeDetails.flatMap(recipe => {
    const ingredients = recipe.ingredients as string[]
    return ingredients.map(ing => `${ing} [from: ${recipe.name}]`)
  })

  // Ask Claude to aggregate and categorize
  const prompt = `You are a shopping list organizer. Given this list of ingredients (with recipe attribution in brackets), create a clean categorized shopping list.

Rules:
- Combine duplicate or similar ingredients (e.g. "2 eggs [from: pancakes]" + "3 eggs [from: scrambled eggs]" = "5 eggs")
- Normalize units where possible (e.g. 1/2 cup + 4 tablespoons = 3/4 cup)
- Group by grocery category: produce, dairy, meat, seafood, pantry, bakery, frozen, other
- For each item, list which recipes use it in parentheses
- Keep ingredient names simple and clear

Ingredients:
${ingredientLines.join('\n')}

Return ONLY a JSON object, no markdown, no explanation:
{
  "produce": [
    { "item": "ingredient with quantity", "recipes": ["recipe name 1", "recipe name 2"] }
  ],
  "dairy": [...],
  "meat": [...],
  "seafood": [...],
  "pantry": [...],
  "bakery": [...],
  "frozen": [...],
  "other": [...]
}
Only include categories that have items.`

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  let items: any = {}

  try {
    const clean = text.replace(/```json|```/g, '').trim()
    items = JSON.parse(clean)
  } catch {
    return c.json({ error: 'Failed to generate shopping list' }, 500)
  }

  // Save shopping list
  const [shoppingList] = await db
    .insert(shoppingLists)
    .values({
      userId,
      mealPlanId,
      name: `Shopping list — ${planResult[0].name}`,
      items,
    })
    .returning()

  return c.json({ success: true, shoppingList })
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