/**
 * Modul: Google Drive Sync + Storage-Backend – Unit-Tests
 * Zweck: Validiert das Datei→Zeile-Mapping, Upsert-Idempotenz auf storage_key,
 *        Prune/Deaktivieren, die Upload-Backend-Priorität und die Migration-87-
 *        Constraints (gdrive erlaubt, ungültige Kombination abgelehnt).
 * Ausführen: node --experimental-sqlite test/test-google-drive.js
 */

process.env.DB_PATH = ':memory:';

const db = (await import('../server/db.js')).get();
const { __test } = await import('../server/services/google-drive.js');
const { fileToRow, upsertDriveFile, pruneFolder, setFolderEnabled, enabledFolders,
        setUploadConfig } = __test;
const { getActiveUploadBackend } = await import('../server/services/document-storage.js');

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

function gdriveRows(folderId) {
  return db.prepare(
    "SELECT * FROM family_documents WHERE storage_backend = 'gdrive' AND json_extract(external_meta,'$.folder_id') = ? ORDER BY storage_key"
  ).all(folderId);
}
function resetDocs() { db.prepare("DELETE FROM family_documents").run(); db.prepare("DELETE FROM google_drive_folder_selection").run(); }
function resetCfg() { db.prepare("DELETE FROM sync_config").run(); }

console.log('\n[Google Drive Test] Mapping, Upsert, Prune, Backend, Migration\n');

// --------------------------------------------------------
// fileToRow
// --------------------------------------------------------
test('fileToRow: reguläre Datei mit size', () => {
  const row = fileToRow(
    { id: 'f1', name: 'Foto.jpg', mimeType: 'image/jpeg', size: '2048', modifiedTime: 'm', webViewLink: 'http://v' },
    { folder_id: 'F1', name: 'Album' }, uid);
  assertEqual(row.file_size, 2048);
  assertEqual(row.mime_type, 'image/jpeg');
  assertEqual(row.external_url, 'http://v');
  assertEqual(JSON.parse(row.external_meta).native, false);
  assertEqual(JSON.parse(row.external_meta).folder_id, 'F1');
});

test('fileToRow: natives Google-Dokument ohne size', () => {
  const row = fileToRow(
    { id: 'g1', name: 'Notiz', mimeType: 'application/vnd.google-apps.document', webViewLink: 'http://d' },
    { folder_id: 'F1', name: 'Docs' }, uid);
  assertEqual(row.file_size, 0, 'native Dateien liefern keine size → 0');
  assertEqual(JSON.parse(row.external_meta).native, true);
});

// --------------------------------------------------------
// Upsert-Idempotenz
// --------------------------------------------------------
test('upsertDriveFile: Insert + idempotentes Update auf storage_key', () => {
  resetDocs();
  const folder = { folder_id: 'F1', name: 'Album' };
  upsertDriveFile({ id: 'f1', name: 'A.pdf', mimeType: 'application/pdf', size: '10', webViewLink: 'http://a' }, folder, uid);
  upsertDriveFile({ id: 'f1', name: 'A-neu.pdf', mimeType: 'application/pdf', size: '20', webViewLink: 'http://a2' }, folder, uid);
  const rows = gdriveRows('F1');
  assertEqual(rows.length, 1, 'kein Duplikat bei gleichem storage_key');
  assertEqual(rows[0].name, 'A-neu.pdf');
  assertEqual(rows[0].file_size, 20);
  assertEqual(rows[0].external_url, 'http://a2');
});

// --------------------------------------------------------
// Prune
// --------------------------------------------------------
test('pruneFolder: verschwundene Dateien werden entfernt', () => {
  resetDocs();
  const folder = { folder_id: 'F1', name: 'Album' };
  upsertDriveFile({ id: 'f1', name: 'A', mimeType: 'application/pdf', size: '1' }, folder, uid);
  upsertDriveFile({ id: 'f2', name: 'B', mimeType: 'application/pdf', size: '1' }, folder, uid);
  assertEqual(gdriveRows('F1').length, 2);
  // Nur f1 wurde erneut gesehen → f2 wird gelöscht.
  pruneFolder('F1', new Set(['f1']));
  const rows = gdriveRows('F1');
  assertEqual(rows.length, 1);
  assertEqual(rows[0].storage_key, 'f1');
});

