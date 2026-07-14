/**
 * Modul: Google Tasks Sync – Unit-Tests
 * Zweck: Validiert Mapper (googleTaskToLocal/localTaskToGoogle), Upsert inkl.
 *        Zwei-Pass-Parent-Auflösung, Löschung, Dirty-Flag-Konfliktregel,
 *        Unique-Index-Dedupe und das Aufräumen beim Deaktivieren einer Liste.
 * Ausführen: node --experimental-sqlite test/test-google-tasks.js
 */

process.env.DB_PATH = ':memory:';

const db = (await import('../server/db.js')).get();
const { __test } = await import('../server/services/google-tasks.js');
const { googleTaskToLocal, localTaskToGoogle, upsertGoogleTasks,
        setTasklistEnabled, enabledTasklistIds, markDirty } = __test;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}: ${err.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion fehlgeschlagen'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// Ein Nutzer als Ersteller-Fallback.
const uid = db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('owner','Owner','x','admin') RETURNING id"
).get().id;

function reset() {
  db.prepare("DELETE FROM tasks").run();
  db.prepare("DELETE FROM google_tasklist_selection").run();
}

function googleRows(tasklistId) {
  return db.prepare(
    "SELECT * FROM tasks WHERE external_source = 'google' AND google_tasklist_id = ? ORDER BY external_uid"
  ).all(tasklistId);
}

console.log('\n[Google Tasks Test] Mapper, Upsert, Konflikt, Auswahl\n');

// --------------------------------------------------------
// Mapper: googleTaskToLocal
// --------------------------------------------------------
test('googleTaskToLocal: Grundfelder + needsAction → open', () => {
  const l = googleTaskToLocal({ title: 'Milch kaufen', notes: 'x', status: 'needsAction', updated: '2026-01-01T00:00:00.000Z' });
  assertEqual(l.title, 'Milch kaufen');
  assertEqual(l.description, 'x');
  assertEqual(l.status, 'open');
});

test('googleTaskToLocal: completed → done, due nur Datum', () => {
  const l = googleTaskToLocal({ title: 'A', status: 'completed', due: '2026-03-05T00:00:00.000Z' });
  assertEqual(l.status, 'done');
  assertEqual(l.due_date, '2026-03-05');
});

test('googleTaskToLocal: leerer Titel → Platzhalter', () => {
  assertEqual(googleTaskToLocal({ title: '   ', status: 'needsAction' }).title, '(kein Titel)');
});

// --------------------------------------------------------
// Mapper: localTaskToGoogle
// --------------------------------------------------------
test('localTaskToGoogle: open → needsAction, completed=null', () => {
  const g = localTaskToGoogle({ title: 'A', description: 'n', status: 'open', due_date: null });
  assertEqual(g.status, 'needsAction');
  assertEqual(g.completed, null);
  assertEqual(g.notes, 'n');
});

test('localTaskToGoogle: done → completed + Zeitstempel + due', () => {
  const g = localTaskToGoogle({ title: 'A', status: 'done', due_date: '2026-04-01' });
  assertEqual(g.status, 'completed');
  assert(typeof g.completed === 'string' && g.completed.includes('T'), 'completed-Zeitstempel fehlt');
  assertEqual(g.due, '2026-04-01T00:00:00.000Z');
});

test('localTaskToGoogle: archived → completed (nicht gelöscht)', () => {
  assertEqual(localTaskToGoogle({ title: 'A', status: 'archived' }).status, 'completed');
});

// --------------------------------------------------------
// Upsert: Insert/Update/Delete
// --------------------------------------------------------
test('upsertGoogleTasks: Insert neuer Aufgaben', () => {
  reset();
  const r = upsertGoogleTasks([
    { id: 'g1', title: 'Eins', status: 'needsAction', updated: 'u1' },
    { id: 'g2', title: 'Zwei', status: 'completed', updated: 'u2' },
  ], 'L1', uid);
  assertEqual(r.upserted, 2);
  const rows = googleRows('L1');
  assertEqual(rows.length, 2);
  assertEqual(rows[0].title, 'Eins');
  assertEqual(rows[1].status, 'done');
});

