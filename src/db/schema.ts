import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { vector } from 'drizzle-orm/pg-core'

// ─────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────

export const keyTypeEnum = pgEnum('key_type', ['full', 'write_only'])

// ─────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ─────────────────────────────────────────────
// API Keys
// Supports full access and write-only bookmarklet keys
// ─────────────────────────────────────────────

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    keyHash: text('key_hash').notNull(),      // bcrypt hash — never store plaintext
    keyPrefix: text('key_prefix').notNull(),  // first 8 chars for display e.g. "sk_wr_ab"
    type: keyTypeEnum('type').notNull(),
    label: text('label'),                     // "bookmarklet", "mcp server" etc.
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('api_keys_user_id_idx').on(table.userId),
    keyHashIdx: uniqueIndex('api_keys_key_hash_idx').on(table.keyHash),
  })
)

// ─────────────────────────────────────────────
// Recipes
// Stores Schema.org/Recipe compatible data
// with pgvector embedding for RAG search
// ─────────────────────────────────────────────

export const recipes = pgTable(
  'recipes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // Core fields
    name: text('name').notNull(),
    description: text('description'),
    ingredients: jsonb('ingredients').notNull(),   // string[] — raw from Schema.org
    instructions: jsonb('instructions').notNull(), // string[] — steps
    yield: text('yield'),                          // "4 servings"

    // Timing
    prepTimeMinutes: integer('prep_time_minutes'),
    cookTimeMinutes: integer('cook_time_minutes'),

    // Classification
    category: text('category'),                    // "Breakfast", "Dinner" etc.
    cuisine: text('cuisine'),                      // "Italian", "Mexican" etc.
    keywords: text('keywords').array(),
    dietaryTags: text('dietary_tags').array(),     // ['high_protein', 'gluten_free', 'keto']

    // Nutrition — estimated by Claude if not provided by source
    calories: integer('calories'),
    proteinGrams: real('protein_grams'),
    fatGrams: real('fat_grams'),
    carbGrams: real('carb_grams'),

    // Source
    sourceUrl: text('source_url'),

    // User rating — 1 to 5, null if not yet rated
    rating: integer('rating'),
    ratingNote: text('rating_note'),              // optional note e.g. "too spicy, reduce chili"

    // RAG embedding — voyage-3.5 uses 1024 dimensions
    // Embed: name + description + ingredients + dietary tags
    embedding: vector('embedding', { dimensions: 1024 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('recipes_user_id_idx').on(table.userId),
    // HNSW index for fast approximate nearest neighbor search
    // More efficient than exact search for large recipe libraries
    embeddingIdx: index('recipes_embedding_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops')
    ),
  })
)

// ─────────────────────────────────────────────
// Meal Plans
// Stores generated meal plans with constraints
// ─────────────────────────────────────────────

export const mealPlans = pgTable(
  'meal_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    startDate: text('start_date').notNull(),
    endDate: text('end_date').notNull(),
    constraints: jsonb('constraints'),
    plan: jsonb('plan').notNull(),
    isActive: boolean('is_active').notNull().default(true),   // false = superseded or deleted
    deletedAt: timestamp('deleted_at', { withTimezone: true }), // soft delete
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('meal_plans_user_id_idx').on(table.userId),
    userActiveIdx: index('meal_plans_user_active_idx').on(table.userId, table.isActive),
  })
)

// ─────────────────────────────────────────────
// Shopping Lists
// Aggregated and categorized by Claude
// ─────────────────────────────────────────────

export const shoppingLists = pgTable(
  'shopping_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mealPlanId: uuid('meal_plan_id')
      .references(() => mealPlans.id, { onDelete: 'set null' }),
    name: text('name').notNull(),                 // "Week of March 25 shopping list"
    items: jsonb('items').notNull(),              // { produce: [], dairy: [], meat: [] etc. }
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('shopping_lists_user_id_idx').on(table.userId),
  })
)

// ─────────────────────────────────────────────
// Meal Plan Recipes
// Join table tracking which recipes appear in
// which meal plans, and when.
// Enables queries like:
// "highly rated recipes not used in last 2 weeks"
// ─────────────────────────────────────────────

export const mealPlanRecipes = pgTable(
  'meal_plan_recipes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mealPlanId: uuid('meal_plan_id')
      .notNull()
      .references(() => mealPlans.id, { onDelete: 'cascade' }),
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scheduledDate: text('scheduled_date'),          // ISO date — which day in the plan
    mealSlot: text('meal_slot'),                    // 'breakfast' | 'lunch' | 'dinner' | 'snack'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    mealPlanIdIdx: index('meal_plan_recipes_plan_id_idx').on(table.mealPlanId),
    recipeIdIdx: index('meal_plan_recipes_recipe_id_idx').on(table.recipeId),
    userIdIdx: index('meal_plan_recipes_user_id_idx').on(table.userId),
  })
)

// ─────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  apiKeys: many(apiKeys),
  recipes: many(recipes),
  mealPlans: many(mealPlans),
  shoppingLists: many(shoppingLists),
  mealPlanRecipes: many(mealPlanRecipes),
}))

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
}))

export const recipesRelations = relations(recipes, ({ one, many }) => ({
  user: one(users, {
    fields: [recipes.userId],
    references: [users.id],
  }),
  mealPlanRecipes: many(mealPlanRecipes),
}))

export const mealPlansRelations = relations(mealPlans, ({ one, many }) => ({
  user: one(users, {
    fields: [mealPlans.userId],
    references: [users.id],
  }),
  shoppingLists: many(shoppingLists),
  mealPlanRecipes: many(mealPlanRecipes),
}))

export const shoppingListsRelations = relations(shoppingLists, ({ one }) => ({
  user: one(users, {
    fields: [shoppingLists.userId],
    references: [users.id],
  }),
  mealPlan: one(mealPlans, {
    fields: [shoppingLists.mealPlanId],
    references: [mealPlans.id],
  }),
}))

export const mealPlanRecipesRelations = relations(mealPlanRecipes, ({ one }) => ({
  mealPlan: one(mealPlans, {
    fields: [mealPlanRecipes.mealPlanId],
    references: [mealPlans.id],
  }),
  recipe: one(recipes, {
    fields: [mealPlanRecipes.recipeId],
    references: [recipes.id],
  }),
  user: one(users, {
    fields: [mealPlanRecipes.userId],
    references: [users.id],
  }),
}))

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

export type ApiKey = typeof apiKeys.$inferSelect
export type NewApiKey = typeof apiKeys.$inferInsert

export type Recipe = typeof recipes.$inferSelect
export type NewRecipe = typeof recipes.$inferInsert

export type MealPlan = typeof mealPlans.$inferSelect
export type NewMealPlan = typeof mealPlans.$inferInsert

export type MealPlanRecipe = typeof mealPlanRecipes.$inferSelect
export type NewMealPlanRecipe = typeof mealPlanRecipes.$inferInsert

export type ShoppingList = typeof shoppingLists.$inferSelect
export type NewShoppingList = typeof shoppingLists.$inferInsert