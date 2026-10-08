/**
 * Client HTTP du service (§2.5) : le **seul** chemin réseau sortant de l'application côté service.
 *
 * Contrat :
 *  - redirections bornées (5), schéma/hôte/port revalidés à chaque saut, en-têtes sensibles jamais
 *    transmis à un autre origin ;
 *  - DNS résolu et **épinglé** par le service via le callback `lookup` ; une adresse privée,
 *    loopback, link-local, multicast ou CGNAT est refusée par défaut ;
 *  - magasin de racines publiques embarqué transmis par l'option `ca` ; `rejectUnauthorized` reste
 *    à sa valeur par défaut (jamais désactivé, jamais de CA privée ajoutée en silence) ;
 *  - décompression gzip/deflate locale (Node 8.12 dispose de zlib, pas de Brotli) ;
 *  - corps consommé **au fil de l'eau** avec pause/reprise : la mémoire reste bornée même pour une
 *    réponse de plusieurs centaines de mégaoctets ;
 *  - aucune URL complète, aucun identifiant, aucun cookie dans les journaux : seule la forme
 *    rédigée (`scheme://hôte/…`) est exposée.
 */

import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import { AppError, type ErrorCode } from '../../contracts/errors';
import { redactUrl, type ParsedUrl } from '../../core/urltools';
import { caOptionFor } from './rootsBundle';
import {
  evaluateHop,
  headersForHop,
  originOf,
  pinnedLookup,
  resolveAndValidate,
  MAX_REDIRECTS,
  type DnsAddress,
  type LookupFn,
  type PinnedLookup,
  type PolicyContext
} from './policy';

/* --------------------------------------------------------------- abstractions */

export interface TransportRequestLike {
  on(event: string, listener: (...args: never[]) => void): unknown;
  write?(chunk: Buffer | string): void;
  end(): void;
  setTimeout?(ms: number, callback: () => void): unknown;
  destroy(error?: Error | null): void;
}

export interface TransportResponseLike {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  pause?: () => void;
  resume?: () => void;
  destroy?: (error?: Error | null) => void;
  socket?: unknown;
  connection?: unknown;
}

export interface TransportOptions {
  protocol: 'http:' | 'https:';
  hostname: string;
  port?: number;
  path: string;
  method: string;
  headers: Record<string, string>;
  /** Signature de `net` : la forme de réponse dépend du Node appelant (voir `pinnedLookup`). */
  lookup?: PinnedLookup;
  ca?: string;
  agent?: unknown;
}

export interface Transport {
  request(options: TransportOptions, callback: (response: TransportResponseLike) => void): TransportRequestLike;
}

/** Transport par défaut : `http`/`https` de Node 8.12, sans option exotique. */
export const nodeTransport: Transport = {
  request(options, callback) {
    const module = options.protocol === 'https:' ? https : http;
    const requestOptions: https.RequestOptions = {
      protocol: options.protocol,
      hostname: options.hostname,
      port: options.port,
      path: options.path,
      method: options.method,
      headers: options.headers
    };
    if (options.lookup) {
      // `lookup` existe côté net.Socket mais manque dans les types de @types/node 8.10
      (requestOptions as unknown as Record<string, unknown>).lookup = options.lookup;
    }
    if (options.ca) requestOptions.ca = options.ca;
    if (options.agent !== undefined) requestOptions.agent = options.agent as https.RequestOptions['agent'];
    return module.request(requestOptions, callback as (res: http.IncomingMessage) => void) as unknown as TransportRequestLike;
  }
};

/* ------------------------------------------------------------------ options */

export interface HttpRequestOptions extends PolicyContext {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** délai maximal pour établir la connexion */
  connectTimeoutMs?: number;
  /** délai maximal entre deux paquets (connexion considérée morte au-delà) */
  idleTimeoutMs?: number;
  /** plafond de la charge utile **décompressée** acceptée */
  maxBytes?: number;
  /** plafond de la charge utile **compressée** reçue */
  maxWireBytes?: number;
  /** surcharge de l'en-tête `User-Agent` (certains portails et proxys CDN filtrent dessus) */
  userAgent?: string;
  /** décompression gzip/deflate */
  decompress?: boolean;
  /** consomme le flux au fil de l'eau (sinon la réponse est accumulée dans `text`) */
  onData?: (chunk: Buffer) => void;
  /** reprise d'un téléchargement : octets déjà obtenus */
  rangeFrom?: number;
  /** hôte déjà accepté en HTTP clair (avertissement mémorisé) */
  acceptedHosts?: string[];
  /**
   * Interruption coopérative : appelée avant chaque morceau. Utilisée par l'annulation d'import
   * (§15.5) et par la fermeture de l'application. L'annulation est propre : la requête est
   * détruite et l'appelant reçoit `internal/cancelled`, jamais une exception non capturée.
   */
  shouldAbort?: () => boolean;
}

