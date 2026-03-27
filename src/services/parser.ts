import { extractRecipeFromHtml, type ExtractedRecipe } from './claude.js'

// Parse Schema.org/Recipe JSON-LD from HTML
function extractSchemaOrg(html: string): ExtractedRecipe | null {
  try {
    // Find all JSON-LD script tags
    const scriptRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
    let match

    while ((match = scriptRegex.exec(html)) !== null) {
      try {
        const data = JSON.parse(match[1])

        // Handle both single objects and arrays
        const items = Array.isArray(data) ? data : [data]
        const recipe = items.find(
          (item: any) =>
            item['@type'] === 'Recipe' ||
            (Array.isArray(item['@type']) && item['@type'].includes('Recipe'))
        )

        if (recipe) {
          return normalizeSchemaOrg(recipe)
        }
      } catch {
        continue
      }
    }
    return null
  } catch {
    return null
  }
}

// Normalize Schema.org recipe to our format
function normalizeSchemaOrg(schema: any): ExtractedRecipe {
  // Parse ISO 8601 duration e.g. "PT30M" → 30
  const parseDuration = (iso?: string): number | undefined => {
    if (!iso) return undefined
    const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/)
    if (!match) return undefined
    const hours = parseInt(match[1] ?? '0')
    const minutes = parseInt(match[2] ?? '0')
    return hours * 60 + minutes
  }

  // Normalize instructions — can be string[], HowToStep[], or HowToSection[]
  const parseInstructions = (raw: any): string[] => {
    if (!raw) return []
    if (typeof raw === 'string') return [raw]
    if (Array.isArray(raw)) {
      return raw.flatMap((step: any) => {
        if (typeof step === 'string') return [step]
        if (step['@type'] === 'HowToStep') return [step.text ?? step.name ?? '']
        if (step['@type'] === 'HowToSection') {
          return parseInstructions(step.itemListElement)
        }
        return []
      }).filter(Boolean)
    }
    return []
  }

  // Normalize ingredients — always string[]
  const parseIngredients = (raw: any): string[] => {
    if (!raw) return []
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
    if (typeof raw === 'string') return [raw]
    return []
  }

  // Nutrition block
  const nutrition = schema.nutrition ?? {}

  return {
    name: schema.name ?? 'Untitled Recipe',
    description: schema.description,
    ingredients: parseIngredients(schema.recipeIngredient),
    instructions: parseInstructions(schema.recipeInstructions),
    yield: schema.recipeYield
      ? Array.isArray(schema.recipeYield)
        ? schema.recipeYield[0]
        : String(schema.recipeYield)
      : undefined,
    prepTimeMinutes: parseDuration(schema.prepTime),
    cookTimeMinutes: parseDuration(schema.cookTime),
    category: schema.recipeCategory,
    cuisine: schema.recipeCuisine,
    keywords: schema.keywords
      ? schema.keywords.split(',').map((k: string) => k.trim())
      : undefined,
    calories: nutrition.calories
      ? parseInt(nutrition.calories)
      : undefined,
    proteinGrams: nutrition.proteinContent
      ? parseFloat(nutrition.proteinContent)
      : undefined,
    fatGrams: nutrition.fatContent
      ? parseFloat(nutrition.fatContent)
      : undefined,
    carbGrams: nutrition.carbohydrateContent
      ? parseFloat(nutrition.carbohydrateContent)
      : undefined,
  }
}

// Strip HTML tags and truncate to avoid token limits
function extractTextFromHtml(html: string): string {
  // Remove script and style tags entirely
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // Truncate to ~15000 chars which is well within Claude's limits
  if (text.length > 15000) {
    text = text.substring(0, 15000)
  }

  return text
}

// Main parser — tries Schema.org first, falls back to Claude
export async function parseRecipeFromHtml(html: string): Promise<ExtractedRecipe | null> {
  // Try Schema.org first — free and fast
  const schemaRecipe = extractSchemaOrg(html)
  if (schemaRecipe && schemaRecipe.ingredients.length > 0) {
    return schemaRecipe
  }

  // Fall back to Claude extraction with stripped/truncated text
  const cleanText = extractTextFromHtml(html)
  return extractRecipeFromHtml(cleanText)
}

// Parse a recipe from raw text (for manual entry or paste)
export async function parseRecipeFromText(text: string): Promise<ExtractedRecipe | null> {
  const truncated = text.length > 15000 ? text.substring(0, 15000) : text
  return extractRecipeFromHtml(truncated)
}