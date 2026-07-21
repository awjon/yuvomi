/**
 * Modul: Google Drive Sync + Storage-Backend
 * Zweck: Ausgewählte Drive-Ordner als Dokumente spiegeln (Inbound) und Drive
 *        als Upload-Ziel (storage_backend='gdrive') anbieten.
 * Abhängigkeiten: googleapis, server/db.js, server/services/google-auth.js
 *
 * sync_config-Schlüssel (drive-spezifisch):
 *   document_storage_gdrive_enabled          - '1' wenn Uploads nach Drive gehen
 *   document_storage_gdrive_upload_folder_id - Ziel-Ordner-ID für Uploads
 *   document_storage_gdrive_upload_folder_name - Anzeigename des Ziel-Ordners
 *   google_drive_last_sync                   - ISO-8601-Timestamp des letzten Syncs
 */

import { createLogger } from '../logger.js';
const log = createLogger('GoogleDrive');

import { Readable } from 'node:stream';
import { google } from 'googleapis';
import * as db from '../db.js';
import { cfgGet, cfgSet, cfgDel, loadAuthorizedClient, hasScope, getAuthStatus, SCOPES } from './google-auth.js';

// 5-MB-Deckel für das Durchreichen von Drive-Inhalten (wie MAX_READ_BYTES in
// document-storage.js). Größere/native Dateien werden auf external_url umgeleitet.
const MAX_PROXY_BYTES = 5 * 1024 * 1024;
const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps';

/**
 * Fehler, der signalisiert: Datei ist zu groß oder ein natives Google-Format,
 * das nicht (klein genug) exportiert werden kann → Aufrufer nutzt external_url.
 */
export class ExternalOnlyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExternalOnlyError';
    this.storageCode = 'DOCUMENT_STORAGE_EXTERNAL_ONLY';
  }
}

function driveClient() {
  const client = loadAuthorizedClient();
  return google.drive({ version: 'v3', auth: client });
}

// --------------------------------------------------------
// Ordnerauswahl
// --------------------------------------------------------

function enabledFolders() {
  return db.get().prepare(
    'SELECT folder_id, name FROM google_drive_folder_selection WHERE enabled = 1'
  ).all();
}

/** Ein-Ebene-Browsing für den Ordner-Picker in den Einstellungen. */
async function listFolders(parentId = 'root') {
  const drive = driveClient();
  const items = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken,
    });
    const enabledSet = new Set(enabledFolders().map((f) => f.folder_id));
    for (const f of res.data.files || []) {
      items.push({ id: f.id, name: f.name, enabled: enabledSet.has(f.id) });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return items;
}

/**
 * Aktiviert/deaktiviert einen Drive-Ordner. Beim Deaktivieren werden die aus
 * diesem Ordner importierten Dokument-Zeilen entfernt.
 */
function setFolderEnabled(folderId, enabled, meta = {}) {
  if (enabled) {
    db.get().prepare(`
      INSERT INTO google_drive_folder_selection (folder_id, name, enabled)
      VALUES (?, ?, 1)
      ON CONFLICT(folder_id) DO UPDATE SET enabled = 1,
        name = COALESCE(excluded.name, google_drive_folder_selection.name)
    `).run(folderId, meta.name ?? null);
  } else {
    db.get().transaction(() => {
      db.get().prepare(`
        DELETE FROM family_documents
        WHERE storage_backend = 'gdrive'
          AND json_extract(external_meta, '$.folder_id') = ?
      `).run(folderId);
      db.get().prepare(
        'UPDATE google_drive_folder_selection SET enabled = 0, last_sync = NULL WHERE folder_id = ?'
      ).run(folderId);
    })();
  }
}

// --------------------------------------------------------
// Mapping Drive-Datei → family_documents-Zeile
// --------------------------------------------------------

/** Erste vorhandene User-ID als Fallback-Ersteller (analog ICS/CalDAV). */
function firstUserId() {
  const owner = db.get().prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  return owner ? owner.id : null;
}

