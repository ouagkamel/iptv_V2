/**
 * Adaptateur Xtream-compatible (§5.1, `ProviderAdapter` du §15.1).
 *
 * Choix de mise en œuvre, dictés par la spécification :
 *  - **l'appel « tous les flux » d'abord** (`get_live_streams`, `get_vod_streams`, `get_series`) :
 *    c'est la voie par défaut, trois requêtes plus les listes de catégories. Le découpage **par
 *    catégorie** n'est qu'un repli (portail qui refuse l'appel global, quotas, ou sélection
 *    volontaire de groupes) ;
 *  - aucune réponse n'est supposée valide : le corps est analysé **au fil de l'eau** par
 *    `IncrementalJsonParser`, un objet à la fois, sans `JSON.parse` d'une réponse géante ;
 *  - les URL de flux sont **construites** depuis le format et l'identifiant fournis par le portail
 *    (ou reprises de `direct_source`), et ne sont jamais journalisées ;
 *  - les champs incohérents sont consignés en avertissements, sans interrompre un import entier.
 */

import { AppError } from '../../contracts/errors';
import type { Category, ContentType, StreamResolution, TestResult } from '../../contracts/types';
import { analyzeCredential, hostOf } from '../../core/urltools';
import { HttpClient, codeForStatus } from '../http/httpClient';
import { IncrementalJsonParser, type JsonValue } from '../http/jsonStream';
import {
  parseAccountInfo,
  parseCategory,
  parseSeriesInfo,
  parseStreamRecord,
  type FieldWarning,
  type RawRecord,
  type XtreamContentType,
  type XtreamSeriesInfo,
  type XtreamStreamRecord
} from './xtreamSchema';

const ACTION_BY_CONTENT: Record<XtreamContentType, string> = {
  live: 'get_live_streams',
  vod: 'get_vod_streams',
  series: 'get_series'
};

const CATEGORY_ACTION: Record<XtreamContentType, string> = {
  live: 'get_live_categories',
  vod: 'get_vod_categories',
  series: 'get_series_categories'
};

const BY_CATEGORY_FALLBACK_CODES = ['network/http', 'provider/badResponse', 'auth/tooManyConnections', 'network/timeout'];

export interface XtreamProfileInput {
  id: string;
  baseUrl?: string;
  username?: string;
  password?: string;
  /** consentement de mémorisation : décide de la persistance des identifiants (§3.5, §8.2) */
  persistSecrets?: boolean;
  preferredLiveFormat?: 'auto' | 'hls' | 'ts';
  lanAllowed?: boolean;
  /** en-tête envoyé au portail : vide = valeur par défaut du service */
  userAgent?: string;
}

export interface XtreamSession {
  username?: string;
  password?: string;
  /** hôtes déjà acceptés en HTTP clair pour ce profil */
  acceptedHosts?: string[];
}

export interface XtreamProviderOptions {
  http: HttpClient;
  profile: XtreamProfileInput;
  session?: XtreamSession;
  maxBytesPerResponse?: number;
  maxWireBytes?: number;
  /** avertissements cumulés (sans secret), remontés au diagnostic et à l'`ImportJob` */
  onWarning?: (warning: string) => void;
}

export interface StreamContentHooks {
  onEntry: (entry: XtreamStreamRecord, contentType: XtreamContentType) => void;
  shouldAbort?: () => boolean;
  onProgress?: (progress: { bytesRead: number; entriesRead: number; currentCategory?: string }) => void;
}

export interface StreamContentResult {
  entries: number;
  bytesRead: number;
  warnings: string[];
  usedFallback: boolean;
  categories: number;
}

export interface StreamUrlInput {
  providerId: string;
  contentType: ContentType;
  containerExtension?: string;
  directSource?: string;
  seriesStructure?: 'provider' | 'derived' | 'flat';
}

export class XtreamProvider {
  private readonly http: HttpClient;
  private readonly profile: XtreamProfileInput;
  private readonly session: XtreamSession;
  private readonly maxBytesPerResponse: number;
  private readonly maxWireBytes: number;
  private readonly warnings: string[] = [];
  private readonly onWarning: (warning: string) => void;

