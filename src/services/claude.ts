import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
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
    model: 'claude-sonnet-5',
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
    model: 'claude-sonnet-5',
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