export interface TlsObservation {
  protocol: string | null;
  cipher: string | null;
  authorized: boolean | null;
  subject?: string;
  issuer?: string;
  validTo?: string;
}

export interface HttpResponseMeta {
  status: number;
  headers: Record<string, string | undefined>;
  bytes: number;
  wireBytes: number;
  redirects: number;
  /** forme rédigée de l'URL finale (jamais l'URL complète) */
  finalUrlRedacted: string;
  /** corps accumulé uniquement si `onData` n'est pas fourni */
  text?: string;
  tls?: TlsObservation;
  warnings: string[];
  /** vrai si le serveur annonce la prise en charge des requêtes partielles (§2.4) */
  acceptsRanges: boolean;
  etag?: string;
  lastModified?: string;
}

export interface HttpClientDeps {
  transport?: Transport;
  lookup?: LookupFn;
  /** charge le bundle de racines publiques embarqué ; `false` pour s'en passer (tests) */
  caProvider?: () => string | undefined;
  now?: () => number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 8000;
const DEFAULT_IDLE_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_WIRE_BYTES = 32 * 1024 * 1024;

export class HttpClient {
  private readonly transport: Transport;
  private readonly lookup: LookupFn;
  private readonly caProvider: () => string | undefined;
  /** Dernière observation TLS par hôte : alimente le diagnostic local (§10). */
  readonly tlsByHost: Record<string, TlsObservation> = {};

  constructor(deps: HttpClientDeps = {}) {
    this.transport = deps.transport || nodeTransport;
    this.lookup = deps.lookup || defaultLookup;
    this.caProvider =
      deps.caProvider === undefined
        ? () => {
            try {
              return caOptionFor();
            } catch (_err) {
              return undefined;
            }
          }
        : deps.caProvider;
  }

  get(url: string, options: HttpRequestOptions = {}): Promise<HttpResponseMeta> {
    return this.request(url, Object.assign({}, options, { method: 'GET' as const }));
  }

  /** Exécute une requête, suit les redirections et applique la politique à chaque saut. */
  request(url: string, options: HttpRequestOptions): Promise<HttpResponseMeta> {
    return this.perform(url, options, 0, [], undefined);
  }

  private async perform(
    url: string,
    options: HttpRequestOptions,
    redirectCount: number,
    warnings: string[],
    previousScheme: string | undefined
  ): Promise<HttpResponseMeta> {
    const policyContext: PolicyContext = {
      lanAllowed: Boolean(options.lanAllowed),
      insecureHttpAccepted: this.isHostAccepted(url, options)
    };
    const decision = evaluateHop(url, policyContext, previousScheme);
    decision.warnings.forEach((warning) => {
      if (warnings.indexOf(warning) === -1) warnings.push(warning);
    });
    const parsed = decision.parsed;
    if (parsed.scheme === 'http') {
      // Avertissement obligatoire avant la première requête claire vers cet hôte (§8.2).
      if (!policyContext.insecureHttpAccepted) {
        throw new AppError(
          'security/insecureScheme',
          'source en HTTP clair : avertissement a confirmer pour ce profil et cet hote',
          'hote:' + parsed.host
        );
      }
    }
    const resolved: DnsAddress = await resolveAndValidate(parsed.host, this.lookup, policyContext);
    const response = await this.sendOnce(parsed, resolved, options);

    const status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      if (!location) {
        throw new AppError('network/http', 'redirection sans en-tete Location');
      }
      if (redirectCount >= MAX_REDIRECTS) {
        throw new AppError('network/tooManyRedirects', 'nombre maximal de redirections depasse');
      }
      const nextUrl = absolutize(location, parsed);
      const fromOrigin = originOf(parsed);
      const nextDecision = evaluateHop(nextUrl, policyContext, parsed.scheme);
      const nextHeaders = headersForHop(options.headers || {}, fromOrigin, originOf(nextDecision.parsed));
      warnings.push('redirection ' + redirectCount + ' vers ' + redactUrl(nextUrl));
      const nextOptions: HttpRequestOptions = Object.assign({}, options, {
        headers: nextHeaders,
        // une redirection vers un autre origin supprime les en-têtes sensibles du contexte
        acceptedHosts: options.acceptedHosts
      });
      return this.perform(nextUrl, nextOptions, redirectCount + 1, warnings, parsed.scheme);
    }