  constructor(options: XtreamProviderOptions) {
    if (!options.profile.baseUrl) {
      throw new AppError('profile/invalid', 'profil Xtream sans adresse de portail');
    }
    this.http = options.http;
    this.profile = options.profile;
    this.session = options.session || {};
    this.maxBytesPerResponse = options.maxBytesPerResponse === undefined ? 512 * 1024 * 1024 : options.maxBytesPerResponse;
    this.maxWireBytes = options.maxWireBytes === undefined ? 128 * 1024 * 1024 : options.maxWireBytes;
    this.onWarning = options.onWarning || ((warning: string) => this.warnings.push(warning));
  }

  get collectedWarnings(): string[] {
    return this.warnings.slice();
  }

  /** Identifiants disponibles en session ou persistés avec consentement — jamais lus du disque ici. */
  credentials(): { username: string; password: string } | null {
    const username = this.session.username || this.profile.username;
    const password = this.session.password || this.profile.password;
    if (!username || !password) return null;
    return { username: username, password: password };
  }

  /** Vrai si les identifiants ne sont disponibles qu'en session (profil non mémorisé). */
  usesSessionOnlyCredentials(): boolean {
    return Boolean((!this.profile.username || !this.profile.password) && this.session.username && this.session.password);
  }

  /** URL du portail (sans identifiants) : sert au marquage d'hôte à l'indexation (§5.2). */
  portalUrl(): string {
    return this.baseUrl();
  }

  private baseUrl(): string {
    return String(this.profile.baseUrl).replace(/\/+$/, '');
  }

  private apiUrl(params: Record<string, string | number | undefined>): string {
    const credentials = this.credentials();
    const query: string[] = [];
    if (credentials) {
      query.push('username=' + encodeURIComponent(credentials.username));
      query.push('password=' + encodeURIComponent(credentials.password));
    }
    Object.keys(params).forEach((key) => {
      const value = params[key];
      if (value !== undefined && value !== null && value !== '') query.push(key + '=' + encodeURIComponent(String(value)));
    });
    return this.baseUrl() + '/player_api.php' + (query.length > 0 ? '?' + query.join('&') : '');
  }

  private requestOptions(shouldAbort?: () => boolean) {
    const headers: Record<string, string> = {};
    // Le `User-Agent` est réglable par profil : des portails (et des proxys CDN) refusent une
    // requête qui n'en porte pas. Aucune URL de flux n'est jamais transmise en en-tête ni en
    // Referer.
    if (this.profile.userAgent) headers['User-Agent'] = this.profile.userAgent;
    return {
      lanAllowed: Boolean(this.profile.lanAllowed),
      acceptedHosts: this.session.acceptedHosts || [],
      maxBytes: this.maxBytesPerResponse,
      maxWireBytes: this.maxWireBytes,
      shouldAbort: shouldAbort,
      headers: headers
    };
  }

  /* ------------------------------------------------------------- test de profil */

