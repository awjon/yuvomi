/**
 * Modul: Google-Geburtstags-Import – Unit-Tests
 * Zweck: Validiert die Namensableitung (EN/DE/kein-Match), Upsert-Idempotenz auf
 *        google_event_id, die Artefakt-Erzeugung über den echten birthdays.js-
 *        Service (calendar_events + reminders), das Prunen verschwundener
 *        Einträge und das Aufräumen beim Deaktivieren der Quelle.
 * Ausführen: node --experimental-sqlite test/test-google-birthdays.js
 */

process.env.DB_PATH = ':memory:';

const db = (await import('../server/db.js')).get();
const { __test } = await import('../server/services/google-birthdays.js');
const { nameFromSummary, isBirthdayEvent, upsertBirthday, pruneRemoved, setSource } = __test;
const { syncBirthdayArtifacts } = await import('../server/services/birthdays.js');

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

const uid = db.prepare(
  "INSERT INTO users (username, display_name, password_hash, role) VALUES ('owner','Owner','x','admin') RETURNING id"
).get().id;

function reset() {
  db.prepare("DELETE FROM reminders").run();
  db.prepare("DELETE FROM calendar_events").run();
  db.prepare("DELETE FROM birthdays").run();
  db.prepare("DELETE FROM sync_config").run();
}
function googleRows() {
  return db.prepare("SELECT * FROM birthdays WHERE external_source = 'google' ORDER BY google_event_id").all();
}

console.log('\n[Google Birthdays Test] Namensableitung, Upsert, Artefakte, Prune\n');

// --------------------------------------------------------
// Namensableitung
// --------------------------------------------------------
test("nameFromSummary: englisches \"'s birthday\"", () => {
  assertEqual(nameFromSummary("Jane Doe's birthday"), 'Jane Doe');
});
test('nameFromSummary: deutsches "hat Geburtstag"', () => {
  assertEqual(nameFromSummary('Max Mustermann hat Geburtstag'), 'Max Mustermann');
});
test('nameFromSummary: kein Muster → Rohtext', () => {
  assertEqual(nameFromSummary('Oma'), 'Oma');
});

// --------------------------------------------------------
// isBirthdayEvent
// --------------------------------------------------------
test('isBirthdayEvent: eventType birthday', () => {
  assert(isBirthdayEvent({ eventType: 'birthday' }));
});
test('isBirthdayEvent: jährliche Serie', () => {
  assert(isBirthdayEvent({ recurrence: ['RRULE:FREQ=YEARLY'] }));
});
test('isBirthdayEvent: normales Event → false', () => {
  assert(!isBirthdayEvent({ recurrence: ['RRULE:FREQ=WEEKLY'] }));
});

// --------------------------------------------------------
// Upsert-Idempotenz
// --------------------------------------------------------
test('upsertBirthday: Insert + idempotentes Update auf google_event_id', () => {
  reset();
  upsertBirthday({ id: 'e1', summary: "Jane's birthday", start: { date: '2000-05-01' } }, uid);
  upsertBirthday({ id: 'e1', summary: "Jane Smith's birthday", start: { date: '2000-05-02' } }, uid);
  const rows = googleRows();
  assertEqual(rows.length, 1, 'kein Duplikat bei gleichem google_event_id');
  assertEqual(rows[0].name, 'Jane Smith');
  assertEqual(rows[0].birth_date, '2000-05-02');
  assertEqual(rows[0].reminder_offset, '', 'importierte Geburtstage starten ohne Benachrichtigung');
});

test('upsertBirthday: ohne start.date → kein Eintrag', () => {
  reset();
  const r = upsertBirthday({ id: 'e2', summary: 'Ohne Datum', start: {} }, uid);
  assertEqual(r, null);
  assertEqual(googleRows().length, 0);
});

// --------------------------------------------------------
// Artefakt-Erzeugung über den echten birthdays.js-Service
// --------------------------------------------------------
test('Artefakte: importierter Geburtstag erhält Kalender-Event + Reminder', () => {
  reset();
  const row = upsertBirthday({ id: 'e3', summary: "Tom's birthday", start: { date: '1990-07-14' } }, uid);
  // Erinnerung aktivieren (Standard-Offset), dann Artefakte erzeugen.
  db.prepare("UPDATE birthdays SET reminder_offset = '0' WHERE id = ?").run(row.id);
  const fresh = db.prepare('SELECT * FROM birthdays WHERE id = ?').get(row.id);
  db.transaction(() => syncBirthdayArtifacts(db, fresh))();
  const updated = db.prepare('SELECT * FROM birthdays WHERE id = ?').get(row.id);
  assert(updated.calendar_event_id, 'calendar_event_id muss gesetzt sein');
  const ev = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(updated.calendar_event_id);
  assert(ev, 'Kalender-Event muss existieren');
  assertEqual(ev.icon, 'cake');
  const rem = db.prepare("SELECT COUNT(*) c FROM reminders WHERE entity_type='event' AND entity_id = ?").get(updated.calendar_event_id).c;
  assert(rem >= 1, 'mindestens eine Reminder-Zeile muss existieren');
});

// --------------------------------------------------------
// Prune
// --------------------------------------------------------
test('pruneRemoved: verschwundene Einträge + Artefakte werden entfernt', () => {
  reset();
  const a = upsertBirthday({ id: 'keep', summary: "A's birthday", start: { date: '2000-01-01' } }, uid);
  const b = upsertBirthday({ id: 'gone', summary: "B's birthday", start: { date: '2000-02-02' } }, uid);
  db.prepare("UPDATE birthdays SET reminder_offset='0' WHERE id IN (?,?)").run(a.id, b.id);
  for (const id of [a.id, b.id]) {
    const fresh = db.prepare('SELECT * FROM birthdays WHERE id = ?').get(id);
    db.transaction(() => syncBirthdayArtifacts(db, fresh))();
  }
  const goneEvId = db.prepare('SELECT calendar_event_id FROM birthdays WHERE google_event_id = ?').get('gone').calendar_event_id;
  // Nur "keep" erneut gesehen.
  pruneRemoved(new Set(['keep']));
  assertEqual(googleRows().length, 1);
  assertEqual(googleRows()[0].google_event_id, 'keep');
  const evGone = db.prepare('SELECT COUNT(*) c FROM calendar_events WHERE id = ?').get(goneEvId).c;
  assertEqual(evGone, 0, 'Kalender-Event des entfernten Geburtstags muss weg sein');
});

// --------------------------------------------------------
// setSource: Deaktivieren purged importierte Geburtstage
// --------------------------------------------------------
test('setSource: Deaktivieren entfernt importierte Geburtstage', () => {
  reset();
  const r = upsertBirthday({ id: 'e9', summary: "C's birthday", start: { date: '2001-03-03' } }, uid);
  db.prepare("UPDATE birthdays SET reminder_offset='0' WHERE id=?").run(r.id);
  const fresh = db.prepare('SELECT * FROM birthdays WHERE id = ?').get(r.id);
  db.transaction(() => syncBirthdayArtifacts(db, fresh))();
  assertEqual(googleRows().length, 1);
  setSource({ enabled: false });
  assertEqual(googleRows().length, 0, 'importierte Geburtstage müssen entfernt sein');
});

test('setSource: Warnung wenn Quell-Kalender auch normal synchronisiert wird', () => {
  reset();
  db.prepare("INSERT INTO google_calendar_selection (calendar_id, name, enabled) VALUES ('cal-x','X',1)").run();
  const r = setSource({ calendarId: 'cal-x', enabled: true });
  assertEqual(r.warning, 'calendar_also_synced');
});

// --------------------------------------------------------
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
