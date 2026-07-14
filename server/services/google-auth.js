/**
 * Modul: Google OAuth (geteilt)
 * Zweck: Zentrale OAuth-2.0-Schicht für alle Google-Integrationen
 *        (Calendar, Tasks, Drive). Ein einziger Consent-Flow fordert alle
 *        Scopes an; ein einziger Satz Tokens wird in sync_config gehalten.
 * Abhängigkeiten: googleapis, server/db.js
 *
 * sync_config-Schlüssel:
 *   google_access_token   - OAuth Access Token
 *   google_refresh_token  - OAuth Refresh Token (langlebig)
 *   google_token_expiry   - Millisekunden-Timestamp bis wann Access Token gültig ist
 *   google_scopes         - Leerzeichen-getrennte Liste der tatsächlich gewährten Scopes
 */

import { createLogger } from '../logger.js';
const log = createLogger('GoogleAuth');

import { google } from 'googleapis';
import crypto from 'node:crypto';
import * as db from '../db.js';

// --------------------------------------------------------
// Scopes
// --------------------------------------------------------

export const SCOPES = {
  CALENDAR: 'https://www.googleapis.com/auth/calendar',
  TASKS:    'https://www.googleapis.com/auth/tasks',
  DRIVE:    'https://www.googleapis.com/auth/drive',
};

export const ALL_SCOPES = Object.values(SCOPES);

// --------------------------------------------------------
// OAuth2-Client (lazy initialisiert)
// --------------------------------------------------------

function createClient() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('[Google] GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be set.');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// --------------------------------------------------------
// sync_config Helfer
// --------------------------------------------------------

function cfgGet(key) {
  const row = db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function cfgSet(key, value) {
  db.get().prepare(`
    INSERT INTO sync_config (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `).run(key, value);
}

function cfgDel(key) {
  db.get().prepare('DELETE FROM sync_config WHERE key = ?').run(key);
}

// --------------------------------------------------------
// Scope-Status
// --------------------------------------------------------

/**
 * Tatsächlich gewährte Scopes.
 *
 * Rückwärtskompatibilität: Installationen, die sich vor Einführung der
 * kombinierten Scopes verbunden haben, besitzen Tokens, aber keinen
 * google_scopes-Eintrag. Solche Verbindungen werden als reine Calendar-
 * Freigabe behandelt, damit Kalender-Sync ohne erneuten Consent weiterläuft.
 * @returns {string[]}
 */
function getGrantedScopes() {
  const raw = cfgGet('google_scopes');
  if (raw) return raw.split(/\s+/).filter(Boolean);
  // Kein Eintrag, aber verbunden → Alt-Installation mit Calendar-only-Token.
  const connected = !!(cfgGet('google_access_token') && cfgGet('google_refresh_token'));
  return connected ? [SCOPES.CALENDAR] : [];
}

function hasScope(scope) {
  return getGrantedScopes().includes(scope);
}

// --------------------------------------------------------
// Client mit gespeicherten Tokens laden
// --------------------------------------------------------

function loadAuthorizedClient() {
  const accessToken  = cfgGet('google_access_token');
  const refreshToken = cfgGet('google_refresh_token');

  if (!accessToken || !refreshToken) {
    throw new Error('[Google] Not configured - complete OAuth first.');
  }

  const client = createClient();
  client.setCredentials({
    access_token:  accessToken,
    refresh_token: refreshToken,
    expiry_date:   cfgGet('google_token_expiry') ? parseInt(cfgGet('google_token_expiry'), 10) : undefined,
  });

  // Token-Refresh automatisch speichern
  client.on('tokens', (tokens) => {
    if (tokens.access_token) cfgSet('google_access_token', tokens.access_token);
    if (tokens.expiry_date)  cfgSet('google_token_expiry', String(tokens.expiry_date));
    if (tokens.scope)        cfgSet('google_scopes', tokens.scope);
  });

  return client;
}

// --------------------------------------------------------
// OAuth-Flow
// --------------------------------------------------------

/**
 * Generiert die Google OAuth2-URL zum Weiterleiten des Admins.
 * Fordert alle Suite-Scopes in einem einzigen Consent an und enthält einen
 * CSRF-sicheren state-Parameter.
 * @param {object} session - Express-Session-Objekt (state wird dort gespeichert)
 * @returns {string} Auth-URL
 */
function getAuthUrl(session) {
  const client = createClient();
  const state = crypto.randomBytes(32).toString('hex');
  if (session) session.googleOAuthState = state;
  return client.generateAuthUrl({
    access_type:            'offline',
    prompt:                 'consent',
    include_granted_scopes: true,
    scope:                  ALL_SCOPES,
    state,
  });
}

/**
 * OAuth-Callback: tauscht Code gegen Tokens, speichert in sync_config.
 * @param {string} code - Code aus dem OAuth-Callback-Query-Parameter
 */
async function handleCallback(code) {
  const client = createClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error('[Google] No refresh token received. Revoke access in your Google account and connect again.');
  }

  cfgSet('google_access_token',  tokens.access_token);
  cfgSet('google_refresh_token', tokens.refresh_token);
  if (tokens.expiry_date) cfgSet('google_token_expiry', String(tokens.expiry_date));
  // Google liefert die tatsächlich gewährten Scopes leerzeichen-getrennt zurück.
  cfgSet('google_scopes', tokens.scope || ALL_SCOPES.join(' '));

  log.info('OAuth successful - tokens saved.');
}

// --------------------------------------------------------
// Status / Trennung
// --------------------------------------------------------

/**
 * Auth-Status über alle Google-Integrationen hinweg.
 * @returns {{ configured: boolean, connected: boolean, grantedScopes: string[], missingScopes: string[] }}
 */
function getAuthStatus() {
  const configured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
  const connected  = !!(cfgGet('google_access_token') && cfgGet('google_refresh_token'));
  const grantedScopes = getGrantedScopes();
  const missingScopes = connected ? ALL_SCOPES.filter((s) => !grantedScopes.includes(s)) : [];
  return { configured, connected, grantedScopes, missingScopes };
}

/**
 * Löscht die geteilten OAuth-Tokens (Verbindung vollständig trennen).
 * Feature-spezifische Aufräumarbeiten (Kalenderauswahl, Task-Listen, …)
 * bleiben Sache der jeweiligen Feature-Services.
 */
function disconnectAuth() {
  ['google_access_token', 'google_refresh_token', 'google_token_expiry', 'google_scopes'].forEach(cfgDel);
  log.info('Shared Google tokens cleared.');
}

export {
  createClient,
  cfgGet, cfgSet, cfgDel,
  loadAuthorizedClient,
  getAuthUrl, handleCallback,
  getGrantedScopes, hasScope,
  getAuthStatus, disconnectAuth,
};

export const __test = {
  getGrantedScopes, hasScope, getAuthStatus, disconnectAuth,
  cfgGet, cfgSet, cfgDel, getAuthUrl,
};