// --------------------------------------------------------
// Ordner-Deaktivierung purged Zeilen
// --------------------------------------------------------
test('setFolderEnabled: aktivieren + deaktivieren purged Dokumente', () => {
  resetDocs();
  setFolderEnabled('F1', true, { name: 'Album' });
  assert(enabledFolders().some((f) => f.folder_id === 'F1'));
  upsertDriveFile({ id: 'f1', name: 'A', mimeType: 'application/pdf', size: '1' }, { folder_id: 'F1', name: 'Album' }, uid);
  assertEqual(gdriveRows('F1').length, 1);
  setFolderEnabled('F1', false);
  assert(!enabledFolders().some((f) => f.folder_id === 'F1'));
  assertEqual(gdriveRows('F1').length, 0, 'importierte Dokumente müssen entfernt sein');
});

// --------------------------------------------------------
// Upload-Backend-Priorität
// --------------------------------------------------------
test('getActiveUploadBackend: gdrive nur bei enabled + folder + tokens', () => {
  resetCfg();
  assertEqual(getActiveUploadBackend(), 'local', 'ohne Config → local BLOB');
  setUploadConfig({ enabled: true, folderId: 'UP', folderName: 'Uploads' });
  assertEqual(getActiveUploadBackend(), 'local', 'ohne Tokens nicht aktiv');
  db.prepare("INSERT INTO sync_config (key,value) VALUES ('google_access_token','a'),('google_refresh_token','r')").run();
  assertEqual(getActiveUploadBackend(), 'gdrive', 'mit enabled+folder+tokens → gdrive');
  setUploadConfig({ enabled: false, folderId: null, folderName: null });
  assertEqual(getActiveUploadBackend(), 'local', 'nach Deaktivierung wieder local');
});

// --------------------------------------------------------
// Migration 87 Constraints
// --------------------------------------------------------
test('Migration 87: gdrive-Insert erlaubt, ungültige Kombination abgelehnt', () => {
  resetDocs();
  db.prepare(`
    INSERT INTO family_documents (name,category,original_name,mime_type,file_size,content_data,storage_provider,storage_backend,storage_key,external_url,created_by)
    VALUES ('x','other','x','application/pdf',1,'','external','gdrive','k1','http://x',?)
  `).run(uid);
  let rejected = false;
  try {
    db.prepare(`
      INSERT INTO family_documents (name,category,original_name,mime_type,file_size,content_data,storage_provider,storage_backend,created_by)
      VALUES ('y','other','y','application/pdf',1,'','local','gdrive',?)
    `).run(uid);
  } catch { rejected = true; }
  assert(rejected, 'local + gdrive muss vom Trigger abgelehnt werden');
});

test('Migration 87: Unique-Index auf gdrive storage_key', () => {
  resetDocs();
  db.prepare(`INSERT INTO family_documents (name,category,original_name,mime_type,file_size,content_data,storage_provider,storage_backend,storage_key,created_by)
    VALUES ('a','other','a','application/pdf',1,'','external','gdrive','dupkey',?)`).run(uid);
  let rejected = false;
  try {
    db.prepare(`INSERT INTO family_documents (name,category,original_name,mime_type,file_size,content_data,storage_provider,storage_backend,storage_key,created_by)
      VALUES ('b','other','b','application/pdf',1,'','external','gdrive','dupkey',?)`).run(uid);
  } catch { rejected = true; }
  assert(rejected, 'doppelter gdrive storage_key muss abgelehnt werden');
});

// --------------------------------------------------------
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
