/**
 * Modul: Google Tasks Sync
 * Zweck: Bidirektionaler Sync mit der Google Tasks API v1.
 *        Inbound:  Google-Task-Listen → lokale tasks (external_source='google')
 *        Outbound: lokale Änderungen an importierten Aufgaben (google_dirty=1)
 *                  sowie explizit exportierte lokale Aufgaben.
 * Abhängigkeiten: googleapis, server/db.js, server/services/google-auth.js
 *
 * sync_config-Schlüssel (tasks-spezifisch):
 *   google_tasks_last_sync - ISO-8601-Timestamp des letzten erfolgreichen Syncs
 *
 * Hinweis: Die Tasks-API kennt keine Sync-Tokens. Als inkrementeller Cursor
 * dient updated_min je Liste (google_tasklist_selection.updated_min).
 */

import { createLogger } from '../logger.js';
const log = createLogger('GoogleTasks');

import { google } from 'googleapis';
import * as db from '../db.js';
import { cfgGet, cfgSet, loadAuthorizedClient, hasScope, getAuthStatus, SCOPES } from './google-auth.js';

// --------------------------------------------------------
// Listenauswahl (spiegelt google_calendar_selection)
// --------------------------------------------------------

function enabledTasklistIds() {
  return db.get().prepare(
    'SELECT tasklist_id FROM google_tasklist_selection WHERE enabled = 1'
  ).all().map((r) => r.tasklist_id);
}

function getUpdatedMin(tasklistId) {
  const row = db.get().prepare(
    'SELECT updated_min FROM google_tasklist_selection WHERE tasklist_id = ?'
  ).get(tasklistId);
  return row ? row.updated_min : null;
}

function recordSync(tasklistId, updatedMin) {
  db.get().prepare(`
    UPDATE google_tasklist_selection
    SET updated_min = ?, last_sync = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE tasklist_id = ?
  `).run(updatedMin, tasklistId);
}

/**
 * Aktiviert/deaktiviert eine Google-Task-Liste. Beim Deaktivieren werden die
 * importierten Aufgaben dieser Liste entfernt und der Cursor zurückgesetzt.
 * @param {string} tasklistId
 * @param {boolean} enabled
 * @param {{name?: string}} [meta]
 */
function setTasklistEnabled(tasklistId, enabled, meta = {}) {
  if (enabled) {
    db.get().prepare(`
      INSERT INTO google_tasklist_selection (tasklist_id, name, enabled)
      VALUES (?, ?, 1)
      ON CONFLICT(tasklist_id) DO UPDATE SET enabled = 1,
        name = COALESCE(excluded.name, google_tasklist_selection.name)
    `).run(tasklistId, meta.name ?? null);
  } else {
    db.get().transaction(() => {
      db.get().prepare(
        `DELETE FROM tasks WHERE external_source = 'google' AND google_tasklist_id = ?`
      ).run(tasklistId);
      db.get().prepare(`
        UPDATE google_tasklist_selection
        SET enabled = 0, updated_min = NULL, last_sync = NULL
        WHERE tasklist_id = ?
      `).run(tasklistId);
    })();
  }
}

/**
 * Listet die Google-Task-Listen des verbundenen Accounts, angereichert um den
 * Aktivierungsstatus aus google_tasklist_selection.
 * @returns {Promise<Array<{id, title, enabled}>>}
 */
