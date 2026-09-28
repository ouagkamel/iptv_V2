/**
 * Contrats d'implémentation — transposition normative du §15.1 de la spécification v1.3.
 *
 * Règle de lecture : les types de ce fichier sont partagés par l'interface et le service.
 * `unknown` reste la valeur par défaut de toute donnée venant d'un fournisseur : aucune
 * réponse réseau n'est typée « de confiance » avant sa validation runtime (§5.1).
 *
 * Interdits portés par le contrat :
 *  - l'interface ne reçoit jamais d'URL de flux hors de `StreamResolution` ;
 *  - aucune URL de flux n'est persistée dans `ScreenState`, `history.state` ou un journal ;
 *  - un curseur n'est réutilisable que sur sa propre `indexVersion`.
 */

/* ------------------------------------------------------------------ identité */

export type ContentType = 'live' | 'vod' | 'series' | 'episode';

export interface ContentRef {
  profileId: string;
  contentType: ContentType;
  /** Xtream : identifiant fournisseur */
  providerId?: string;
  /** M3U : clé de variante (§5.3) */
  sourceKey?: string;
  /** M3U : clé logique, utilisée pour la réassociation */
  logicalKey?: string;
  /** dernier nom vu, pour l'UI et la réassociation */
  displayName: string;
}

export type HostSafety = 'ok' | 'private' | 'unknown' | 'allowed-lan';

/** Ce qu'un enregistrement d'index sait d'une entrée, hors charge variable. */
export interface CatalogItem {
  ref: ContentRef;
  categoryId: string;
  title: string;
  sourceOrder: number;
  logoOrPosterUrl?: string;
  epgId?: string;
  year?: number;
  durationSeconds?: number;
  /** ≤ 200 caractères en vue liste (§15.2) */
  summary?: string;
  hostSafety: HostSafety;
  /** dérivé : hostSafety autorisé ET streamRef résolu */
  playable: boolean;
}

/** Charge variable d'un enregistrement (§15.2), lue seulement par `getDetails`. */
export interface CatalogDetailRecord extends CatalogItem {
  /** forme d'URL repliée, sans identifiant quand le mode est `derived` */
  streamRef: string;
  /** `storedSecret` : URL complète chiffrée dans l'index ; `derived` : préfixe reconstruit en session */
  streamMode: StreamMode;
  plot?: string;
  /** séries : structure exposée par le fournisseur (§3.4) */
  seriesStructure?: SeriesStructure;
  seriesRef?: ContentRef;
  seasonNumber?: number;
  episodeNumber?: number;
}

export type StreamMode = 'storedSecret' | 'derived' | 'urlNoSecret';
export type SeriesStructure = 'provider' | 'derived' | 'flat';

export interface Category {
  id: string;
  profileId: string;
  contentType: ContentType;
  name: string;
  sourceOrder: number;
}

/* --------------------------------------------------------------- pagination */

/** Jamais un offset nu (§2.4) : la version d'index fait partie du curseur. */
export interface Cursor {
  indexVersion: number;
  contentType: ContentType;
  order: 'source' | 'title' | 'search';
  /** position dans l'ordre demandé */
  ordinal?: number;
  /** empreinte normalisée de la requête, si `order === 'search'` */
  queryKey?: string;
}

export interface CatalogPage<T> {
  items: T[];
  /** absent ⇒ fin de liste */
  cursor?: Cursor;
  indexVersion: number;
  totalKnown?: number;
  /** true quand l'indexation est partielle (`state === 'building'`) */
  approximate: boolean;
}

/* ------------------------------------------------------------ flux de lecture */

/** Résolution de flux : une donnée de session, pas de catalogue (§6.1). */
export interface StreamResolution {
  /** jamais journalisée, jamais persistée */
  url: string;
  preferredMime?: string;
  /** epoch ms */
  expiresAt?: number;
  kind: 'storedSecret' | 'derived' | 'urlNoSecret';
  resolvedAt: number;
}

/* ------------------------------------------------------------------- imports */

export type ImportPhase =
  | 'idle'
  | 'downloading'
  | 'parsing'
  | 'writing'
  | 'validating'
  | 'swapping'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface ImportJob {
  jobId: string;
  profileId: string;
  sourceType: 'm3u' | 'epg' | 'xtream';
  phase: ImportPhase;
  bytesRead: number;
  entriesRead: number;
  currentCategory?: string;
  tempIndexVersion: number;
  resumable: boolean;
  resumeHint?: { etag?: string; lastModified?: string; byteOffset?: number };
  /** décide la règle de persistance §3.5 */
  usesEmbeddedCredentials: boolean;
  /** sans secret */
  warnings: string[];
  startedAt: number;
  updatedAt: number;
}

/* ----------------------------------------------------------- état d'interface */