test('upsertGoogleTasks: Update bestehender Aufgabe', () => {
  reset();
  upsertGoogleTasks([{ id: 'g1', title: 'Alt', status: 'needsAction' }], 'L1', uid);
  upsertGoogleTasks([{ id: 'g1', title: 'Neu', status: 'completed' }], 'L1', uid);
  const rows = googleRows('L1');
  assertEqual(rows.length, 1, 'kein Duplikat');
  assertEqual(rows[0].title, 'Neu');
  assertEqual(rows[0].status, 'done');
});

test('upsertGoogleTasks: deleted entfernt Zeile', () => {
  reset();
  upsertGoogleTasks([{ id: 'g1', title: 'X', status: 'needsAction' }], 'L1', uid);
  const r = upsertGoogleTasks([{ id: 'g1', deleted: true }], 'L1', uid);
  assertEqual(r.deleted, 1);
  assertEqual(googleRows('L1').length, 0);
});

// --------------------------------------------------------
// Zwei-Pass-Parent-Auflösung
// --------------------------------------------------------
test('upsertGoogleTasks: parent wird aufgelöst (Zwei-Pass)', () => {
  reset();
  upsertGoogleTasks([
    { id: 'child', title: 'Kind', status: 'needsAction', parent: 'parent' },
    { id: 'parent', title: 'Eltern', status: 'needsAction' },
  ], 'L1', uid);
  const rows = googleRows('L1');
  const parent = rows.find((r) => r.external_uid === 'parent');
  const child  = rows.find((r) => r.external_uid === 'child');
  assertEqual(child.parent_task_id, parent.id, 'parent_task_id muss auf Eltern zeigen');
});

// --------------------------------------------------------
// Konfliktregel: dirty-Zeile wird beim Inbound NICHT überschrieben
// --------------------------------------------------------
test('upsertGoogleTasks: google_dirty=1 überlebt Inbound-Update', () => {
  reset();
  upsertGoogleTasks([{ id: 'g1', title: 'Original', status: 'needsAction' }], 'L1', uid);
  const id = googleRows('L1')[0].id;
  // Lokale Änderung markieren
  db.prepare("UPDATE tasks SET title = 'Lokal geändert' WHERE id = ?").run(id);
  markDirty(id);
  // Inbound versucht zu überschreiben
  upsertGoogleTasks([{ id: 'g1', title: 'Remote geändert', status: 'completed' }], 'L1', uid);
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  assertEqual(row.title, 'Lokal geändert', 'lokale Änderung darf nicht überschrieben werden');
  assertEqual(row.status, 'open', 'Status darf nicht auf done springen');
});

// --------------------------------------------------------
// Unique-Index: gleiche (tasklist, uid) verhindert Duplikate
// --------------------------------------------------------
test('Unique-Index: gleiche Aufgabe in zwei Listen ist erlaubt', () => {
  reset();
  upsertGoogleTasks([{ id: 'same', title: 'A', status: 'needsAction' }], 'L1', uid);
  upsertGoogleTasks([{ id: 'same', title: 'B', status: 'needsAction' }], 'L2', uid);
  assertEqual(googleRows('L1').length, 1);
  assertEqual(googleRows('L2').length, 1);
});

// --------------------------------------------------------
// Listenauswahl: Deaktivieren löscht importierte Aufgaben
// --------------------------------------------------------
test('setTasklistEnabled: aktivieren + deaktivieren purged Aufgaben', () => {
  reset();
  setTasklistEnabled('L1', true, { name: 'Meine Liste' });
  assert(enabledTasklistIds().includes('L1'), 'L1 muss aktiviert sein');
  upsertGoogleTasks([{ id: 'g1', title: 'X', status: 'needsAction' }], 'L1', uid);
  assertEqual(googleRows('L1').length, 1);
  setTasklistEnabled('L1', false);
  assert(!enabledTasklistIds().includes('L1'), 'L1 muss deaktiviert sein');
  assertEqual(googleRows('L1').length, 0, 'importierte Aufgaben müssen entfernt sein');
});

// --------------------------------------------------------
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
