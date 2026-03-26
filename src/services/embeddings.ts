import { VoyageAIClient } from 'voyageai'

const client = new VoyageAIClient({
  apiKey: process.env.VOYAGE_API_KEY,
})

// Build a text representation of a recipe for embedding
// Combines the most semantically meaningful fields
export function buildRecipeEmbeddingText(recipe: {
  name: string
  description?: string | null
  ingredients: string[]
  dietaryTags?: string[] | null
  cuisine?: string | null
  category?: string | null
}): string {
  const parts = [
    recipe.name,
    recipe.description ?? '',
    recipe.cuisine ?? '',
    recipe.category ?? '',
    (recipe.dietaryTags ?? []).join(' '),
    (recipe.ingredients ?? []).join(' '),
  ]
  return parts.filter(Boolean).join(' ')
}

// Embed a single recipe for storage
export async function embedRecipe(text: string): Promise<number[]> {
  const result = await client.embed({
    input: [text],
    model: 'voyage-3.5',
    inputType: 'document',
  })
  return result.data?.[0].embedding ?? []
}

// Embed a search query
export async function embedQuery(query: string): Promise<number[]> {
  const result = await client.embed({
    input: [query],
    model: 'voyage-3.5',
    inputType: 'query',
  })
  return result.data?.[0].embedding ?? []
}