/** Un seul modèle d'état d'écran, pas un par écran (§4.3). */
export interface ScreenState {
  route: string;
  categoryId?: string;
  selectedRef?: ContentRef;
  scrollOffset: number;
  query?: string;
  /** tranche alphabétique active */
  bucket?: string;
  /** identifiant Spotlight à restaurer */
  focusId?: string;
}

/* ----------------------------------------------------- scripts et tranches */

export type ScriptId = 'latin' | 'arabic' | 'cyrillic' | 'hebrew' | 'greek' | 'cjk' | 'numeric';

export interface BucketSet {
  /** script dominant du catalogue */
  script: ScriptId;
  buckets: Array<{ key: string; count: number; startOrdinal: number }>;
  /** jamais recalculé depuis l'UI */
  generatedFrom: 'index';
}

/* ---------------------------------------------------------------- profils */

export interface ProfileInput {
  profileId?: string;
  kind: 'xtream' | 'm3u';
  baseUrl?: string;
  playlistUrl?: string;
  username?: string;
  password?: string;
  epgUrl?: string;
  /** autorisation explicite d'un serveur LAN pour ce profil (§5.2) */
  lanAllowed?: boolean;
  /** consentement de mémorisation du profil (§3.5, §8.2) */
  persistSecrets?: boolean;
  /** vrai si des identifiants sont mémorisés pour ce profil — jamais un identifiant lui-même (§9.2) */
  hasCredentials?: boolean;
  /**
   * `User-Agent` à utiliser pour ce portail. Vide = en-tête par défaut du service. Réglable parce
   * que certains portails et proxys CDN refusent une requête sans en-tête (constaté en 0C).
   */
  userAgent?: string;
}

export interface Profile extends ProfileInput {
  id: string;
  name: string;
  providerType: 'xtream' | 'm3u';
  preferredLiveFormat: 'auto' | 'hls' | 'ts';
  lastSyncAt?: number;
  status: 'unconfigured' | 'ok' | 'error';
}

export interface TestResult {
  ok: boolean;
  account?: {
    status?: string;
    expiresAt?: number;
    maxConnections?: number;
    activeConnections?: number;
    formats?: string[];
  };
  warnings: string[];
  errors: Array<{ code: string; message: string; retryable: boolean }>;
}

export interface RefreshOptions {
  /** sous-ensemble de groupes à indexer ; absent ⇒ tous */
  groups?: string[];
  etag?: string;
  lastModified?: string;
}

/* ------------------------------------------------------------- adaptateurs */

export interface ProviderAdapter {
  testConnection(profile: ProfileInput): Promise<TestResult>;
  getCategories(contentType: ContentType): Promise<Category[]>;
  getItems(contentType: ContentType, categoryId: string, cursor?: Cursor): Promise<CatalogPage<CatalogItem>>;
  getBuckets(contentType: ContentType): Promise<BucketSet>;
  searchItems(contentType: ContentType, normalizedQuery: string, cursor?: Cursor): Promise<CatalogPage<CatalogItem>>;
  getDetails(contentType: ContentType, ref: ContentRef): Promise<CatalogDetailRecord>;
  getEpg(channelRef: ContentRef, range: { fromUtc: number; toUtc: number }): Promise<Program[]>;
  resolveStream(ref: ContentRef, requestedFormat?: 'auto' | 'hls' | 'ts'): Promise<StreamResolution>;
  startRefresh(profileId: string, options: RefreshOptions): Promise<{ jobId: string }>;
}

/** Favori : identifié par `ContentRef`, jamais par une URL (§5.3). */
export interface FavoriteRecord {
  ref: ContentRef;
  profileId: string;
  lastSeenName: string;
  updatedAt: number;
  matchState: 'exact' | 'reassociated' | 'orphan';
}

export interface PlaybackPosition {
  ref: ContentRef;
  profileId: string;
  positionSeconds: number;
  durationSeconds?: number;
  updatedAt: number;
  completed: boolean;
}

export interface EpgMapping {
  ref: ContentRef;
  epgChannelId: string;
  matchMethod: 'tvg-id' | 'name' | 'manual';
  updatedAt: number;
}

export interface Program {
  epgChannelId: string;
  startUtc: number;
  endUtc?: number;
  title: string;
  description?: string;
  category?: string;
  imageUrl?: string;
}

/* ------------------------------------------------------- protocole LS2 (§15.4) */

export interface Ls2Reply<T> {
  returnValue: boolean;
  /** présent dès qu'une donnée d'index est renvoyée */
  indexVersion?: number;
  data?: T;
  error?: { code: string; retryable: boolean; hint?: string };
}

export const LS2_COMMANDS = [
  'testProfile',
  'importPlaylist',
  'getImportJob',
  'cancelOperation',
  'getPage',
  'search',
  'getBuckets',
  'getDetails',
  'resolveStream',
  'deleteProfile',
  'diagnostics'
] as const;

export type Ls2Command = (typeof LS2_COMMANDS)[number];