    return {
      status: response.status,
      headers: response.headers,
      bytes: response.bytes,
      wireBytes: response.wireBytes,
      redirects: redirectCount,
      finalUrlRedacted: redactUrl(url),
      tls: response.tls,
      warnings,
      acceptsRanges: /bytes/i.test(String(response.headers['accept-ranges'] || '')) || response.status === 206,
      etag: response.headers.etag,
      lastModified: response.headers['last-modified'],
      text: response.text
    };
  }

  private isHostAccepted(url: string, options: HttpRequestOptions): boolean {
    if (options.insecureHttpAccepted) return true;
    const host = tryHost(url);
    if (!host) return false;
    const list = options.acceptedHosts || [];
    return list.indexOf(host) !== -1;
  }

  private async sendOnce(
    parsed: ParsedUrl,
    resolved: DnsAddress,
    options: HttpRequestOptions
  ): Promise<{
    status: number;
    headers: Record<string, string | undefined>;
    bytes: number;
    wireBytes: number;
    text?: string;
    tls?: TlsObservation;
  }> {
    const headers: Record<string, string> = {};
    const requested = options.headers || {};
    Object.keys(requested).forEach((name) => {
      headers[name] = requested[name];
    });
    if (!hasHeader(headers, 'accept')) headers['Accept'] = 'application/json, text/plain, */*';
    // Identification du client : des portails (et des proxys CDN) refusent ou coupent toute requête
    // sans `User-Agent` — constaté sur un portail réel en phase 0C. Surchargeable par profil.
    if (!hasHeader(headers, 'user-agent')) headers['User-Agent'] = options.userAgent || DEFAULT_USER_AGENT;
    if (!hasHeader(headers, 'accept-encoding')) headers['Accept-Encoding'] = options.decompress === false ? 'identity' : 'gzip, deflate';
    if (options.rangeFrom !== undefined && options.rangeFrom > 0) {
      headers['Range'] = 'bytes=' + options.rangeFrom + '-';
    }

    const transportOptions: TransportOptions = {
      protocol: parsed.scheme === 'https' ? 'https:' : 'http:',
      hostname: parsed.host,
      port: parsed.port,
      path: parsed.path + (parsed.query === '' ? '' : '?' + parsed.query),
      method: options.method || 'GET',
      headers,
      lookup: pinnedLookup(resolved, this.lookup)
    };
    if (parsed.scheme === 'https') {
      const ca = this.caProvider();
      if (ca) transportOptions.ca = ca;
    }

    const connectTimeoutMs = options.connectTimeoutMs === undefined ? DEFAULT_CONNECT_TIMEOUT_MS : options.connectTimeoutMs;
    const idleTimeoutMs = options.idleTimeoutMs === undefined ? DEFAULT_IDLE_TIMEOUT_MS : options.idleTimeoutMs;
    const maxBytes = options.maxBytes === undefined ? DEFAULT_MAX_BYTES : options.maxBytes;
    const maxWireBytes = options.maxWireBytes === undefined ? DEFAULT_MAX_WIRE_BYTES : options.maxWireBytes;

    return new Promise((resolve, reject) => {
      let settled = false;
      let request: TransportRequestLike | null = null;
      let idleTimer: NodeJS.Timer | null = null;
      let connectTimer: NodeJS.Timer | null = null;

      const cleanup = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        if (connectTimer) clearTimeout(connectTimer);
        idleTimer = null;
        connectTimer = null;
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (request) request.destroy();
        reject(error);
      };
      const succeed = (value: {
        status: number;
        headers: Record<string, string | undefined>;
        bytes: number;
        wireBytes: number;
        text?: string;
        tls?: TlsObservation;
      }): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const bumpIdle = (): void => {
        if (settled) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          fail(new AppError('network/timeout', 'flux interrompu : aucune donnee recue dans le delai imparti'));
        }, idleTimeoutMs);
      };

