/**
 * Modul: Google OAuth (geteilt) – Unit-Tests
 * Zweck: Validiert Scope-Parsing, Rückwärtskompatibilität (Alt-Token ohne
 *        google_scopes → Calendar-only), Status-Shape, cfg-Round-Trip,
 *        disconnectAuth-Aufräumen und die Auth-URL (alle Scopes + state).
 * Ausführen: node --experimental-sqlite test/test-google-auth.js
 */

// In-Memory-DB VOR dem Import von google-auth.js (db.js verbindet beim Import).
process.env.DB_PATH = ':memory:';
// Dummy-OAuth-Credentials, damit createClient()/getAuthUrl() ohne Netz laufen.
process.env.GOOGLE_CLIENT_ID     = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI  = 'https://example.test/api/v1/calendar/google/callback';

const db = (await import('../server/db.js')).get();
const auth = await import('../server/services/google-auth.js');
const { SCOPES, ALL_SCOPES } = auth;
const { getGrantedScopes, hasScope, getAuthStatus, disconnectAuth,
        cfgGet, cfgSet, cfgDel, getAuthUrl } = auth.__test;

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

/** sync_config vor jedem Test-Block leeren. */
function resetConfig() {
  db.prepare('DELETE FROM sync_config').run();
}

console.log('\n[Google Auth Test] Scopes, Rückwärtskompatibilität, Status, cfg\n');

// --------------------------------------------------------
// cfg Round-Trip
// --------------------------------------------------------
test('cfgSet/cfgGet/cfgDel Round-Trip', () => {
  resetConfig();
  assertEqual(cfgGet('some_key'), null);
  cfgSet('some_key', 'value1');
  assertEqual(cfgGet('some_key'), 'value1');
  cfgSet('some_key', 'value2');
  assertEqual(cfgGet('some_key'), 'value2', 'ON CONFLICT muss überschreiben');
  cfgDel('some_key');
  assertEqual(cfgGet('some_key'), null);
});

// --------------------------------------------------------
// getGrantedScopes / hasScope
// --------------------------------------------------------
test('getGrantedScopes: nicht verbunden → leer', () => {
  resetConfig();
  assertEqual(getGrantedScopes().length, 0);
  assertEqual(hasScope(SCOPES.CALENDAR), false);
});

test('getGrantedScopes: gespeicherte Scopes werden geparst', () => {
  resetConfig();
  cfgSet('google_access_token', 'a');
  cfgSet('google_refresh_token', 'r');
  cfgSet('google_scopes', `${SCOPES.CALENDAR} ${SCOPES.TASKS} ${SCOPES.DRIVE}`);
  const granted = getGrantedScopes();
  assertEqual(granted.length, 3);
  assert(hasScope(SCOPES.CALENDAR) && hasScope(SCOPES.TASKS) && hasScope(SCOPES.DRIVE));
});

test('Rückwärtskompatibilität: Token vorhanden, google_scopes fehlt → Calendar-only', () => {
  resetConfig();
  cfgSet('google_access_token', 'a');
  cfgSet('google_refresh_token', 'r');
  const granted = getGrantedScopes();
  assertEqual(granted.length, 1);
  assertEqual(granted[0], SCOPES.CALENDAR);
  assertEqual(hasScope(SCOPES.CALENDAR), true);
  assertEqual(hasScope(SCOPES.TASKS), false, 'Alt-Token hat keinen Tasks-Scope');
});

// --------------------------------------------------------
// getAuthStatus
// --------------------------------------------------------
test('getAuthStatus: Shape + missingScopes bei Alt-Token', () => {
  resetConfig();
  cfgSet('google_access_token', 'a');
  cfgSet('google_refresh_token', 'r');
  const s = getAuthStatus();
  assertEqual(s.configured, true, 'Dummy-Env ist gesetzt');
  assertEqual(s.connected, true);
  assertEqual(s.grantedScopes.length, 1);
  // Tasks + Drive fehlen → needsReconsent-Grundlage
  assertEqual(s.missingScopes.length, 2);
  assert(s.missingScopes.includes(SCOPES.TASKS) && s.missingScopes.includes(SCOPES.DRIVE));
});

test('getAuthStatus: alle Scopes gewährt → keine fehlen', () => {
  resetConfig();
  cfgSet('google_access_token', 'a');
  cfgSet('google_refresh_token', 'r');
  cfgSet('google_scopes', ALL_SCOPES.join(' '));
  const s = getAuthStatus();
  assertEqual(s.missingScopes.length, 0);
});

test('getAuthStatus: nicht verbunden', () => {
  resetConfig();
  const s = getAuthStatus();
  assertEqual(s.connected, false);
  assertEqual(s.grantedScopes.length, 0);
  assertEqual(s.missingScopes.length, 0, 'ohne Verbindung keine fehlenden Scopes melden');
});

// --------------------------------------------------------
// disconnectAuth
// --------------------------------------------------------
test('disconnectAuth löscht alle vier Auth-Schlüssel', () => {
  resetConfig();
  cfgSet('google_access_token', 'a');
  cfgSet('google_refresh_token', 'r');
  cfgSet('google_token_expiry', '123');
  cfgSet('google_scopes', ALL_SCOPES.join(' '));
  // Fremd-Key darf erhalten bleiben (feature-spezifisch)
  cfgSet('google_last_sync', '2026-01-01T00:00:00Z');
  disconnectAuth();
  assertEqual(cfgGet('google_access_token'), null);
  assertEqual(cfgGet('google_refresh_token'), null);
  assertEqual(cfgGet('google_token_expiry'), null);
  assertEqual(cfgGet('google_scopes'), null);
  assertEqual(cfgGet('google_last_sync'), '2026-01-01T00:00:00Z', 'Feature-State bleibt erhalten');
});

// --------------------------------------------------------
// getAuthUrl
// --------------------------------------------------------
test('getAuthUrl enthält alle drei Scopes, state und offline-Consent', () => {
  const session = {};
  const url = getAuthUrl(session);
  const decoded = decodeURIComponent(url);
  assert(decoded.includes(SCOPES.CALENDAR), 'Calendar-Scope fehlt');
  assert(decoded.includes(SCOPES.TASKS), 'Tasks-Scope fehlt');
  assert(decoded.includes(SCOPES.DRIVE), 'Drive-Scope fehlt');
  assert(url.includes('access_type=offline'), 'access_type=offline fehlt');
  assert(url.includes('prompt=consent'), 'prompt=consent fehlt');
  assert(/[?&]state=[0-9a-f]{64}/.test(url), 'state-Parameter fehlt oder falsch');
  assertEqual(session.googleOAuthState.length, 64, 'state muss in der Session liegen');
  assert(url.includes(`state=${session.googleOAuthState}`), 'URL-state muss Session-state entsprechen');
});

// --------------------------------------------------------
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
