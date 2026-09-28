/**
 * Analyse et rédaction d'URL, sans dépendance et sans l'API WHATWG `URL`
 * (absente du contexte global de Node 8.12 hors `require('url')`, et inutile ici).
 *
 * Deux usages :
 *  - `parseUrl()` : schéma, hôte, port, chemin, requête, userinfo — jamais l'URL complète ;
 *  - `redactUrl()` : forme journalisable/diagnostic, **sans identifiant** (§8.2).
 */

export interface ParsedUrl {
  scheme: string;
  /** hôte en minuscules, sans crochets IPv6 */
  host: string;
  /** true si l'hôte était une adresse IPv6 littérale (entre crochets) */
  hostIsIpv6Literal: boolean;
  /** port explicite, sinon undefined */
  port?: number;
  /** chemin, sans la requête */
  path: string;
  /** requête brute, sans le `?` */
  query: string;
  /** true si une partie `user:pass@` est présente */
  hasUserInfo: boolean;
  raw: string;
}

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

/** Extrait la forme normalisée d'une URL, ou renvoie null si elle n'est pas analysable. */
export function parseUrl(raw: string): ParsedUrl | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  const schemeMatch = SCHEME_RE.exec(value);
  if (!schemeMatch) return null;
  const scheme = schemeMatch[1].toLowerCase();
  let rest = value.slice(schemeMatch[0].length);
  // l'autorité s'arrête au premier /, ? ou #
  let authorityEnd = rest.length;
  for (const sep of ['/', '?', '#']) {
    const idx = rest.indexOf(sep);
    if (idx !== -1 && idx < authorityEnd) authorityEnd = idx;
  }
  const authority = rest.slice(0, authorityEnd);
  rest = rest.slice(authorityEnd);
  const hashIdx = rest.indexOf('#');
  if (hashIdx !== -1) rest = rest.slice(0, hashIdx);
  const queryIdx = rest.indexOf('?');
  const path = queryIdx === -1 ? rest : rest.slice(0, queryIdx);
  const query = queryIdx === -1 ? '' : rest.slice(queryIdx + 1);

  let hostPort = authority;
  let hasUserInfo = false;
  const atIdx = authority.lastIndexOf('@');
  if (atIdx !== -1) {
    hostPort = authority.slice(atIdx + 1);
    hasUserInfo = true;
  }

  let host = hostPort;
  let port: number | undefined;
  let hostIsIpv6Literal = false;
  if (hostPort.charAt(0) === '[') {
    const close = hostPort.indexOf(']');
    if (close === -1) return null;
    host = hostPort.slice(1, close).toLowerCase();
    hostIsIpv6Literal = true;
    const portPart = hostPort.slice(close + 1);
    if (portPart.charAt(0) === ':') port = toPort(portPart.slice(1));
  } else {
    const colon = hostPort.indexOf(':');
    if (colon !== -1) {
      host = hostPort.slice(0, colon);
      port = toPort(hostPort.slice(colon + 1));
    }
    host = host.toLowerCase();
  }
  if (host === '') return null;
  const parsed: ParsedUrl = {
    scheme,
    host,
    hostIsIpv6Literal,
    path: path === '' ? '/' : path,
    query,
    hasUserInfo,
    raw: value
  };
  if (port !== undefined) parsed.port = port;
  return parsed;
}

function toPort(value: string): number | undefined {
  if (!/^\d{1,5}$/.test(value)) return undefined;
  const port = parseInt(value, 10);
  if (port < 1 || port > 65535) return undefined;
  return port;
}

/**
 * Forme journalisable : `https://hôte:port/chemin?[redacted]`.
 * Aucun identifiant, aucun segment de chemin susceptible d'en porter, requête masquée.
 */
