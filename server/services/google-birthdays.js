/**
 * Modul: Google Geburtstage (Import)
 * Zweck: Geburtstage AUS Google Calendar in die Birthdays-Sektion importieren
 *        (umgekehrte Richtung: Google → lokal). Importierte Einträge sind
 *        schreibgeschützt außer den Erinnerungseinstellungen; manuelle
 *        Geburtstage bleiben unverändert lokal.
 * Abhängigkeiten: googleapis, server/db.js, server/services/google-auth.js,
 *                 server/services/birthdays.js
 *
 * sync_config-Schlüssel:
 *   google_birthdays_enabled      - '1' wenn Import aktiv
 *   google_birthdays_calendar_id  - Quell-Kalender-ID
 *   google_birthdays_last_sync    - ISO-8601-Timestamp des letzten Syncs
 */

import { createLogger } from '../logger.js';
const log = createLogger('GoogleBirthdays');

import { google } from 'googleapis';
import * as db from '../db.js';
import { cfgGet, cfgSet, cfgDel, loadAuthorizedClient, hasScope, getAuthStatus, SCOPES } from './google-auth.js';
import { syncBirthdayArtifacts, deleteBirthdayArtifacts } from './birthdays.js';

// Googles spezieller Kontakte-Geburtstagskalender. Taucht oft NICHT in
// calendarList auf, ist aber direkt über events.list abfragbar.
const CONTACTS_BIRTHDAY_CALENDAR = 'addressbook#contacts@group.v.calendar.google.com';

function calendarClient() {
  const client = loadAuthorizedClient();
  return google.calendar({ version: 'v3', auth: client });
}

function isEnabled() {
  return cfgGet('google_birthdays_enabled') === '1';
}

function sourceCalendarId() {
  return cfgGet('google_birthdays_calendar_id') || CONTACTS_BIRTHDAY_CALENDAR;
}

/** Erste vorhandene User-ID als Ersteller-Fallback (analog ICS/CalDAV). */
function firstUserId() {
  const owner = db.get().prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  return owner ? owner.id : null;
}

// --------------------------------------------------------
// Namensableitung
// --------------------------------------------------------

/**
 * Leitet den Namen aus der (lokalisierten) Event-Zusammenfassung ab.
 * Entfernt best-effort typische Suffixe wie "…'s birthday" oder "… hat Geburtstag".
 */
function nameFromSummary(summary) {
  const raw = String(summary || '').trim();
  if (!raw) return '';
  const patterns = [
    /^(.*?)'s birthday$/i,
    /^(.*?)’s birthday$/i,
    /\s+hat Geburtstag$/i,   // "Max hat Geburtstag"
    /^Geburtstag von\s+(.*)$/i,
  ];
  for (const re of patterns) {
    const m = re.exec(raw);
    if (m) return (m[1] ?? raw.replace(re, '')).trim() || raw;
  }
  return raw;
}

/** Prüft, ob ein Event als Geburtstag zählt (eventType oder jährliche Serie). */
function isBirthdayEvent(event) {
  if (event.eventType === 'birthday') return true;
  if (Array.isArray(event.recurrence) && event.recurrence.some((r) => /FREQ=YEARLY/i.test(r))) return true;
  return false;
}

// --------------------------------------------------------
// Quelle prüfen
// --------------------------------------------------------

/**
 * Versucht, den Kontakte-Geburtstagskalender direkt abzufragen. Schlägt das
 * fehl (nicht verfügbar), kann der Nutzer einen beliebigen Kalender als Quelle
 * wählen.
 * @returns {Promise<boolean>}
 */
async function probeContactsCalendar() {
  try {
    const cal = calendarClient();
    await cal.events.list({ calendarId: CONTACTS_BIRTHDAY_CALENDAR, maxResults: 1, eventTypes: ['birthday'] });
    return true;
  } catch (err) {
    log.info('Contacts birthday calendar not available:', err.message);
    return false;
  }
}

// --------------------------------------------------------
// Upsert
// --------------------------------------------------------

function upsertBirthday(event, createdBy) {
  const name = nameFromSummary(event.summary);
  const birthDate = event.start?.date || null; // Geburtstags-Events sind ganztägig
  if (!name || !birthDate) return null;

  const existing = db.get().prepare(
    `SELECT * FROM birthdays WHERE external_source = 'google' AND google_event_id = ?`
  ).get(event.id);

  if (existing) {
    db.get().prepare(
      `UPDATE birthdays SET name = ?, birth_date = ? WHERE id = ?`
    ).run(name, birthDate, existing.id);
    return { ...existing, name, birth_date: birthDate };
  }

  const result = db.get().prepare(`
    INSERT INTO birthdays (name, birth_date, created_by, reminder_offset, external_source, google_event_id)
    VALUES (?, ?, ?, '', 'google', ?)
  `).run(name, birthDate, createdBy, event.id);
  return db.get().prepare('SELECT * FROM birthdays WHERE id = ?').get(result.lastInsertRowid);
}