  async testConnection(): Promise<TestResult> {
    const result: TestResult = { ok: false, warnings: [], errors: [] };
    if (!this.credentials()) {
      result.errors.push({
        code: 'auth/invalidCredentials',
        message: 'identifiants requis pour ce portail',
        retryable: false
      });
      return result;
    }
    try {
      const response = await this.http.get(this.apiUrl({}), this.requestOptions());
      if (response.status === 401 || response.status === 403) {
        result.errors.push({ code: 'auth/invalidCredentials', message: 'portail : acces refuse', retryable: false });
        return result;
      }
      if (response.status >= 400) {
        const code = codeForStatus(response.status);
        result.errors.push({ code: code, message: 'portail : reponse HTTP ' + response.status, retryable: code !== 'auth/invalidCredentials' });
        return result;
      }
      const parser = new IncrementalJsonParser({ collectRootArray: true });
      parser.push(response.text || '');
      parser.finish();
      const root = parser.root;
      if (!root || typeof root !== 'object' || Array.isArray(root)) {
        result.errors.push({
          code: 'provider/badResponse',
          message: 'reponse du portail non conforme (objet JSON attendu)',
          retryable: true
        });
        return result;
      }
      const record = root as RawRecord;
      if (record.user_info === undefined) {
        // certaines portails renvoient une erreur applicative dans le corps
        result.errors.push({
          code: 'auth/invalidCredentials',
          message: 'portail : reponse sans user_info (identifiants ou URL probablement invalides)',
          retryable: false
        });
        return result;
      }
      const account = parseAccountInfo(record.user_info, record.server_info);
      account.warnings.forEach((warning: FieldWarning) => {
        result.warnings.push('compte : ' + warning.field + ' — ' + warning.reason);
      });
      const auth = account.auth;
      if (auth === false) {
        result.errors.push({ code: 'auth/invalidCredentials', message: 'portail : authentification refusee', retryable: false });
        return result;
      }
      if (account.status && !/^active$/i.test(account.status)) {
        result.errors.push({ code: 'auth/expired', message: 'portail : compte inactif', retryable: false });
      }
      if (account.expiresAt !== undefined && account.expiresAt < Date.now()) {
        result.errors.push({ code: 'auth/expired', message: 'portail : abonnement expire', retryable: false });
      }
      const details: TestResult['account'] = {
        formats: account.formats
      };
      if (account.status) details.status = account.status;
      if (account.expiresAt !== undefined) details.expiresAt = account.expiresAt;
      if (account.maxConnections !== undefined) details.maxConnections = account.maxConnections;
      if (account.activeConnections !== undefined) details.activeConnections = account.activeConnections;
      result.account = details;
      if (account.maxConnections !== undefined && account.maxConnections <= 1) {
        result.warnings.push('connexions simultanees limitees a ' + account.maxConnections + ' : la sonde MIME est interdite, metadonnees uniquement');
      }
      const host = hostOf(this.baseUrl());
      if (host && this.session.acceptedHosts && this.session.acceptedHosts.indexOf(host) === -1 && this.baseUrl().indexOf('http://') === 0) {
        // Erreur **et** avertissement : l'erreur porte le code attendu par l'appelant (§8.2) et son
        // `hint` nomme l'hôte à confirmer, ce qui permet à la page de proposer la confirmation en un clic.
        result.errors.push({
          code: 'security/insecureScheme',
          message: 'portail en HTTP clair : avertissement a confirmer une fois pour cet hote',
          retryable: false,
          hint: 'hote:' + host
        });
        result.warnings.push('portail en HTTP clair : avertissement a confirmer une fois pour cet hote');
      }
      result.ok = result.errors.length === 0;
      return result;
    } catch (error) {
      const appError = asAppError(error);
      // Le `hint` accompagne l'erreur : c'est lui qui permet à la page de proposer l'action
      // (confirmer l'hôte en HTTP clair, ressaisir les identifiants) sans deviner.
      result.errors.push({
        code: appError.code,
        message: appError.message,
        retryable: appError.retryable,
        ...(appError.hint ? { hint: appError.hint } : {})
      });
      if (appError.hint) result.warnings.push(appError.hint);
      return result;
    }
  }

  /* -------------------------------------------------------------- catégories */

  async fetchCategories(contentType: ContentType): Promise<Category[]> {
    const action = CATEGORY_ACTION[contentType as XtreamContentType];
    if (!action) throw new AppError('provider/unsupported', 'type de contenu sans categories Xtream');
    const response = await this.http.get(this.apiUrl({ action: action }), this.requestOptions());
    const payload = this.readJson(response, 'liste de categories');
    if (!Array.isArray(payload)) {
      throw new AppError('provider/badResponse', 'reponse de categories non conforme (tableau attendu)');
    }
    const warnings: FieldWarning[] = [];
    const categories: Category[] = [];
    (payload as unknown[]).forEach((raw, index) => {
      const parsed = parseCategory(raw, index, warnings);
      if (parsed) {
        categories.push({
          id: parsed.id,
          profileId: this.profile.id,
          contentType: contentType,
          name: parsed.name,
          sourceOrder: parsed.sourceOrder
        });
      }
    });
    this.reportWarnings(warnings, 'categories');
    return categories;
  }

  /* ------------------------------------------------------ flux : import complet */

