/**
 * Modul: Google Calendar Sync
 * Zweck: Bidirektionaler Sync mit Google Calendar API v3.
 *        Die OAuth-Schicht (Client, Tokens, Scopes) liegt geteilt in
 *        server/services/google-auth.js.
 * Abhängigkeiten: googleapis, server/db.js, server/services/google-auth.js
 *
 * sync_config-Schlüssel (calendar-spezifisch):
 *   google_last_sync      - ISO-8601-Timestamp des letzten erfolgreichen Syncs
 *   google_readonly       - '1' wenn Outbound-Sync deaktiviert ist
 */

import { createLogger } from '../logger.js';
const log = createLogger('Google');

import { google } from 'googleapis';
import * as db from '../db.js';
import { decodeHtmlEntities } from '../utils/html-entities.js';
import { nearestColorId } from '../utils/ical-color.js';
import { assignDefaultToEvent } from './sync-assignment.js';
import {
  cfgGet, cfgSet, cfgDel, createClient, loadAuthorizedClient,
  getAuthUrl, handleCallback, getAuthStatus, disconnectAuth, hasScope, SCOPES,
} from './google-auth.js';

const GOOGLE_COLOR = '#4285F4';

function upsertExternalCalendar(source, externalId, name, color) {
  // Provider-Namen können HTML-entity-encoded sein (Google liefert das z. B. für
  // Import-Kalender) — zu Klartext normalisieren, sonst escaped die UI doppelt.
  const row = db.get().prepare(`
    INSERT INTO external_calendars (source, external_id, name, color)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source, external_id) DO UPDATE SET
      name  = excluded.name,
      color = excluded.color
    RETURNING id
  `).get(source, externalId, decodeHtmlEntities(name), color);
  return row.id;
}

// --------------------------------------------------------
// Read-only-Modus (calendar-spezifisch)
// --------------------------------------------------------

function isReadonly() {
  return cfgGet('google_readonly') === '1';
}

function setReadonly(enabled) {
  if (enabled) {
    cfgSet('google_readonly', '1');
  } else {
    cfgDel('google_readonly');
  }
}

/** Nur owner/writer dürfen via events.insert beschrieben werden. */
function isWritableRole(role) {
  return role === 'owner' || role === 'writer';
}

// --------------------------------------------------------
// Kalenderauswahl (Mehrkalender, Issue #237)
// --------------------------------------------------------

/** Alle bekannten Kalenderauswahl-Zeilen. */
function listSelection() {
  return db.get().prepare(
    'SELECT calendar_id, name, color, enabled, sync_token, last_sync FROM google_calendar_selection'
  ).all();
}

/** IDs der aktuell aktivierten Kalender. */
function enabledCalendarIds() {
  return db.get().prepare(
    'SELECT calendar_id FROM google_calendar_selection WHERE enabled = 1'
  ).all().map((r) => r.calendar_id);
}

/**
 * Aktiviert/deaktiviert einen Kalender. Beim Aktivieren werden name/color
 * (sofern übergeben) als Metadaten gespeichert. Beim Deaktivieren werden die
 * importierten Events dieses Kalenders entfernt und der Sync-Token zurückgesetzt,
 * damit ein erneutes Aktivieren sauber von Grund auf neu liest.
 * @param {string} calendarId
 * @param {boolean} enabled
 * @param {{name?:string,color?:string}} [meta]
 */
function setCalendarEnabled(calendarId, enabled, meta = {}) {
  if (typeof calendarId !== 'string' || calendarId.trim().length === 0) {
    throw new Error('[Google] calendarId fehlt oder ist ungültig.');
  }
  const id = calendarId.trim();
  const flag = enabled ? 1 : 0;

  db.get().prepare(`
    INSERT INTO google_calendar_selection (calendar_id, name, color, enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(calendar_id) DO UPDATE SET
      enabled = excluded.enabled,
      name    = COALESCE(excluded.name, google_calendar_selection.name),
      color   = COALESCE(excluded.color, google_calendar_selection.color)
  `).run(id, meta.name || id, meta.color || null, flag);

  if (!enabled) {
    db.get().prepare(`
      DELETE FROM calendar_events
      WHERE external_source = 'google' AND calendar_ref_id IN (
        SELECT id FROM external_calendars WHERE source = 'google' AND external_id = ?
      )
    `).run(id);
    db.get().prepare(
      'UPDATE google_calendar_selection SET sync_token = NULL, last_sync = NULL WHERE calendar_id = ?'
    ).run(id);
  }
}