function fileToRow(file, folder, createdBy) {
  const native = String(file.mimeType || '').startsWith(GOOGLE_NATIVE_PREFIX);
  return {
    name:          file.name || '(unbenannt)',
    original_name: file.name || file.id,
    mime_type:     file.mimeType || 'application/octet-stream',
    file_size:     Number(file.size) || 0, // native Google-Dateien liefern keine size
    storage_key:   file.id,
    external_url:  file.webViewLink || null,
    external_meta: JSON.stringify({
      folder_id:    folder.folder_id,
      folder_name:  folder.name || null,
      modifiedTime: file.modifiedTime || null,
      native,
    }),
    created_by: createdBy,
  };
}

function upsertDriveFile(file, folder, createdBy) {
  const row = fileToRow(file, folder, createdBy);
  const existing = db.get().prepare(
    `SELECT id FROM family_documents WHERE storage_backend = 'gdrive' AND storage_key = ?`
  ).get(file.id);
  if (existing) {
    db.get().prepare(`
      UPDATE family_documents
      SET name = ?, original_name = ?, mime_type = ?, file_size = ?, external_url = ?, external_meta = ?
      WHERE id = ?
    `).run(row.name, row.original_name, row.mime_type, row.file_size, row.external_url, row.external_meta, existing.id);
  } else {
    db.get().prepare(`
      INSERT INTO family_documents
        (name, category, status, visibility, original_name, mime_type, file_size,
         content_data, storage_provider, storage_backend, storage_key, external_url, external_meta, created_by)
      VALUES (?, 'other', 'active', 'family', ?, ?, ?, '', 'external', 'gdrive', ?, ?, ?, ?)
    `).run(row.name, row.original_name, row.mime_type, row.file_size,
           row.storage_key, row.external_url, row.external_meta, row.created_by);
  }
}

// --------------------------------------------------------
// Sync (Inbound: Drive → family_documents)
// --------------------------------------------------------

async function sync() {
  if (!getAuthStatus().connected) return;
  if (!hasScope(SCOPES.DRIVE)) {
    log.warn('Drive scope not granted - reconnect required, sync skipped.');
    return;
  }
  const folders = enabledFolders();
  if (folders.length === 0) return;

  const createdBy = firstUserId();
  if (createdBy == null) {
    log.warn('No users exist yet - drive sync skipped.');
    return;
  }

  const drive = driveClient();

  for (const folder of folders) {
    try {
      const seen = new Set();
      let pageToken;
      do {
        // modifiedTime-Polling: einfachste korrekte Variante bei 15-Min-Takt.
        // (Changes-API wäre eine spätere Optimierung.)
        const res = await drive.files.list({
          q: `'${folder.folder_id}' in parents and trashed = false`,
          fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink)',
          pageSize: 100,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          pageToken,
        });
        for (const file of res.data.files || []) {
          // Unterordner werden nicht als Dokument importiert.
          if (String(file.mimeType) === 'application/vnd.google-apps.folder') continue;
          upsertDriveFile(file, folder, createdBy);
          seen.add(file.id);
        }
        pageToken = res.data.nextPageToken;
      } while (pageToken);

      // Verschwundene Dateien dieses Ordners entfernen.
      pruneFolder(folder.folder_id, seen);
      db.get().prepare(
        `UPDATE google_drive_folder_selection SET last_sync = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE folder_id = ?`
      ).run(folder.folder_id);
    } catch (err) {
      log.error(`Inbound error (folder ${folder.folder_id}):`, err.message);
    }
  }

  cfgSet('google_drive_last_sync', new Date().toISOString());
}

function pruneFolder(folderId, seenIds) {
  const rows = db.get().prepare(`
    SELECT id, storage_key FROM family_documents
    WHERE storage_backend = 'gdrive' AND json_extract(external_meta, '$.folder_id') = ?
  `).all(folderId);
  const del = db.get().prepare('DELETE FROM family_documents WHERE id = ?');
  for (const row of rows) {
    if (!seenIds.has(row.storage_key)) del.run(row.id);
  }
}

// --------------------------------------------------------
// Storage-Backend-Operationen
// --------------------------------------------------------