// --------------------------------------------------------
// Sync (Inbound: Google → birthdays)
// --------------------------------------------------------

async function sync() {
  if (!isEnabled()) return;
  if (!getAuthStatus().connected) return;
  if (!hasScope(SCOPES.CALENDAR)) {
    log.warn('Calendar scope not granted - reconnect required, birthday sync skipped.');
    return;
  }
  const createdBy = firstUserId();
  if (createdBy == null) return;

  const calendarId = sourceCalendarId();
  const isContacts = calendarId === CONTACTS_BIRTHDAY_CALENDAR;
  const cal = calendarClient();

  const seen = new Set();
  try {
    let pageToken;
    do {
      const params = { calendarId, singleEvents: false, maxResults: 250, pageToken };
      // Der Kontakte-Kalender unterstützt den eventTypes-Filter; bei beliebigen
      // Quell-Kalendern filtern wir clientseitig.
      if (isContacts) params.eventTypes = ['birthday'];

      const res = await cal.events.list(params);
      for (const event of res.data.items || []) {
        if (event.status === 'cancelled') continue;
        if (!isContacts && !isBirthdayEvent(event)) continue;
        const row = upsertBirthday(event, createdBy);
        if (row) {
          // Lokales Kalender-Event + Erinnerung wie bei manuellen Geburtstagen.
          db.get().transaction(() => syncBirthdayArtifacts(db.get(), db.get().prepare('SELECT * FROM birthdays WHERE id = ?').get(row.id)))();
          seen.add(event.id);
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);

    pruneRemoved(seen);
    cfgSet('google_birthdays_last_sync', new Date().toISOString());
  } catch (err) {
    log.error('Birthday sync error:', err.message);
  }
}

/** Verschwundene importierte Geburtstage samt Artefakten entfernen. */
function pruneRemoved(seenEventIds) {
  const rows = db.get().prepare(
    `SELECT * FROM birthdays WHERE external_source = 'google'`
  ).all();
  for (const row of rows) {
    if (!seenEventIds.has(row.google_event_id)) {
      db.get().transaction(() => {
        deleteBirthdayArtifacts(db.get(), row);
        db.get().prepare('DELETE FROM birthdays WHERE id = ?').run(row.id);
      })();
    }
  }
}

// --------------------------------------------------------
// Quelle setzen / Status
// --------------------------------------------------------

/**
 * Aktiviert/deaktiviert den Import und legt den Quell-Kalender fest.
 * Beim Deaktivieren werden alle importierten Geburtstage samt Artefakten entfernt.
 * Gibt eine Warnung zurück, wenn der Quell-Kalender auch im normalen
 * Kalender-Sync aktiv ist (Duplikat-Gefahr).
 */
function setSource({ calendarId, enabled }) {
  if (enabled) {
    cfgSet('google_birthdays_enabled', '1');
    if (calendarId) cfgSet('google_birthdays_calendar_id', calendarId);
  } else {
    cfgDel('google_birthdays_enabled');
    const rows = db.get().prepare(`SELECT * FROM birthdays WHERE external_source = 'google'`).all();
    db.get().transaction(() => {
      for (const row of rows) {
        deleteBirthdayArtifacts(db.get(), row);
        db.get().prepare('DELETE FROM birthdays WHERE id = ?').run(row.id);
      }
    })();
  }

  const chosen = calendarId || sourceCalendarId();
  const alsoSynced = !!db.get().prepare(
    'SELECT 1 FROM google_calendar_selection WHERE calendar_id = ? AND enabled = 1'
  ).get(chosen);
  return { warning: alsoSynced ? 'calendar_also_synced' : null };
}

async function getStatus() {
  const auth = getAuthStatus();
  let contactsCalendarAvailable = false;
  if (auth.connected && hasScope(SCOPES.CALENDAR)) {
    contactsCalendarAvailable = await probeContactsCalendar();
  }
  return {
    configured:     auth.configured,
    connected:      auth.connected,
    scopeGranted:   hasScope(SCOPES.CALENDAR),
    needsReconsent: auth.connected && !hasScope(SCOPES.CALENDAR),
    enabled:        isEnabled(),
    calendarId:     cfgGet('google_birthdays_calendar_id') || (contactsCalendarAvailable ? CONTACTS_BIRTHDAY_CALENDAR : null),
    contactsCalendarAvailable,
    lastSync:       cfgGet('google_birthdays_last_sync'),
  };
}

export { sync, setSource, getStatus, CONTACTS_BIRTHDAY_CALENDAR };

export const __test = {
  nameFromSummary, isBirthdayEvent, upsertBirthday, pruneRemoved, setSource,
};