async function listTasklists() {
  const client = loadAuthorizedClient();
  const tasksApi = google.tasks({ version: 'v1', auth: client });
  const enabledSet = new Set(enabledTasklistIds());

  const items = [];
  let pageToken;
  do {
    const res = await tasksApi.tasklists.list({ pageToken, maxResults: 100 });
    for (const tl of res.data.items || []) {
      items.push({ id: tl.id, title: tl.title || tl.id, enabled: enabledSet.has(tl.id) });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return items;
}

// --------------------------------------------------------
// Mapper
// --------------------------------------------------------

/** Erste vorhandene User-ID als Fallback-Ersteller (analog ICS/CalDAV). */
function firstUserId() {
  const owner = db.get().prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  return owner ? owner.id : null;
}

/**
 * Google-Task → lokales tasks-Feld-Set.
 * Google-`due` ist datumsbasiert (Uhrzeit wird ignoriert) → nur due_date.
 */
function googleTaskToLocal(task) {
  return {
    title:       task.title && task.title.trim() ? task.title : '(kein Titel)',
    description: task.notes || null,
    status:      task.status === 'completed' ? 'done' : 'open',
    due_date:    task.due ? task.due.slice(0, 10) : null,
    google_updated: task.updated || null,
  };
}

/**
 * Lokale Aufgabe → Google-Tasks-requestBody (Outbound).
 * Nur die round-trip-fähigen Felder werden übertragen.
 */
function localTaskToGoogle(row) {
  const body = {
    title: row.title || '',
    notes: row.description || undefined,
  };
  // Lokal 'done' oder 'archived' → in Google abgeschlossen.
  const done = row.status === 'done' || row.status === 'archived';
  body.status = done ? 'completed' : 'needsAction';
  if (done) {
    body.completed = new Date().toISOString();
  } else {
    // Wiedereröffnen: completed-Zeitstempel entfernen.
    body.completed = null;
  }
  if (row.due_date) {
    body.due = `${row.due_date}T00:00:00.000Z`;
  }
  return body;
}

// --------------------------------------------------------
// Inbound-Upsert (Zwei-Pass wegen parent-Auflösung)
// --------------------------------------------------------

/**
 * Upsert einer Liste von Google-Tasks in die lokale tasks-Tabelle.
 * Pass 1: alle Zeilen einfügen/aktualisieren (ohne parent).
 * Pass 2: parent_task_id anhand der (tasklist_id, external_uid)-Zuordnung setzen.
 * Löschungen (task.deleted) werden sofort entfernt.
 * @returns {{ upserted: number, deleted: number }}
 */
function upsertGoogleTasks(items, tasklistId, createdBy) {
  let upserted = 0;
  let deleted = 0;

  const selById = db.get().prepare(
    `SELECT id, google_dirty FROM tasks WHERE external_source = 'google' AND google_tasklist_id = ? AND external_uid = ?`
  );
  const delById = db.get().prepare(
    `DELETE FROM tasks WHERE external_source = 'google' AND google_tasklist_id = ? AND external_uid = ?`
  );

  db.get().transaction(() => {
    // Pass 1
    for (const task of items) {
      if (task.deleted) {
        const r = delById.run(tasklistId, task.id);
        deleted += r.changes;
        continue;
      }
      const local = googleTaskToLocal(task);
      const existing = selById.get(tasklistId, task.id);
      if (existing) {
        // Konfliktregel: lokale Änderung gewinnt, bis sie gepusht wurde.
        if (existing.google_dirty) continue;
        db.get().prepare(`
          UPDATE tasks
          SET title = ?, description = ?, status = ?, due_date = ?, google_updated = ?
          WHERE id = ?
        `).run(local.title, local.description, local.status, local.due_date, local.google_updated, existing.id);
      } else {
        db.get().prepare(`
          INSERT INTO tasks
            (title, description, status, due_date, created_by, visibility,
             external_uid, external_source, google_tasklist_id, google_updated)
          VALUES (?, ?, ?, ?, ?, 'all', ?, 'google', ?, ?)
        `).run(local.title, local.description, local.status, local.due_date, createdBy,
               task.id, tasklistId, local.google_updated);
      }
      upserted++;
    }

    // Pass 2: parent-Auflösung
    for (const task of items) {
      if (task.deleted || !task.parent) continue;
      const child  = selById.get(tasklistId, task.id);
      const parent = selById.get(tasklistId, task.parent);
      if (child && parent) {
        db.get().prepare('UPDATE tasks SET parent_task_id = ? WHERE id = ?').run(parent.id, child.id);
      }
    }
  })();

  return { upserted, deleted };
}

// --------------------------------------------------------
// Sync
// --------------------------------------------------------

async function sync() {
  if (!getAuthStatus().connected) return;
  if (!hasScope(SCOPES.TASKS)) {
    log.warn('Tasks scope not granted - reconnect required, sync skipped.');
    return;
  }

  const client   = loadAuthorizedClient();
  const tasksApi = google.tasks({ version: 'v1', auth: client });
  const createdBy = firstUserId();
  if (createdBy == null) {
    log.warn('No users exist yet - task sync skipped.');
    return;
  }

  const tasklistIds = enabledTasklistIds();

  // --------------------------------------------------------
  // Inbound: je aktivierte Liste mit eigenem updated_min-Cursor
  // --------------------------------------------------------
  for (const tasklistId of tasklistIds) {
    const syncStart = new Date().toISOString();
    let updatedMin = getUpdatedMin(tasklistId);
    let pageToken;

    try {
      do {
        const listParams = {
          tasklist:      tasklistId,
          showCompleted: true,
          showHidden:    true,
          showDeleted:   true,
          maxResults:    100,
          pageToken,
        };
        if (updatedMin) listParams.updatedMin = updatedMin;

        let response;
        try {
          response = await tasksApi.tasks.list(listParams);
        } catch (err) {
          // Ungültiger/veralteter updated_min → Cursor verwerfen, Vollabgleich.
          if (err.code === 400 && updatedMin) {
            log.warn(`updatedMin invalid (${tasklistId}) - full resync.`);
            updatedMin = null;
            pageToken = undefined;
            continue;
          }
          throw err;
        }

        upsertGoogleTasks(response.data.items || [], tasklistId, createdBy);
        pageToken = response.data.nextPageToken;
      } while (pageToken);

      recordSync(tasklistId, syncStart);
    } catch (err) {
      log.error(`Inbound error (${tasklistId}):`, err.message);
    }
  }

  // --------------------------------------------------------
  // Outbound A: Pushback lokal geänderter importierter Aufgaben
  // --------------------------------------------------------
  const dirtyRows = db.get().prepare(
    `SELECT * FROM tasks WHERE external_source = 'google' AND google_dirty = 1`
  ).all();
  for (const row of dirtyRows) {
    try {
      await pushRow(tasksApi, row);
    } catch (err) {
      log.error(`Pushback error (task ${row.id}):`, err.message);
    }
  }

  // --------------------------------------------------------
  // Outbound B: Export lokaler Aufgaben mit explizitem Google-Ziel
  // --------------------------------------------------------
  const exportRows = db.get().prepare(
    `SELECT * FROM tasks WHERE external_source = 'local' AND target_google_tasklist_id IS NOT NULL`
  ).all();
  const activeSet = new Set(tasklistIds);
  for (const row of exportRows) {
    const targetId = row.target_google_tasklist_id;
    if (!activeSet.has(targetId)) {
      log.warn(`Target tasklist ${targetId} not active, skipping task ${row.id}.`);
      continue;
    }
    try {
      const created = await tasksApi.tasks.insert({ tasklist: targetId, requestBody: localTaskToGoogle(row) });
      db.get().prepare(`
        UPDATE tasks
        SET external_source = 'google', external_uid = ?, google_tasklist_id = ?,
            target_google_tasklist_id = NULL, google_updated = ?, google_dirty = 0
        WHERE id = ?
      `).run(created.data.id, targetId, created.data.updated || null, row.id);
    } catch (err) {
      log.error(`Export error (task ${row.id}):`, err.message);
    }
  }

  cfgSet('google_tasks_last_sync', new Date().toISOString());
}

/** Eine einzelne dirty-Zeile via tasks.patch zu Google übertragen. */
async function pushRow(tasksApi, row) {
  if (!row.google_tasklist_id || !row.external_uid) return;
  const res = await tasksApi.tasks.patch({
    tasklist:    row.google_tasklist_id,
    task:        row.external_uid,
    requestBody: localTaskToGoogle(row),
  });
  db.get().prepare(
    `UPDATE tasks SET google_dirty = 0, google_updated = ? WHERE id = ?`
  ).run(res.data.updated || null, row.id);
}

// --------------------------------------------------------
// Route-Hooks
// --------------------------------------------------------

/** Markiert eine importierte Aufgabe als geändert (Pushback im nächsten Sync). */
function markDirty(taskId) {
  db.get().prepare(
    `UPDATE tasks SET google_dirty = 1 WHERE id = ? AND external_source = 'google'`
  ).run(taskId);
}

/**
 * Fire-and-forget-Pushback einer einzelnen Aufgabe (aus Route-Handlern).
 * Bei Fehler bleibt google_dirty=1 und der nächste Sync versucht es erneut.
 */
async function pushTaskUpdate(taskId) {
  if (!getAuthStatus().connected || !hasScope(SCOPES.TASKS)) return;
  const row = db.get().prepare(
    `SELECT * FROM tasks WHERE id = ? AND external_source = 'google' AND google_dirty = 1`
  ).get(taskId);
  if (!row) return;
  const client = loadAuthorizedClient();
  const tasksApi = google.tasks({ version: 'v1', auth: client });
  await pushRow(tasksApi, row);
}

/** Löschung einer Google-Aufgabe zurückspielen (404 wird toleriert). */
async function pushTaskDeletion(tasklistId, taskId) {
  if (!tasklistId || !taskId) return;
  if (!getAuthStatus().connected || !hasScope(SCOPES.TASKS)) return;
  const client = loadAuthorizedClient();
  const tasksApi = google.tasks({ version: 'v1', auth: client });
  try {
    await tasksApi.tasks.delete({ tasklist: tasklistId, task: taskId });
  } catch (err) {
    if (err.code === 404) return;
    throw err;
  }
}

// --------------------------------------------------------
// Status
// --------------------------------------------------------

function getStatus() {
  const auth = getAuthStatus();
  // Aktivierte Listen aus der DB (kein Google-Roundtrip) — für den optionalen
  // "Auch zu Google Tasks hinzufügen"-Select im Aufgaben-Modal.
  const enabledLists = db.get().prepare(
    'SELECT tasklist_id AS id, name FROM google_tasklist_selection WHERE enabled = 1'
  ).all();
  return {
    configured:     auth.configured,
    connected:      auth.connected,
    scopeGranted:   hasScope(SCOPES.TASKS),
    needsReconsent: auth.connected && !hasScope(SCOPES.TASKS),
    selectedCount:  enabledLists.length,
    enabledLists,
    lastSync:       cfgGet('google_tasks_last_sync'),
  };
}

export {
  listTasklists, setTasklistEnabled, sync, getStatus,
  markDirty, pushTaskUpdate, pushTaskDeletion,
};

export const __test = {
  googleTaskToLocal, localTaskToGoogle, upsertGoogleTasks,
  setTasklistEnabled, enabledTasklistIds, getUpdatedMin, recordSync, markDirty,
};