/** Per-Kalender-Sync-Token + last_sync nach erfolgreichem Inbound speichern. */
function recordSyncToken(calendarId, token) {
  db.get().prepare(`
    UPDATE google_calendar_selection
    SET sync_token = ?, last_sync = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE calendar_id = ?
  `).run(token, calendarId);
}

function getSyncToken(calendarId) {
  const row = db.get().prepare(
    'SELECT sync_token FROM google_calendar_selection WHERE calendar_id = ?'
  ).get(calendarId);
  return row ? row.sync_token : null;
}

/**
 * Listet die für den verbundenen Account verfügbaren Google-Kalender.
 * @returns {Promise<Array<{id,summary,primary,backgroundColor,enabled,accessRole,writable}>>}
 */
async function listCalendars() {
  const client   = loadAuthorizedClient();
  const calendar = google.calendar({ version: 'v3', auth: client });
  const enabledSet = new Set(enabledCalendarIds());
  // Standard-Zuweisung je Kalender (#459) aus der geteilten external_calendars-Tabelle.
  const assigneeMap = new Map(
    db.get().prepare(`SELECT external_id, default_assignee_user_id FROM external_calendars WHERE source = 'google'`)
      .all().map((r) => [r.external_id, r.default_assignee_user_id])
  );

  const items = [];
  let pageToken;
  do {
    const res = await calendar.calendarList.list({ pageToken, maxResults: 250 });
    for (const cal of res.data.items || []) {
      items.push({
        id:              cal.id,
        summary:         cal.summaryOverride || cal.summary || cal.id,
        primary:         !!cal.primary,
        backgroundColor: cal.backgroundColor || GOOGLE_COLOR,
        enabled:         enabledSet.has(cal.id),
        accessRole:      cal.accessRole ?? null,
        writable:        isWritableRole(cal.accessRole),
        default_assignee_user_id: assigneeMap.get(cal.id) ?? null,
        synced:          assigneeMap.has(cal.id),
      });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return items;
}

// --------------------------------------------------------
// Öffentliche API
// --------------------------------------------------------

/**
 * Verbindungsstatus zurückgeben.
 * `needsReconsent` ist true, wenn verbunden, aber nicht alle Suite-Scopes
 * gewährt sind (z. B. Alt-Installation mit reinem Calendar-Token) — die
 * Settings-UI blendet dann einen "Erneut verbinden"-Hinweis ein.
 */
function getStatus() {
  const auth = getAuthStatus();
  return {
    configured: auth.configured,
    connected:  auth.connected,
    lastSync:   cfgGet('google_last_sync'),
    selectedCount:  enabledCalendarIds().length,
    readonly:       isReadonly(),
    grantedScopes:  auth.grantedScopes,
    needsReconsent: auth.connected && auth.missingScopes.length > 0,
  };
}

/**
 * Tokens und Sync-State löschen (Verbindung trennen).
 * Löscht die geteilten OAuth-Tokens plus den calendar-spezifischen State.
 */
function disconnect() {
  disconnectAuth();
  ['google_last_sync', 'google_readonly'].forEach(cfgDel);
  db.get().prepare('DELETE FROM google_calendar_selection').run();
  log.info('Disconnected.');
}

/**
 * Bidirektionaler Sync.
 * Inbound:  Google → lokale DB (Upsert via external_calendar_id)
 * Outbound: lokale Termine (external_source='local', external_calendar_id IS NULL) → Google
 */
async function sync() {
  // Defensiv: ohne Calendar-Scope gar nicht erst versuchen (Alt-Token, das noch
  // nicht neu freigegeben wurde). Sollte im Normalfall immer gewährt sein.
  if (!hasScope(SCOPES.CALENDAR)) {
    log.warn('Calendar scope not granted - reconnect required, sync skipped.');
    return;
  }

  const client   = loadAuthorizedClient();
  const calendar = google.calendar({ version: 'v3', auth: client });

  // Event-Farbpalette (colorId → Hex) einmalig für den ganzen Sync laden.
  const eventColorMap = await fetchEventColorMap(calendar);

  const calendarIds = enabledCalendarIds();
  // accessRole je Kalender, memoisiert über Inbound + Outbound hinweg.
  const roleCache = new Map();

  // --------------------------------------------------------
  // Inbound: jeder aktivierte Kalender mit eigenem syncToken
  // --------------------------------------------------------
  for (const calendarId of calendarIds) {
    let calRefId = null;
    let calColor = GOOGLE_COLOR;
    try {
      const meta = await calendar.calendarList.get({ calendarId });
      calColor   = meta.data.backgroundColor || GOOGLE_COLOR;
      roleCache.set(calendarId, meta.data.accessRole ?? null);
      const calName = meta.data.summaryOverride || meta.data.summary || 'Google Calendar';
      calRefId   = upsertExternalCalendar('google', calendarId, calName, calColor);
    } catch (err) {
      log.warn(`Calendar metadata is not accessible (${calendarId}):`, err.message);
    }

    let syncToken    = getSyncToken(calendarId);
    let pageToken    = undefined;
    let newSyncToken = null;

    do {
      const listParams = { calendarId, singleEvents: true, pageToken };
      if (syncToken) {
        listParams.syncToken = syncToken;
      } else {
        listParams.timeMin = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        listParams.timeMax = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      }

      let response;
      try {
        response = await calendar.events.list(listParams);
      } catch (err) {
        if (err.code === 410) {
          log.warn(`syncToken invalid (${calendarId}) - full resync.`);
          recordSyncToken(calendarId, null);
          syncToken = null;
          continue;
        }
        throw err;
      }

      upsertGoogleEvents(response.data.items || [], calRefId, calColor, eventColorMap);
      pageToken    = response.data.nextPageToken;
      newSyncToken = response.data.nextSyncToken || newSyncToken;
    } while (pageToken);

    if (newSyncToken) recordSyncToken(calendarId, newSyncToken);
  }

  // --------------------------------------------------------
  // Outbound: nur lokale Events mit explizitem Google-Ziel
  // --------------------------------------------------------
  if (isReadonly()) {
    log.info('Read-only mode – outbound sync skipped.');
  } else {
    const localEvents = db.get().prepare(`
      SELECT * FROM calendar_events
      WHERE external_source = 'local' AND target_google_calendar_id IS NOT NULL
    `).all();

    const activeIds = new Set(calendarIds);
    for (const event of localEvents) {
      const targetId = event.target_google_calendar_id;
      if (!activeIds.has(targetId)) {
        log.warn(`Target calendar ${targetId} not active, skipping event ${event.id}.`);
        continue;
      }
      let role = roleCache.get(targetId);
      if (role === undefined) {
        // Inbound metadata fetch failed for this calendar; treat as not writable.
        role = null;
      }
      if (!isWritableRole(role)) {
        log.warn(`Target calendar ${targetId} has no writable role (role=${role}), skipping event ${event.id}.`);
        continue;
      }
      try {
        const gEvent  = localEventToGoogle(event, eventColorMap);
        const created = await calendar.events.insert({ calendarId: targetId, requestBody: gEvent });
        const calRefId = upsertExternalCalendar('google', targetId, targetId, GOOGLE_COLOR);
        db.get().prepare(`
          UPDATE calendar_events
          SET external_calendar_id = ?, external_source = 'google', calendar_ref_id = ?
          WHERE id = ?
        `).run(created.data.id, calRefId, event.id);
      } catch (err) {
        log.error(`Outbound error for event ${event.id}:`, err.message);
      }
    }
    log.info(`Sync completed - ${localEvents.length} candidate local → Google.`);
  }

  cfgSet('google_last_sync', new Date().toISOString());
}

// Google Calendar uses exclusive end dates for all-day events (RFC 5545).
// A 2-day event Jan 1–2 is stored as end.date = "2026-01-03" (exclusive).
// Subtract 1 day to convert to Yuvomi-style inclusive end date.
function googleAllDayEndToInclusive(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Yuvomi stores inclusive end dates. Add 1 day when sending to Google (exclusive).
function localAllDayEndToExclusive(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// --------------------------------------------------------
// Helfer: Event-Farbpalette (colorId → Hex)
// --------------------------------------------------------

// Die Event-Palette ist praktisch statisch — modul-weit cachen, damit nicht jeder
// Sync (u. U. alle paar Minuten) einen colors.get-Roundtrip auslöst.
let _eventColorCache = null; // { map: Record<string,string>, ts: number }
const EVENT_COLOR_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Lädt Googles Event-Farbpalette und mappt colorId ("1".."11") auf den jeweiligen
 * Hintergrund-Hex. Google liefert Event-Farben ausschließlich als Paletten-ID; die
 * realen Hex-Werte stehen nur im colors-Endpoint. Ergebnis wird 24 h gecacht. Bei
 * Fehlern → letzter Cache, sonst leeres Objekt (Sync fällt auf Kalenderfarbe zurück).
 * @param {import('googleapis').calendar_v3.Calendar} calendar
 * @returns {Promise<Record<string,string>>}
 */
async function fetchEventColorMap(calendar) {
  if (_eventColorCache && (Date.now() - _eventColorCache.ts) < EVENT_COLOR_TTL_MS) {
    return _eventColorCache.map;
  }
  try {
    const res   = await calendar.colors.get();
    const event = res.data?.event || {};
    const map   = {};
    for (const [id, def] of Object.entries(event)) {
      if (def?.background) map[id] = String(def.background).toUpperCase();
    }
    _eventColorCache = { map, ts: Date.now() };
    return map;
  } catch (err) {
    log.warn('Event color palette not available:', err.message);
    return _eventColorCache?.map || {};
  }
}

// --------------------------------------------------------
// Helfer: Google-Event in lokale DB upserten
// --------------------------------------------------------

function upsertGoogleEvents(items, calRefId = null, calColor = GOOGLE_COLOR, colorMap = {}) {
  const del = db.get().prepare(`
    DELETE FROM calendar_events WHERE external_calendar_id = ? AND external_source = 'google'
  `);

  // Standard-Zuweisung dieses Kalenders (#459) — einmal auflösen.
  const defaultAssignee = calRefId
    ? db.get().prepare('SELECT default_assignee_user_id FROM external_calendars WHERE id = ?')
        .get(calRefId)?.default_assignee_user_id ?? null
    : null;

  const insertOrUpdate = db.get().transaction((item) => {
    if (item.status === 'cancelled') {
      del.run(item.id);
      return;
    }

    const allDay      = !!(item.start?.date && !item.start?.dateTime);
    const startDt     = allDay ? item.start.date : (item.start?.dateTime || item.start?.date);
    const endDt       = allDay
      ? googleAllDayEndToInclusive(item.end?.date)
      : (item.end?.dateTime || item.end?.date || null);
    const title       = item.summary || '(kein Titel)';
    const description = item.description || null;
    const location    = item.location    || null;
    const rrule       = item.recurrence  ? item.recurrence[0] : null;

    // Event-Eigenfarbe aus colorId auflösen (Google liefert nur die Paletten-ID),
    // sonst Kalenderfarbe als Default.
    const evColor = (item.colorId && colorMap[item.colorId]) || calColor;

    const existing = db.get().prepare(
      'SELECT id FROM calendar_events WHERE external_calendar_id = ? AND external_source = ?'
    ).get(item.id, 'google');

    if (existing) {
      // color nur überschreiben, solange der Nutzer nicht lokal umgefärbt hat
      // (user_modified = 0). Dadurch bleiben benutzerdefinierte Event-Farben über
      // Syncs hinweg erhalten (Issue #219), während echte Google-Farbänderungen
      // weiterhin durchkommen. Titel/Zeit bleiben unverändert remote-geführt.
      db.get().prepare(`
        UPDATE calendar_events
        SET title = ?, description = ?, start_datetime = ?, end_datetime = ?,
            all_day = ?, location = ?, recurrence_rule = ?,
            color = CASE WHEN user_modified = 0 THEN ? ELSE color END,
            calendar_ref_id = ?
        WHERE id = ?
      `).run(title, description, startDt, endDt, allDay ? 1 : 0, location, rrule, evColor, calRefId, existing.id);
    } else {
      const inserted = db.get().prepare(`
        INSERT INTO calendar_events
          (title, description, start_datetime, end_datetime, all_day,
           location, color, external_calendar_id, external_source, recurrence_rule, calendar_ref_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'google', ?, ?, 1)
      `).run(title, description, startDt, endDt, allDay ? 1 : 0, location, evColor, item.id, rrule, calRefId);
      assignDefaultToEvent(db.get(), inserted.lastInsertRowid, defaultAssignee);
    }
  });

  for (const item of items) {
    if (!item) continue;
    try {
      insertOrUpdate(item);
    } catch (err) {
      log.error(`Upsert error for event ${item?.id}:`, err.message);
    }
  }
}

// Yuvomi speichert getimte Events als "YYYY-MM-DDTHH:MM" (ohne Sekunden,
// siehe validate.js). Die Google Calendar API verlangt RFC 3339 mit
// Sekunden, sonst "Bad Request" bzw. bei Wiederholungen "Invalid
// recurrence rule" (Issue #217). Sekunden ergänzen, falls sie fehlen.
function toRfc3339(dt) {
  if (!dt) return dt;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dt) ? `${dt}:00` : dt;
}

// RFC 5545: Der Werttyp von UNTIL muss dem von DTSTART entsprechen.
// buildRRule liefert UNTIL immer als DATE-TIME (YYYYMMDDTHHMMSSZ).
//   - all-day-Events (start.date):    UNTIL muss DATE sein (YYYYMMDD)
//   - getimte Events (start.dateTime): UNTIL muss UTC DATE-TIME sein
// Andernfalls lehnt Google die Recurrence ab ("Invalid recurrence rule").
function normalizeRecurrenceUntil(rule, allDay) {
  return rule.split(';').map((segment) => {
    const eq = segment.indexOf('=');
    if (eq === -1) return segment;
    if (segment.slice(0, eq).toUpperCase() !== 'UNTIL') return segment;
    const digits   = segment.slice(eq + 1).replace(/\D/g, '');
    const datePart = digits.slice(0, 8);
    if (allDay) return `UNTIL=${datePart}`;
    const timePart = digits.length > 8 ? digits.slice(8, 14).padEnd(6, '0') : '235959';
    return `UNTIL=${datePart}T${timePart}Z`;
  }).join(';');
}

function localEventToGoogle(event, colorMap = {}) {
  const allDay = !!event.all_day;
  const gEvent = {
    summary:     event.title,
    description: event.description || undefined,
    location:    event.location    || undefined,
  };

  // Event-Farbe verlustbehaftet auf die nächste der 11 Google-colorIds mappen.
  // Ohne verfügbare Palette (colors.get fehlgeschlagen) bleibt colorId ungesetzt,
  // dann erbt das Event in Google die Kalenderfarbe.
  if (event.color) {
    const colorId = nearestColorId(event.color, colorMap);
    if (colorId) gEvent.colorId = colorId;
  }

  if (allDay) {
    const startDate = event.start_datetime.slice(0, 10);
    const endDate   = event.end_datetime ? event.end_datetime.slice(0, 10) : startDate;
    gEvent.start = { date: startDate };
    gEvent.end   = { date: localAllDayEndToExclusive(endDate) };
  } else {
    const startDt = toRfc3339(event.start_datetime);
    const endDt   = toRfc3339(event.end_datetime) || startDt;
    gEvent.start = { dateTime: startDt, timeZone: 'Europe/Berlin' };
    gEvent.end   = { dateTime: endDt,   timeZone: 'Europe/Berlin' };
  }

  if (event.recurrence_rule) {
    const body = event.recurrence_rule.startsWith('RRULE:')
      ? event.recurrence_rule.slice('RRULE:'.length)
      : event.recurrence_rule;
    gEvent.recurrence = [`RRULE:${normalizeRecurrenceUntil(body, allDay)}`];
  }

  return gEvent;
}

// getAuthUrl/handleCallback werden aus der geteilten Auth-Schicht re-exportiert,
// damit server/routes/calendar.js unverändert bleibt.
export { getAuthUrl, handleCallback };
export { getStatus, disconnect, sync, listCalendars,
         listSelection, setCalendarEnabled, setReadonly };
export const __test = {
  localEventToGoogle, googleAllDayEndToInclusive, localAllDayEndToExclusive,
  upsertGoogleEvents, upsertExternalCalendar, setReadonly, isReadonly, isWritableRole,
  listSelection, setCalendarEnabled, recordSyncToken, getSyncToken, enabledCalendarIds,
  fetchEventColorMap,
};
