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

        // Handle single objects, arrays, and the common WordPress/Yoast
        // pattern of a single object wrapping an "@graph" array
        const items = Array.isArray(data)
          ? data
          : Array.isArray(data?.['@graph'])
            ? data['@graph']
            : [data]
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

  // Normalize images — can be a URL string, array of URL strings, a single
  // ImageObject ({url: ...}), or an array of ImageObjects
  const parseImages = (raw: any): string[] => {
    if (!raw) return []
    const items = Array.isArray(raw) ? raw : [raw]
    return items
      .map((item: any) => (typeof item === 'string' ? item : item?.url))
      .filter(Boolean)
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
    images: parseImages(schema.image),
  }
}

// Fallback hero image when schema.org has none (or the LLM extraction path
// runs instead, which can't see images at all since it only gets stripped
// text) — og:image is present on nearly every modern recipe site.
function extractOgImage(html: string): string[] {
  const match =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
  return match ? [match[1]] : []
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
    if (!schemaRecipe.images?.length) {
      schemaRecipe.images = extractOgImage(html)
    }
    return schemaRecipe
  }

  // Fall back to Claude extraction with stripped/truncated text — that text
  // has no image URLs left in it, so pull a hero image separately from the
  // raw HTML instead.
  const cleanText = extractTextFromHtml(html)
  const extracted = await extractRecipeFromHtml(cleanText)
  if (!extracted) return null
  return { ...extracted, images: extractOgImage(html) }
}

// Parse a recipe from raw text — either a hand-typed/pasted recipe, or a
// full page's outerHTML (e.g. from the save-recipe bookmarklet, which sends
// the whole rendered page since some sites block server-side URL fetches).
export async function parseRecipeFromText(text: string): Promise<ExtractedRecipe | null> {
  if (looksLikeHtml(text)) {
    return parseRecipeFromHtml(text)
  }

  const truncated = text.length > 15000 ? text.substring(0, 15000) : text
  return extractRecipeFromHtml(truncated)
}

function looksLikeHtml(text: string): boolean {
  return /<[a-z][\s\S]*>/i.test(text)
}