/**
 * Modul: Rezept-Import
 * Zweck: Rezepte aus einer URL extrahieren (schema.org/Recipe JSON-LD, mit
 *        Microdata-Fallback) und über TheMealDB (kostenlos, kein Key) suchen.
 * Abhängigkeiten: server/utils/safe-fetch.js
 *
 * Der Import liefert nur einen Entwurf zurück; gespeichert wird über den
 * bestehenden POST /recipes-Endpoint, nachdem der Nutzer den Entwurf geprüft hat.
 */

import { createLogger } from '../logger.js';
import { fetchTextSafely } from '../utils/safe-fetch.js';
import { decodeHtmlEntities } from '../utils/html-entities.js';

const log = createLogger('RecipeImport');

const THEMEALDB_SEARCH = 'https://www.themealdb.com/api/json/v1/1/search.php?s=';

// --------------------------------------------------------
// Hilfsfunktionen
// --------------------------------------------------------

/** HTML-Tags entfernen und Entities auflösen → Klartext. */
function stripHtml(value) {
  if (value == null) return '';
  return decodeHtmlEntities(String(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Best-effort-Aufteilung "Menge + Zutat". Führende Zahl/Einheit wird als quantity
 * abgetrennt; ohne erkennbare Menge landet der ganze String als name.
 */
function splitIngredient(raw) {
  const text = stripHtml(raw);
  if (!text) return null;
  const m = /^([\d\/.,¼½¾⅓⅔⅛\s]+(?:\s*(?:g|kg|ml|l|el|tl|tbsp|tsp|cups?|cup|oz|lb|stück|stk|pcs|prise|dose|dosen|packung|bund|clove[s]?|zehe[n]?)\b)?)\s+(.+)$/i.exec(text);
  if (m && m[2]) {
    return { name: m[2].trim().slice(0, 200), quantity: m[1].trim().slice(0, 80), category: 'Sonstiges' };
  }
  return { name: text.slice(0, 200), quantity: '', category: 'Sonstiges' };
}

/** recipeInstructions in verschiedenen schema.org-Formen → nummerierter Klartext. */
function instructionsToNotes(instructions) {
  if (!instructions) return '';
  const steps = [];

  const pushStep = (val) => {
    const text = stripHtml(val);
    if (text) steps.push(text);
  };

  const walk = (node) => {
    if (!node) return;
    if (typeof node === 'string') { pushStep(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'object') {
      // HowToSection enthält itemListElement mit HowToStep
      if (node.itemListElement) { walk(node.itemListElement); return; }
      if (node.text) { pushStep(node.text); return; }
      if (node.name) { pushStep(node.name); return; }
    }
  };
  walk(instructions);

  return steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

/** Findet in einem beliebig verschachtelten JSON-LD-Baum den Recipe-Knoten. */
function findRecipeNode(parsed) {
  const isRecipe = (node) => {
    if (!node || typeof node !== 'object') return false;
    const type = node['@type'];
    if (!type) return false;
    return Array.isArray(type)
      ? type.some((t) => String(t).toLowerCase() === 'recipe')
      : String(type).toLowerCase() === 'recipe';
  };

  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const root of candidates) {
    if (isRecipe(root)) return root;
    if (root && typeof root === 'object' && Array.isArray(root['@graph'])) {
      const found = root['@graph'].find(isRecipe);
      if (found) return found;
    }
  }
  return null;
}

// --------------------------------------------------------
// Parser
// --------------------------------------------------------

/**
 * Extrahiert ein Rezept aus HTML. Bevorzugt schema.org/Recipe JSON-LD, fällt
 * ansonsten auf einfache Microdata zurück. Wirft, wenn kein Rezept mit Titel und
 * mindestens einer Zutat gefunden wird.
 * @param {string} html
 * @param {string} sourceUrl
 * @returns {{ title, notes, recipe_url, meal_types, ingredients }}
 */
export function parseRecipeHtml(html, sourceUrl) {
  // 1) JSON-LD
  const blocks = [...String(html).matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    let parsed;
    try { parsed = JSON.parse(block[1].trim()); } catch { continue; }
    const recipe = findRecipeNode(parsed);
    if (!recipe) continue;

    const title = stripHtml(recipe.name);
    const ingredients = (Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient : [])
      .map(splitIngredient).filter(Boolean);

    if (title && ingredients.length > 0) {
      let notes = instructionsToNotes(recipe.recipeInstructions);
      if (recipe.recipeYield) notes += `\n\n${stripHtml(Array.isArray(recipe.recipeYield) ? recipe.recipeYield[0] : recipe.recipeYield)}`;
      return { title: title.slice(0, 200), notes: notes.trim(), recipe_url: sourceUrl, meal_types: '', ingredients };
    }
  }

  // 2) Microdata-Fallback (günstig, regex-basiert)
  const md = parseMicrodata(html);
  if (md && md.title && md.ingredients.length > 0) {
    return { title: md.title.slice(0, 200), notes: md.notes, recipe_url: sourceUrl, meal_types: '', ingredients: md.ingredients };
  }

  throw new RecipeNotFoundError('No recipe found on the page.');
}

/** Sehr einfache Microdata-Extraktion für schema.org/Recipe. */
function parseMicrodata(html) {
  const src = String(html);
  if (!/itemtype=["'][^"']*schema\.org\/Recipe/i.test(src)) return null;

  const ingredients = [...src.matchAll(/itemprop=["'](?:recipeIngredient|ingredients)["'][^>]*>([\s\S]*?)<\//gi)]
    .map((m) => splitIngredient(m[1])).filter(Boolean);

  const nameMatch = /itemprop=["']name["'][^>]*>([\s\S]*?)<\//i.exec(src);
  const title = nameMatch ? stripHtml(nameMatch[1]) : '';

  const steps = [...src.matchAll(/itemprop=["'](?:recipeInstructions|instructions)["'][^>]*>([\s\S]*?)<\//gi)]
    .map((m) => stripHtml(m[1])).filter(Boolean);

  return { title, notes: steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), ingredients };
}

export class RecipeNotFoundError extends Error {
  constructor(message) { super(message); this.name = 'RecipeNotFoundError'; }
}

// --------------------------------------------------------
// URL-Import
// --------------------------------------------------------

export async function importFromUrl(url) {
  const html = await fetchTextSafely(url, {
    maxBytes: 3 * 1024 * 1024,
    timeoutMs: 10_000,
    headers: { 'User-Agent': 'Yuvomi-RecipeImport/1.0', Accept: 'text/html' },
  });
  return parseRecipeHtml(html, url);
}

// --------------------------------------------------------
// TheMealDB-Suche
// --------------------------------------------------------

/** Ein TheMealDB-Meal-Objekt in einen Rezept-Entwurf mappen. */
export function mealDbToDraft(meal) {
  const ingredients = [];
  for (let i = 1; i <= 20; i++) {
    const name = String(meal[`strIngredient${i}`] || '').trim();
    if (!name) continue;
    const quantity = String(meal[`strMeasure${i}`] || '').trim();
    ingredients.push({ name: name.slice(0, 200), quantity: quantity.slice(0, 80), category: 'Sonstiges' });
  }
  return {
    title: String(meal.strMeal || '').slice(0, 200),
    notes: String(meal.strInstructions || '').trim(),
    recipe_url: meal.strSource || (meal.idMeal ? `https://www.themealdb.com/meal/${meal.idMeal}` : ''),
    meal_types: '',
    thumbnail: meal.strMealThumb || null,
    ingredients,
  };
}

export async function searchTheMealDb(query) {
  const url = `${THEMEALDB_SEARCH}${encodeURIComponent(query)}`;
  const body = await fetchTextSafely(url, { maxBytes: 2 * 1024 * 1024, timeoutMs: 10_000, headers: { Accept: 'application/json' } });
  let json;
  try { json = JSON.parse(body); } catch { return []; }
  if (!json || !Array.isArray(json.meals)) return []; // TheMealDB liefert {"meals":null} bei 0 Treffern
  return json.meals.map(mealDbToDraft);
}

export const __test = { parseRecipeHtml, mealDbToDraft, splitIngredient, instructionsToNotes, findRecipeNode };
