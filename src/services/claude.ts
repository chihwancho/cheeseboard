import Anthropic from '@anthropic-ai/sdk'

// Using DeepSeek's Anthropic-compatible endpoint — same SDK/message shape,
// far cheaper than Claude, no rewrite of the calls below needed.
const client = new Anthropic({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com/anthropic',
})

// Extended thinking can put a 'thinking' block before the 'text' block,
// so the text response isn't reliably at content[0].
export function getResponseText(response: Anthropic.Message): string | null {
  const block = response.content.find((b) => b.type === 'text')
  return block && block.type === 'text' ? block.text : null
}

export interface ExtractedRecipe {
  name: string
  description?: string
  ingredients: string[]
  instructions: string[]
  yield?: string
  prepTimeMinutes?: number
  cookTimeMinutes?: number
  category?: string
  cuisine?: string
  keywords?: string[]
  dietaryTags?: string[]
  calories?: number
  proteinGrams?: number
  fatGrams?: number
  carbGrams?: number
}

// Extract a recipe from raw HTML when Schema.org data isn't available
export async function extractRecipeFromHtml(html: string): Promise<ExtractedRecipe | null> {
  const response = await client.messages.create({
    model: 'deepseek-v4-pro',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: `Extract the recipe from this HTML and return ONLY a JSON object with no markdown or explanation.

Required fields: name, ingredients (string array), instructions (string array)
Optional fields: description, yield, prepTimeMinutes, cookTimeMinutes, category, cuisine, keywords (string array)

Return null if no recipe is found.

HTML:
${html}`,
      },
    ],
  })

  try {
    const text = getResponseText(response)
    if (!text) return null
    const clean = text.replace(/```json|```/g, '').trim()
    if (clean === 'null') return null
    return JSON.parse(clean)
  } catch {
    return null
  }
}

// Estimate nutrition and assign dietary tags for a recipe
export async function enrichRecipe(recipe: {
  name: string
  ingredients: string[]
  instructions: string[]
}): Promise<{
  calories?: number
  proteinGrams?: number
  fatGrams?: number
  carbGrams?: number
  dietaryTags: string[]
}> {
  const response = await client.messages.create({
    model: 'deepseek-v4-pro',
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: `Analyze this recipe and return ONLY a JSON object with no markdown or explanation.

Recipe: ${recipe.name}
Ingredients: ${recipe.ingredients.join(', ')}

Return this exact shape:
{
  "calories": <estimated calories per serving as integer, or null if unsure>,
  "proteinGrams": <estimated protein in grams as number, or null if unsure>,
  "fatGrams": <estimated fat in grams as number, or null if unsure>,
  "carbGrams": <estimated carbs in grams as number, or null if unsure>,
  "dietaryTags": <array of applicable tags from this list only: 
    high_protein, low_carb, keto, vegetarian, vegan, gluten_free, 
    dairy_free, low_calorie, high_fiber, mediterranean, paleo, whole30>
}`,
      },
    ],
  })

  try {
    const text = getResponseText(response)
    if (!text) return { dietaryTags: [] }
    const clean = text.replace(/```json|```/g, '').trim()
    return JSON.parse(clean)
  } catch {
    return { dietaryTags: [] }
  }
}

export interface IngredientMatch {
  recipeId: string
  usedIngredients: string[]
  missingIngredients: string[]
}

// Rank candidate recipes by how well they utilize a list of on-hand
// ingredients — prioritizes recipes using more on-hand ingredients and
// needing fewer additional ones. Not a plain overlap count: handles loose
// matching (e.g. "chicken" vs "2 lbs boneless chicken thighs").
export async function rankRecipesByIngredients(
  ingredients: string[],
  candidates: { id: string; name: string; ingredients: string[] }[],
  limit: number
): Promise<IngredientMatch[]> {
  const response = await client.messages.create({
    model: 'deepseek-v4-pro',
    max_tokens: 4000,
    messages: [
      {
        role: 'user',
        content: `You are a recipe matcher. Given a list of ingredients someone has on hand, rank the candidate recipes below by how well they utilize those ingredients — prioritize recipes that use more of the on-hand ingredients and require fewer additional ones.

On-hand ingredients:
${ingredients.join(', ')}

Candidate recipes:
${candidates.map(r => `- id: ${r.id}, name: "${r.name}", ingredients: ${r.ingredients.join('; ')}`).join('\n')}

Return ONLY a JSON array of the top ${limit} best matches, ordered best match first, no markdown, no explanation:
[
  {
    "recipeId": "uuid",
    "usedIngredients": ["on-hand ingredients this recipe actually uses"],
    "missingIngredients": ["other ingredients the recipe needs that aren't on hand"]
  }
]
Only include recipes that use at least one on-hand ingredient. Return fewer than ${limit} if fewer qualify.`,
      },
    ],
  })

  const text = getResponseText(response) ?? ''
  const clean = text.replace(/```json|```/g, '').trim()
  return JSON.parse(clean)
}