export function redactUrl(raw: string): string {
  const parsed = parseUrl(raw);
  if (!parsed) return '[url-invalide]';
  const port = parsed.port === undefined ? '' : ':' + parsed.port;
  const path = parsed.path === '/' ? '/' : '/[chemin]';
  const query = parsed.query === '' ? '' : '?[redacted]';
  return parsed.scheme + '://' + parsed.host + port + path + query;
}

/** Hôte de l'URL, ou null si l'URL n'est pas analysable. */
export function hostOf(raw: string): string | null {
  const parsed = parseUrl(raw);
  return parsed ? parsed.host : null;
}

export interface CredentialAnalysis {
  hasCredential: boolean;
  /** raisons, sans contenu sensible (journalisable en diagnostic) */
  reasons: string[];
  /** préfixe porteur d'identifiants, présenté sous forme rédigée */
  credentialPrefix?: string;
  /** segment de chemin terminal considéré comme identifiant de flux */
  streamSegment?: string;
}

/** Seuil par défaut du segment « porteur d'identifiant » — ouvert au §15.6, calibré en 0C/0D. */
export const DEFAULT_CREDENTIAL_SEGMENT_MIN_LENGTH = 24;

const QUERY_KEY_RE = /(^|&)(username|user|password|pass|token|token2|api_?key|auth|key)=/i;

/**
 * Classification `hasCredential` d'une URL de lecture (§5.2), décidée **par analyse**.
 * Une URL de CDN publique ne doit pas être classée secrète (test d'acceptation §15.6).
 */
export function analyzeCredential(
  raw: string,
  minSegmentLength: number = DEFAULT_CREDENTIAL_SEGMENT_MIN_LENGTH
): CredentialAnalysis {
  const reasons: string[] = [];
  const parsed = parseUrl(raw);
  if (!parsed) return { hasCredential: false, reasons: ['non analysee'] };
  if (parsed.hasUserInfo) reasons.push('userinfo');
  if (QUERY_KEY_RE.test('?' + parsed.query)) reasons.push('requete-nommee');
  const segments = parsed.path.split('/').filter((segment) => segment !== '');
  let lastCredentialSegment = -1;
  for (let i = 0; i < segments.length; i++) {
    const segment = decodeURIComponentSafe(segments[i]);
    if (segment.length >= minSegmentLength && /^[A-Za-z0-9+/_=-]+$/.test(segment)) {
      if (reasons.indexOf('segment-long') === -1) reasons.push('segment-long');
      lastCredentialSegment = i;
    }
  }
  if (reasons.length > 0) {
    const analysis: CredentialAnalysis = { hasCredential: true, reasons };
    const authority = parsed.scheme + '://' + parsed.host + (parsed.port ? ':' + parsed.port : '') + '/';
    // Partie non secrète conservée par l'index en mode `derived` : le segment de flux et l'extension.
    // La partie secrète (`user/pass`, segment long) est fournie en session à la lecture (§5.2).
    const credentialSegments = lastCredentialSegment >= 0 ? segments.slice(0, lastCredentialSegment + 1) : [];
    const streamSegments = lastCredentialSegment >= 0 ? segments.slice(lastCredentialSegment + 1) : segments;
    if (credentialSegments.length > 0) analysis.credentialPrefix = authority + credentialSegments.join('/') + '/';
    if (streamSegments.length > 0) analysis.streamSegment = streamSegments.join('/');
    return analysis;
  }
  return { hasCredential: false, reasons: [] };
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (_err) {
    return value;
  }
}

/** Détecte un préfixe d'identifiants commun à toutes les URL (optimisation §5.2). */
export function commonCredentialPrefix(urls: string[]): string | null {
  if (urls.length === 0) return null;
  let prefix: string | null = null;
  for (const url of urls) {
    const analysis = analyzeCredential(url);
    if (!analysis.hasCredential || !analysis.credentialPrefix) return null;
    if (prefix === null) prefix = analysis.credentialPrefix;
    else if (prefix !== analysis.credentialPrefix) return null;
  }
  return prefix;
}
