/**
 * Modul: Tasks-Recurrence-Test
 * Zweck: Aufholen übersprungener wiederkehrender Aufgaben (Discussion #405).
 *        Unit: nextOccurrenceAfter. Integration: PATCH /:id/status erzeugt genau eine
 *        Folgeinstanz mit Fälligkeitsdatum in der Zukunft.
 * Ausführen: node --test test/test-tasks-recurrence.js
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';

process.env.DB_PATH = ':memory:';
// tasksRouter zieht (über requireAdmin) auth.js, das ohne SESSION_SECRET beim
// Import wirft — wie die übrigen Router-Tests eine Test-Konstante setzen.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const { nextOccurrence, nextOccurrenceAfter } = await import('../server/services/recurrence.js');
const { MIGRATIONS, _setTestDatabase } = await import('../server/db.js');
const { default: tasksRouter } = await import('../server/routes/tasks.js');

// --------------------------------------------------------
// Helfer
// --------------------------------------------------------
const DAY = 86400000;
const todayKey = () => new Date().toISOString().slice(0, 10);
const dayKey = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

// --------------------------------------------------------
// Unit: nextOccurrenceAfter
// --------------------------------------------------------
test('nextOccurrenceAfter: pünktliches Abhaken springt genau ein Intervall (kein Aufholen)', () => {
  // due in 7 Tagen, Schwelle heute → erstes Vorkommen (due+7) liegt bereits in der Zukunft
  const due = dayKey(7);
  const expected = nextOccurrence(due, 'FREQ=WEEKLY');
  assert.equal(nextOccurrenceAfter(due, 'FREQ=WEEKLY', todayKey()), expected);
});

test('nextOccurrenceAfter: mehrere verpasste Wochen → erstes Vorkommen >= heute', () => {
  const due = dayKey(-21); // 3 Wochen überfällig
  const result = nextOccurrenceAfter(due, 'FREQ=WEEKLY', todayKey());
  assert.ok(result >= todayKey(), `Ergebnis ${result} muss >= heute sein`);
  // Es bleibt auf dem Serien-Raster (Wochentag von due)
  const naive = nextOccurrence(due, 'FREQ=WEEKLY');
  assert.ok(naive < todayKey(), 'naives nextOccurrence wäre noch überfällig');
});

test('nextOccurrenceAfter: DAILY holt auf morgen/heute auf', () => {
  const due = dayKey(-10);
  const result = nextOccurrenceAfter(due, 'FREQ=DAILY', todayKey());
  assert.ok(result >= todayKey());
});

test('nextOccurrenceAfter: MONTHLY holt mehrere Monate auf', () => {
  const due = dayKey(-95); // ~3 Monate überfällig
  const result = nextOccurrenceAfter(due, 'FREQ=MONTHLY', todayKey());
  assert.ok(result >= todayKey());
});

test('nextOccurrenceAfter: UNTIL endet vor heute → null', () => {
  const due = dayKey(-21);
  const untilStr = dayKey(-7).replace(/-/g, ''); // UNTIL=YYYYMMDD vor heute
  assert.equal(nextOccurrenceAfter(due, `FREQ=WEEKLY;UNTIL=${untilStr}`, todayKey()), null);
});

test('nextOccurrenceAfter: ohne Basisdatum → null', () => {
  assert.equal(nextOccurrenceAfter(null, 'FREQ=WEEKLY', todayKey()), null);
});

// --------------------------------------------------------
// Integration: PATCH /:id/status (done) gegen den Router
// --------------------------------------------------------
function buildTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))`);
  for (const m of MIGRATIONS) {
    if (typeof m.up === 'function') m.up(db); else db.exec(m.up);
    if (typeof m.afterUp === 'function') m.afterUp(db);
    db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)').run(m.version, m.description);
  }
  return db;
}

const db = buildTestDb();
_setTestDatabase(db);
const uid = db.prepare(`INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('admin', 'Admin', '$2b$12$x', 'admin')`).run().lastInsertRowid;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = uid;
  req.session = { userId: uid, role: 'admin' };
  next();
});
app.use('/api/v1/tasks', tasksRouter);
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/tasks`;

test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function insertTask(fields) {
  const cols = Object.keys(fields);
  const r = db.prepare(
    `INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...cols.map((c) => fields[c]));
  return r.lastInsertRowid;
}

test('PATCH done: überfällige Wochen-Serie erzeugt genau eine Folgeinstanz in der Zukunft', async () => {
  const id = insertTask({
    title: 'Bad putzen', category: 'Haushalt', priority: 'medium', status: 'open',
    due_date: dayKey(-21), created_by: uid, is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  db.prepare('INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)').run(id, uid);

  const res = await call('PATCH', `/${id}/status`, { status: 'done' });
  assert.equal(res.status, 200);

  const followups = db.prepare(
    `SELECT * FROM tasks WHERE title = 'Bad putzen' AND status = 'open' AND parent_task_id IS NULL`,
  ).all();
  assert.equal(followups.length, 1, 'Es darf genau eine offene Folgeinstanz existieren');
  assert.ok(followups[0].due_date >= todayKey(), 'Folgeinstanz muss in der Zukunft fällig sein');
  assert.equal(followups[0].is_recurring, 1);
  // Assignments übernommen
  const assignees = db.prepare('SELECT user_id FROM task_assignments WHERE task_id = ?').all(followups[0].id);
  assert.deepEqual(assignees.map((a) => a.user_id), [uid]);
});

test('PATCH done: nicht-wiederkehrende Aufgabe erzeugt keine Folgeinstanz', async () => {
  const id = insertTask({
    title: 'Einmalig', status: 'open', due_date: dayKey(-3), created_by: uid,
  });
  await call('PATCH', `/${id}/status`, { status: 'done' });
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE title = 'Einmalig'`).get();
  assert.equal(rows.n, 1);
});

test('PATCH done: Subtask einer Serie erzeugt keine Folgeinstanz', async () => {
  const parent = insertTask({
    title: 'Eltern-Serie', status: 'open', due_date: dayKey(-7), created_by: uid,
    is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  const sub = insertTask({
    title: 'Sub', status: 'open', due_date: dayKey(-7), created_by: uid,
    parent_task_id: parent, is_recurring: 1, recurrence_rule: 'FREQ=WEEKLY',
  });
  await call('PATCH', `/${sub}/status`, { status: 'done' });
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE title = 'Sub'`).get();
  assert.equal(rows.n, 1, 'Subtasks dürfen keine Folgeinstanz auslösen');
});