  /**
   * Ingère « tous les flux » d'un type de contenu par analyse incrémentale. Le repli par catégorie
   * n'est tenté que si l'appel global échoue de façon récupérable (§5.1).
   */
  async streamContentType(contentType: XtreamContentType, hooks: StreamContentHooks): Promise<StreamContentResult> {
    const warnings: string[] = [];
    // Compte les entrées déjà remises à l'appelant : le repli par catégorie ne rejoue **jamais** un
    // import qui a déjà consommé une partie de l'appel global, sinon les entrées seraient indexées
    // deux fois (§5.1 : un seul index, aucun doublon).
    let emitted = 0;
    const guardedHooks: StreamContentHooks = Object.assign({}, hooks, {
      onEntry: (record: XtreamStreamRecord, type: XtreamContentType) => {
        emitted += 1;
        hooks.onEntry(record, type);
      }
    });
    try {
      const result = await this.streamAction(contentType, ACTION_BY_CONTENT[contentType], undefined, guardedHooks);
      return Object.assign(result, { usedFallback: false });
    } catch (error) {
      const appError = asAppError(error);
      if (BY_CATEGORY_FALLBACK_CODES.indexOf(appError.code) === -1) throw appError;
      if (emitted > 0) {
        throw new AppError(
          appError.code,
          'appel global interrompu apres ' + emitted + ' entrees : repli impossible sans indexer deux fois',
          appError.hint
        );
      }
      this.onWarning('appel global refuse (' + appError.code + ') : repli par categorie');
      const categories = await this.fetchCategories(contentType);
      const accumulated: StreamContentResult = {
        entries: 0,
        bytesRead: 0,
        warnings: [],
        usedFallback: true,
        categories: categories.length
      };
      for (const category of categories) {
        if (hooks.shouldAbort && hooks.shouldAbort()) throw new AppError('internal/cancelled', 'operation annulee');
        const partial = await this.streamAction(contentType, ACTION_BY_CONTENT[contentType], category.id, guardedHooks);
        accumulated.entries += partial.entries;
        accumulated.bytesRead += partial.bytesRead;
        accumulated.categories = categories.length;
        partial.warnings.forEach((warning) => accumulated.warnings.push(warning));
        if (guardedHooks.onProgress) {
          guardedHooks.onProgress({
            bytesRead: accumulated.bytesRead,
            entriesRead: accumulated.entries,
            currentCategory: category.name
          });
        }
      }
      return accumulated;
    }
  }

  private async streamAction(
    contentType: XtreamContentType,
    action: string,
    categoryId: string | undefined,
    hooks: StreamContentHooks
  ): Promise<StreamContentResult> {
    const warnings: string[] = [];
    const fieldWarnings: FieldWarning[] = [];
    let entries = 0;
    let bytesRead = 0;
    let parseError: AppError | null = null;
    const parser = new IncrementalJsonParser({
      onTopLevelValue: (value: JsonValue) => {
        if (Array.isArray(value)) {
          // racine tableau livrée d'un bloc (réponse courte) : on la parcourt ici
          value.forEach((element) => emit(element));
          return;
        }
        emit(value);
      }
    });
    const emit = (element: JsonValue): void => {
      const record = parseStreamRecord(contentType, element, entries, fieldWarnings);
      if (!record) return;
      entries += 1;
      hooks.onEntry(record, contentType);
    };
    const response = await this.http.get(
      this.apiUrl({ action: action, category_id: categoryId }),
      Object.assign(this.requestOptions(hooks.shouldAbort), {
        maxBytes: this.maxBytesPerResponse,
        maxWireBytes: this.maxWireBytes,
        onData: (chunk: Buffer) => {
          bytesRead += chunk.length;
          try {
            parser.push(chunk);
          } catch (error) {
            parseError = asAppError(error);
          }
          if (hooks.onProgress && entries > 0 && entries % 500 === 0) {
            hooks.onProgress({ bytesRead: bytesRead, entriesRead: entries, currentCategory: categoryId });
          }
        }
      })
    );
    if (parseError) throw parseError;
    if (response.status === 401 || response.status === 403) {
      throw new AppError('auth/invalidCredentials', 'portail : acces refuse pendant l import');
    }
    if (response.status >= 400) {
      throw new AppError(codeForStatus(response.status), 'portail : reponse HTTP ' + response.status);
    }
    if ((response.text || '').trim() !== '') {
      // réponse courte non diffusée : on termine l'analyse pour valider la structure
      parser.push(response.text as string);
    }
    parser.finish();
    if (parser.root !== undefined && !Array.isArray(parser.root)) {
      throw new AppError('provider/badResponse', 'reponse de flux non conforme (tableau attendu)');
    }
    fieldWarnings.forEach((warning) => {
      const text = contentType + ' : ' + warning.field + ' — ' + warning.reason;
      if (warnings.indexOf(text) === -1) warnings.push(text);
    });
    warnings.forEach((warning) => this.onWarning(warning));
    return { entries: entries, bytesRead: bytesRead, warnings: warnings, usedFallback: false, categories: 0 };
  }