      connectTimer = setTimeout(() => {
        fail(new AppError('network/timeout', 'delai de connexion depasse'));
      }, connectTimeoutMs);

      try {
        request = this.transport.request(transportOptions, (response) => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
          const status = response.statusCode === undefined ? 0 : response.statusCode;
          const headerMap = normalizeHeaders(response.headers);
          const tls = parsed.scheme === 'https' ? observeTls(response) : undefined;
          if (tls) this.tlsByHost[parsed.host] = tls;
          let bytes = 0;
          let wireBytes = 0;
          let finished = false;
          const chunks: Buffer[] = [];

          /**
           * Clôt la requête. Quand un décompresseur est actif, il faut attendre son événement
           * `end` : `zlib` décompresse de façon asynchrone, donc conclure dès la fin du flux réseau
           * rendrait une charge utile **vide** (défaut constaté en 0C sur un portail réel qui répond
           * en gzip).
           */
          const finalize = (): void => {
            if (finished) return;
            finished = true;
            succeed({
              status,
              headers: headerMap,
              bytes,
              wireBytes,
              text: options.onData ? undefined : Buffer.concat(chunks).toString('utf8'),
              tls
            });
          };

          const decompressor = options.decompress === false ? null : createDecompressor(headerMap['content-encoding'], fail);
          if (decompressor) {
            decompressor.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > maxBytes) {
                fail(new AppError('network/http', 'reponse au-dela du plafond de charge utile autorise'));
                return;
              }
              deliver(chunk);
            });
            decompressor.on('error', () => fail(new AppError('provider/badResponse', 'decompression impossible de la reponse')));
          }

          const deliver = (chunk: Buffer): void => {
            if (options.onData) {
              const response2 = response;
              if (response2.pause) response2.pause();
              try {
                options.onData(chunk);
              } finally {
                if (response2.resume) response2.resume();
              }
            } else {
              chunks.push(chunk);
            }
          };

          const onChunk = (chunk: Buffer): void => {
            if (options.shouldAbort && options.shouldAbort()) {
              fail(new AppError('internal/cancelled', 'operation annulee'));
              return;
            }
            bumpIdle();
            wireBytes += chunk.length;
            if (wireBytes > maxWireBytes) {
              fail(new AppError('network/http', 'flux compresse au-dela du plafond autorise'));
              return;
            }
            if (decompressor) decompressor.write(chunk);
            else {
              bytes += chunk.length;
              if (bytes > maxBytes) {
                fail(new AppError('network/http', 'reponse au-dela du plafond de charge utile autorise'));
                return;
              }
              deliver(chunk);
            }
          };

          response.on('data', onChunk as never);
          response.on('end', () => {
            if (finished) return;
            if (decompressor) {
              // le contenu décodé arrive après `end()` : on attend que `zlib` ait tout rendu
              decompressor.on('end', finalize);
              decompressor.end();
              return;
            }
            finalize();
          });
          response.on('error', () => {
            fail(new AppError('network/refused', 'connexion interrompue par le serveur'));
          });
          bumpIdle();
        });

        request.on('error', (error: Error) => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
            fail(new AppError('network/dns', 'resolution DNS impossible'));
            return;
          }
          if (code === 'ECONNREFUSED') {
            fail(new AppError('network/refused', 'connexion refusee par le serveur'));
            return;
          }
          if (isTlsError(code)) {
            fail(new AppError('network/tls', 'echec de la validation TLS (certificat ou chaine non valide)'));
            return;
          }
          // Le code d'erreur d'origine est conservé dans le message : sans lui, un défaut de
          // transport se confond avec un refus du portail (aucune URL ni secret n'y figure).
          fail(new AppError('network/refused', 'connexion impossible vers cet hote' + (code ? ' (' + code + ')' : '')));
        });

        if (options.body !== undefined && request.write) {
          request.write(options.body);
        }
        request.end();
      } catch (error) {
        fail(asAppError(error));
      }
    });
  }
}

