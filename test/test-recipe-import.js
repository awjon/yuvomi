/**
 * Modul: Rezept-Import – Unit-Tests (offline)
 * Zweck: Validiert das JSON-LD-/Microdata-Parsing (verschiedene schema.org-
 *        Formen), die Fehlerbehandlung, die Mengen-Heuristik, das TheMealDB-
 *        Mapping und den SSRF-Schutz (literale private IPs ohne Netz).
 * Ausführen: node test/test-recipe-import.js
 */

const { __test, parseRecipeHtml, mealDbToDraft, importFromUrl, RecipeNotFoundError } =
  await import('../server/services/recipe-import.js');
const { splitIngredient } = __test;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
async function atest(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
async function assertThrows(fn, msg) {
  try { await fn(); } catch { return; }
  throw new Error(msg || 'Erwartete Exception blieb aus');
}

const ldWrap = (obj) => `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body></body></html>`;

console.log('\n[Recipe Import Test] JSON-LD, Microdata, TheMealDB, SSRF\n');

// --------------------------------------------------------
// JSON-LD: einfache Recipe
// --------------------------------------------------------
test('JSON-LD: einfaches Recipe (Instructions als String)', () => {
  const html = ldWrap({
    '@context': 'https://schema.org', '@type': 'Recipe', name: 'Pfannkuchen',
    recipeIngredient: ['200 g Mehl', '2 Eier', 'Prise Salz'],
    recipeInstructions: 'Alles verrühren und braten.',
  });
  const d = parseRecipeHtml(html, 'https://example.test/r');
  assertEqual(d.title, 'Pfannkuchen');
  assertEqual(d.ingredients.length, 3);
  assertEqual(d.recipe_url, 'https://example.test/r');
  assert(d.notes.includes('Alles verrühren'), 'notes fehlen');
});

test('JSON-LD: @graph mit Recipe-Knoten', () => {
  const html = ldWrap({ '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebPage', name: 'Seite' },
    { '@type': 'Recipe', name: 'Suppe', recipeIngredient: ['1 l Wasser'], recipeInstructions: [{ '@type': 'HowToStep', text: 'Kochen' }] },
  ] });
  const d = parseRecipeHtml(html, 'u');
  assertEqual(d.title, 'Suppe');
  assertEqual(d.ingredients[0].name, 'Wasser');
  assert(d.notes.includes('Kochen'));
});

test('JSON-LD: @type als Array', () => {
  const html = ldWrap({ '@type': ['Thing', 'Recipe'], name: 'X', recipeIngredient: ['1 Ei'], recipeInstructions: 'Rühren' });
  const d = parseRecipeHtml(html, 'u');
  assertEqual(d.title, 'X');
});

test('JSON-LD: HowToSection mit itemListElement', () => {
  const html = ldWrap({ '@type': 'Recipe', name: 'Menü', recipeIngredient: ['Salz'],
    recipeInstructions: [{ '@type': 'HowToSection', itemListElement: [{ '@type': 'HowToStep', text: 'Schritt A' }, { '@type': 'HowToStep', text: 'Schritt B' }] }] });
  const d = parseRecipeHtml(html, 'u');
  assert(d.notes.includes('1. Schritt A') && d.notes.includes('2. Schritt B'), 'nummerierte Schritte fehlen');
});

test('JSON-LD: HTML-Entities im Titel werden dekodiert', () => {
  const html = ldWrap({ '@type': 'Recipe', name: 'Erdbeer &amp; Sahne', recipeIngredient: ['Sahne'], recipeInstructions: 'x' });
  const d = parseRecipeHtml(html, 'u');
  assertEqual(d.title, 'Erdbeer & Sahne');
});

// --------------------------------------------------------
// Microdata-Fallback
// --------------------------------------------------------
test('Microdata: Fallback ohne JSON-LD', () => {
  const html = `<div itemscope itemtype="https://schema.org/Recipe">
    <h1 itemprop="name">Toast</h1>
    <span itemprop="recipeIngredient">2 Scheiben Brot</span>
    <span itemprop="recipeIngredient">Butter</span>
    <div itemprop="recipeInstructions">Toasten.</div>
  </div>`;
  const d = parseRecipeHtml(html, 'u');
  assertEqual(d.title, 'Toast');
  assertEqual(d.ingredients.length, 2);
});

// --------------------------------------------------------
// Fehlerfall
// --------------------------------------------------------
test('Kein Rezept → RecipeNotFoundError', () => {
  let threw = false;
  try { parseRecipeHtml('<html><body>nichts</body></html>', 'u'); }
  catch (e) { threw = e instanceof RecipeNotFoundError; }
  assert(threw, 'RecipeNotFoundError erwartet');
});

test('Recipe ohne Zutaten → Fehler', () => {
  const html = ldWrap({ '@type': 'Recipe', name: 'Leer', recipeInstructions: 'x' });
  let threw = false;
  try { parseRecipeHtml(html, 'u'); } catch { threw = true; }
  assert(threw, 'Rezept ohne Zutaten muss abgelehnt werden');
});

// --------------------------------------------------------
// Mengen-Heuristik
// --------------------------------------------------------
test('splitIngredient: Menge + Einheit', () => {
  const r = splitIngredient('200 g Mehl');
  assertEqual(r.quantity, '200 g');
  assertEqual(r.name, 'Mehl');
});
test('splitIngredient: ohne Menge → ganzer Text als name', () => {
  const r = splitIngredient('Salz nach Geschmack');
  assertEqual(r.quantity, '');
  assertEqual(r.name, 'Salz nach Geschmack');
});

// --------------------------------------------------------
// TheMealDB-Mapping
// --------------------------------------------------------
test('mealDbToDraft: Zutaten 1..20, Leerwerte übersprungen', () => {
  const meal = { strMeal: 'Arrabiata', strInstructions: 'Kochen', idMeal: '52771',
    strIngredient1: 'Penne', strMeasure1: '1 pound', strIngredient2: 'Olive Oil', strMeasure2: '1/4 cup',
    strIngredient3: '', strMeasure3: '', strIngredient4: null };
  const d = mealDbToDraft(meal);
  assertEqual(d.title, 'Arrabiata');
  assertEqual(d.ingredients.length, 2, 'Leer/null-Zutaten müssen übersprungen werden');
  assertEqual(d.ingredients[0].name, 'Penne');
  assertEqual(d.recipe_url, 'https://www.themealdb.com/meal/52771');
});

// --------------------------------------------------------
// SSRF: literale private IPs ohne Netzwerkzugriff
// --------------------------------------------------------
await atest('importFromUrl: private IPv4 wird abgelehnt', () =>
  assertThrows(() => importFromUrl('https://127.0.0.1/recipe')));
await atest('importFromUrl: privates Netz wird abgelehnt', () =>
  assertThrows(() => importFromUrl('http://192.168.1.10/recipe')));

// --------------------------------------------------------
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