  /* ------------------------------------------------- séries : détail (V1-C) */

  async getSeriesInfo(seriesId: string): Promise<XtreamSeriesInfo> {
    const response = await this.http.get(
      this.apiUrl({ action: 'get_series_info', series_id: seriesId }),
      this.requestOptions()
    );
    const payload = this.readJson(response, 'detail de serie');
    return parseSeriesInfo(payload);
  }

  /* ---------------------------------------------------- construction d'URL */

  /**
   * Construit l'URL de lecture à partir du format et de l'identifiant fournis par le portail.
   * Cette méthode est la **seule** source d'URL de flux ; son résultat n'est jamais journalisé.
   */
  buildStreamUrl(input: StreamUrlInput, requestedFormat: 'auto' | 'hls' | 'ts' = 'auto'): { url: string; preferredMime?: string; kind: StreamResolution['kind'] } {
    if (input.directSource) {
      // URL imposée par le portail : c'est l'analyse des identifiants (§5.2) qui décide du
      // classement — userinfo, segment de chemin de type user/pass, requête nommée ou segment long.
      const analysis = analyzeCredential(input.directSource);
      const kind: StreamResolution['kind'] = analysis.hasCredential ? 'storedSecret' : 'urlNoSecret';
      return { url: input.directSource, kind: kind };
    }
    const credentials = this.credentials();
    if (!credentials) {
      throw new AppError('auth/invalidCredentials', 'identifiants absents en session pour construire l URL de lecture', 'ressaisir les identifiants du profil');
    }
    const user = encodeURIComponent(credentials.username);
    const pass = encodeURIComponent(credentials.password);
    const base = this.baseUrl();
    if (input.contentType === 'live') {
      const format = requestedFormat === 'auto' ? (this.profile.preferredLiveFormat && this.profile.preferredLiveFormat !== 'auto' ? this.profile.preferredLiveFormat : 'ts') : requestedFormat;
      const extension = format === 'hls' ? 'm3u8' : 'ts';
      const url = base + '/live/' + user + '/' + pass + '/' + input.providerId + '.' + extension;
      return {
        url: url,
        preferredMime: extension === 'm3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        kind: 'derived'
      };
    }
    if (input.contentType === 'vod' || input.contentType === 'episode') {
      const extension = input.containerExtension || 'mp4';
      const segment = input.contentType === 'vod' ? 'movie' : 'series';
      return {
        url: base + '/' + segment + '/' + user + '/' + pass + '/' + input.providerId + '.' + extension,
        kind: 'derived'
      };
    }
    throw new AppError('provider/unsupported', 'construction d URL indisponible pour ce type de contenu');
  }

  /* --------------------------------------------------------------- lecture */

  private readJson(
    response: { status: number; text?: string },
    what: string
  ): JsonValue | undefined {
    if (response.status >= 400) {
      throw new AppError(codeForStatus(response.status), 'portail : reponse HTTP ' + response.status + ' pour ' + what);
    }
    const text = (response.text || '').trim();
    if (text === '') throw new AppError('provider/badResponse', 'reponse vide pour ' + what);
    // réponse courte et bornée : l'accumulation est ici légitime (et nécessaire)
    const parser = new IncrementalJsonParser({ collectRootArray: true });
    parser.push(text);
    parser.finish();
    return parser.root;
  }

  private reportWarnings(warnings: FieldWarning[], scope: string): void {
    warnings.forEach((warning) => {
      const text = scope + ' : ' + warning.field + ' — ' + warning.reason;
      if (this.warnings.indexOf(text) === -1) this.onWarning(text);
    });
  }
}

function asAppError(error: unknown): AppError {
  if (error && typeof error === 'object' && (error as { name?: string }).name === 'AppError') return error as AppError;
  const message = error instanceof Error ? error.message : 'erreur fournisseur inattendue';
  return new AppError('provider/badResponse', message);
}