/* ----------------------------------------------------------------- outils */

function defaultLookup(
  hostname: string,
  options: unknown,
  callback: (err: Error | null, address: string, family: number) => void
): void {
  // `require` local : le module dns n'est chargé que si un appel réseau est réellement demandé.
  const dns = require('dns') as {
    lookup: (host: string, opts: unknown, cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) => void;
  };
  dns.lookup(hostname, options, callback);
}

function normalizeHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  Object.keys(raw).forEach((name) => {
    const value = raw[name];
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  });
  return out;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function createDecompressor(
  encoding: string | undefined,
  onError: (error: Error) => void
): zlib.Gunzip | zlib.Inflate | null {
  const value = (encoding || '').toLowerCase();
  if (value === '' || value === 'identity') return null;
  if (value === 'gzip' || value === 'x-gzip') return zlib.createGunzip();
  if (value === 'deflate') return zlib.createInflate();
  onError(new AppError('provider/badResponse', 'encodage de reponse non supporte par le service'));
  return null;
}

function observeTls(response: TransportResponseLike): TlsObservation | undefined {
  const socket = (response.socket || response.connection) as
    | {
        authorized?: boolean;
        getProtocol?: () => string;
        getCipher?: () => { name?: string };
        getPeerCertificate?: () => { subject?: { CN?: string }; issuer?: { CN?: string }; valid_to?: string };
      }
    | undefined;
  if (!socket || typeof socket.getPeerCertificate !== 'function') return undefined;
  const certificate = socket.getPeerCertificate() || {};
  const observation: TlsObservation = {
    protocol: typeof socket.getProtocol === 'function' ? socket.getProtocol() : null,
    cipher: typeof socket.getCipher === 'function' ? (socket.getCipher() || {}).name || null : null,
    authorized: typeof socket.authorized === 'boolean' ? socket.authorized : null
  };
  if (certificate.subject && certificate.subject.CN) observation.subject = certificate.subject.CN;
  if (certificate.issuer && certificate.issuer.CN) {
    // l'émetteur est une donnée publique du certificat, jamais un secret
    observation.issuer = certificate.issuer.CN;
  }
  if (certificate.valid_to) observation.validTo = certificate.valid_to;
  return observation;
}

function isTlsError(code: string | undefined): boolean {
  if (!code) return false;
  return (
    code.indexOf('CERT') === 0 ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'EPROTO' ||
    code.indexOf('ERR_SSL') === 0
  );
}

function asAppError(error: unknown): Error {
  if (error && typeof error === 'object' && (error as { name?: string }).name === 'AppError') return error as Error;
  const message = error instanceof Error ? error.message : 'erreur reseau inattendue';
  return new AppError('network/refused', message);
}

function tryHost(url: string): string | null {
  const parsed = url.split('://')[1];
  if (!parsed) return null;
  const host = parsed.split('/')[0].split('?')[0].split('@').pop();
  return host ? host.split(':')[0] : null;
}

/** Résolution relative → absolue, sans dépendre de l'API `URL` (absente du contexte Node 8). */
export function absolutize(location: string, base: ParsedUrl): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) return location;
  const authority = base.host + (base.port === undefined ? '' : ':' + base.port);
  if (location.indexOf('//') === 0) return base.scheme + ':' + location;
  if (location.charAt(0) === '/') return base.scheme + '://' + authority + location;
  if (location === '') return base.scheme + '://' + authority + base.path;
  const basePath = base.path.slice(0, base.path.lastIndexOf('/') + 1);
  return base.scheme + '://' + authority + basePath + location;
}

/**
 * En-tête envoyé par défaut. Il identifie l'application (elle-même, pas un navigateur) : les
 * portails qui filtrent sur `User-Agent` reçoivent ainsi une valeur stable et lisible.
 */
export const DEFAULT_USER_AGENT = 'IPTVPlayer/0.1.14 (webOS TV; +https://github.com/ouagkamel/iptv_V2)';

export function codeForStatus(status: number): ErrorCode {
  if (status === 461) return 'provider/badResponse';
  if (status === 401 || status === 403) return 'auth/invalidCredentials';
  if (status === 404) return 'provider/badResponse';
  if (status === 429) return 'auth/tooManyConnections';
  if (status >= 500) return 'network/http';
  return 'network/http';
}