/** Datei nach Drive hochladen; liefert { id, webViewLink }. */
async function uploadFile({ buffer, name, mime, folderId }) {
  const drive = driveClient();
  const res = await drive.files.create({
    requestBody: { name, parents: folderId ? [folderId] : undefined },
    media: { mimeType: mime, body: Readable.from(buffer) },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });
  return { id: res.data.id, webViewLink: res.data.webViewLink || null };
}

/**
 * Drive-Datei laden. Reguläre Dateien werden bis MAX_PROXY_BYTES durchgereicht;
 * native Google-Dateien werden nach PDF exportiert. Zu große/nicht exportierbare
 * Dateien werfen ExternalOnlyError (Aufrufer nutzt external_url).
 * @returns {Promise<{ buffer: Buffer, mime: string }>}
 */
async function downloadFile(fileId) {
  const drive = driveClient();
  const meta = await drive.files.get({ fileId, fields: 'mimeType, size', supportsAllDrives: true });
  const mimeType = meta.data.mimeType || 'application/octet-stream';

  if (mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) {
    // Native Google-Formate: nach PDF exportieren (Docs/Slides/Sheets als PDF).
    try {
      const res = await drive.files.export(
        { fileId, mimeType: 'application/pdf' },
        { responseType: 'arraybuffer' }
      );
      const buffer = Buffer.from(res.data);
      if (buffer.length > MAX_PROXY_BYTES) throw new ExternalOnlyError('Exported file exceeds the proxy limit.');
      return { buffer, mime: 'application/pdf' };
    } catch (err) {
      if (err instanceof ExternalOnlyError) throw err;
      throw new ExternalOnlyError('Native Google file cannot be exported.');
    }
  }

  const size = Number(meta.data.size) || 0;
  if (size > MAX_PROXY_BYTES) throw new ExternalOnlyError('File exceeds the proxy limit.');

  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  const buffer = Buffer.from(res.data);
  if (buffer.length > MAX_PROXY_BYTES) throw new ExternalOnlyError('File exceeds the proxy limit.');
  return { buffer, mime: mimeType };
}

/** Drive-Datei löschen (404 wird toleriert). */
async function deleteFile(fileId) {
  const drive = driveClient();
  try {
    await drive.files.delete({ fileId, supportsAllDrives: true });
  } catch (err) {
    if (err.code === 404) return;
    throw err;
  }
}

// --------------------------------------------------------
// Upload-Konfiguration + Status
// --------------------------------------------------------

function getUploadConfig() {
  return {
    enabled:      cfgGet('document_storage_gdrive_enabled') === '1',
    folderId:     cfgGet('document_storage_gdrive_upload_folder_id'),
    folderName:   cfgGet('document_storage_gdrive_upload_folder_name'),
  };
}

function setUploadConfig({ enabled, folderId, folderName }) {
  if (enabled) cfgSet('document_storage_gdrive_enabled', '1');
  else cfgDel('document_storage_gdrive_enabled');
  if (folderId != null) cfgSet('document_storage_gdrive_upload_folder_id', folderId);
  else cfgDel('document_storage_gdrive_upload_folder_id');
  if (folderName != null) cfgSet('document_storage_gdrive_upload_folder_name', folderName);
  else cfgDel('document_storage_gdrive_upload_folder_name');
}

function getStatus() {
  const auth = getAuthStatus();
  return {
    configured:     auth.configured,
    connected:      auth.connected,
    scopeGranted:   hasScope(SCOPES.DRIVE),
    needsReconsent: auth.connected && !hasScope(SCOPES.DRIVE),
    enabledFolders: enabledFolders(),
    upload:         getUploadConfig(),
    lastSync:       cfgGet('google_drive_last_sync'),
  };
}

export {
  listFolders, setFolderEnabled, sync,
  uploadFile, downloadFile, deleteFile,
  getUploadConfig, setUploadConfig, getStatus,
};

export const __test = {
  fileToRow, upsertDriveFile, pruneFolder, setFolderEnabled, enabledFolders,
  getUploadConfig, setUploadConfig,
};
