/**
 * Modul: Safe Fetch (SSRF-Schutz)
 * Zweck: Wiederverwendbare SSRF-Absicherung für ausgehende Requests auf
 *        benutzerkontrollierte URLs (ICS-Abonnements, Rezept-Import).
 *        Blockiert private/lokale Ziele, verhindert DNS-Rebinding über einen
 *        lookup-validierenden Agent und deckelt Antwortgröße/-zeit.
 * Abhängigkeiten: node-fetch, node:dns, node:net, node:http(s)
 */

import dns from 'node:dns/promises';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fetch from 'node-fetch';

const PRIVATE_RANGES = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^::1$/, /^::$/, /^f[cd]/i, /^fe[89ab]/i,
];

/**
 * Prüft eine rohe IP-Adresse gegen die privaten/lokalen Bereiche. Berücksichtigt
 * IPv4-mapped-IPv6 (`::ffff:a.b.c.d`), damit ein Angreifer eine private IPv4 nicht
 * über die IPv6-Schreibweise am Filter vorbeischmuggeln kann.
 */
export function ipIsPrivate(addr) {
  let a = addr;
  // IPv4-mapped IPv6 in dezimaler Schreibweise: ::ffff:192.168.0.1
  const dec = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(a);
  if (dec) a = dec[1];
  // ... und in Hex-Schreibweise (so normalisiert die URL/DNS sie): ::ffff:c0a8:1
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(a);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    a = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return PRIVATE_RANGES.some((re) => re.test(a));
}

/**
 * Normalisiert und validiert eine URL.
 * @param {string} raw
 * @param {{ allowPrivate?: boolean, allowWebcal?: boolean, upgradeInsecure?: boolean }} [opts]
 *   allowPrivate    - erlaubt zusätzlich http:// (für kontrollierte LAN-Ziele)
 *   allowWebcal     - webcal:// wird zu https:// umgeschrieben
 *   upgradeInsecure - http:// wird zu https:// hochgestuft (https-only-Aufrufer)
 * @returns {string} href
 */
export function normalizeUrl(raw, { allowPrivate = false, allowWebcal = false, upgradeInsecure = false } = {}) {
  let input = String(raw).trim();
  if (allowWebcal) input = input.replace(/^webcal:\/\//i, 'https://');
  const url = new URL(input);
  if (upgradeInsecure && url.protocol === 'http:') url.protocol = 'https:';
  const allowed = allowPrivate ? ['https:', 'http:'] : ['https:'];
  if (!allowed.includes(url.protocol)) {
    throw new Error(allowPrivate
      ? 'Only http:// and https:// URLs are allowed.'
      : 'Only https:// URLs are allowed.');
  }
  return url.href;
}

/**
 * Löst den Host auf und wirft, wenn eine Zieladresse privat/lokal ist.
 * @param {string} urlStr
 * @param {{ allowPrivate?: boolean }} [opts]
 */
export async function checkSSRF(urlStr, { allowPrivate = false } = {}) {
  if (allowPrivate) return;
  const hostname = new URL(urlStr).hostname;
  // URL.hostname liefert IPv6 in Klammern ([::1]) – für isIP/Filter entfernen.
  const host = hostname.replace(/^\[|\]$/g, '');
  // Literale IPs werden von dns.resolve4/6 nicht aufgelöst (liefert []), müssen
  // also direkt geprüft werden – sonst schlüpft https://192.168.0.1/ durch.
  if (isIP(host)) {
    if (ipIsPrivate(host)) throw new Error(`URL resolves to a private IP address: ${host}`);
    return;
  }
  const v4 = await dns.resolve4(hostname).catch(() => []);
  const v6 = await dns.resolve6(hostname).catch(() => []);
  for (const addr of [...v4, ...v6]) {
    if (ipIsPrivate(addr)) {
      throw new Error(`URL resolves to a private IP address: ${addr}`);
    }
  }
}

/**
 * DNS-Lookup-Wrapper für den fetch-Agent: validiert JEDE aufgelöste Adresse zum
 * Zeitpunkt des Verbindungsaufbaus. Damit ist DNS-Rebinding ausgeschlossen – ein
 * Angreifer-DNS kann `checkSSRF` nicht mehr mit einer öffentlichen IP täuschen und
 * beim eigentlichen fetch auf eine private IP umschwenken, weil hier die Adresse
 * geprüft wird, mit der die Socket-Verbindung wirklich aufgebaut wird.
 */
export function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const opts = typeof options === 'number' ? { family: options } : (options || {});
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    for (const entry of addresses) {
      if (ipIsPrivate(entry.address)) {
        return callback(new Error(`URL resolves to a private IP address: ${entry.address}`));
      }
    }
    if (opts.all) return callback(null, addresses);
    const [first] = addresses;
    return callback(null, first.address, first.family);
  });
}

/**
 * Agent-Fabrik für node-fetch: erzwingt die Rebinding-sichere IP-Validierung über
 * guardedLookup. Literale IPs umgehen den Socket-Lookup (Node verbindet direkt),
 * werden aber bereits von checkSSRF abgefangen.
 */
export function ssrfSafeAgent(parsedUrl) {
  const Agent = parsedUrl.protocol === 'https:' ? https.Agent : http.Agent;
  return new Agent({ lookup: guardedLookup });
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * SSRF-sicherer GET, der den Antworttext liefert. Normalisiert die URL
 * (https-only sofern nicht allowPrivate), prüft SSRF, deckelt Zeit und Größe.
 * @param {string} url
 * @param {{ maxBytes?: number, timeoutMs?: number, headers?: object, allowPrivate?: boolean }} [opts]
 * @returns {Promise<string>} Antwort-Body als Text
 */
export async function fetchTextSafely(url, {
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  headers = {},
  allowPrivate = false,
} = {}) {
  const normalized = normalizeUrl(url, { allowPrivate, upgradeInsecure: !allowPrivate });
  await checkSSRF(normalized, { allowPrivate });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchOpts = { headers, signal: controller.signal, redirect: 'follow' };
  if (!allowPrivate) fetchOpts.agent = ssrfSafeAgent;

  let res;
  try {
    res = await fetch(normalized, fetchOpts);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const declared = parseInt(res.headers.get('content-length') || '0', 10);
  if (declared > maxBytes) throw new Error('Response exceeds the size limit.');

  let body = '';
  let received = 0;
  for await (const chunk of res.body) {
    received += chunk.length;
    if (received > maxBytes) throw new Error('Response exceeds the size limit.');
    body += chunk.toString();
  }
  return body;
}
