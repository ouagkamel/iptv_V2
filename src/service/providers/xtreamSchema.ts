/**
 * Validation et normalisation des réponses Xtream (§5.1).
 *
 * « Les actions et champs Xtream sont une convention de facto, non une API unique garantie. Tester
 * la réponse réelle, gérer identifiants en nombre ou chaîne, champs manquants, versions de noms
 * (`series_id`, par exemple) et variantes EPG ; ne jamais supposer que toute réponse 200 est un JSON
 * valide. »
 *
 * Conséquence : chaque champ est converti explicitement, un champ absent n'est jamais remplacé par
 * une valeur inventée, et les écarts sont consignés en avertissements (sans secret) plutôt que
 * d'interrompre un import entier.
 */

export interface FieldWarning {
  field: string;
  reason: string;
}

export type RawRecord = Record<string, unknown>;

/** Chaîne non vide, quelle que soit la forme d'entrée (nombre, chaîne espacée). */
export function asText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (typeof value === 'number' && isFinite(value)) return String(value);
  return undefined;
}

/** Identifiant : nombre ou chaîne, jamais un objet. */
export function asId(value: unknown): string | undefined {
  return asText(value);
}

/** Entier positif ou null : `null` est la seule valeur non numérique acceptée. */
export function asInt(value: unknown): number | undefined {
  if (typeof value === 'number' && isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '' && /^-?\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  return undefined;
}

/** Horodatage Xtream : epoch secondes (parfois en chaîne), ou date ISO. */
export function asEpochMs(value: unknown): number | undefined {
  const seconds = asInt(value);
  if (seconds !== undefined) return seconds > 1e12 ? seconds : seconds * 1000;
  const text = asText(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  if (isNaN(parsed)) return undefined;
  return parsed;
}

/** Tableau de chaînes (`allowed_output_formats`, `genre`, …). */
export function asTextArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => asText(item)).filter((item): item is string => item !== undefined);
  }
  const single = asText(value);
  return single === undefined ? [] : [single];
}

export interface XtreamAccountInfo {
  status?: string;
  expiresAt?: number;
  maxConnections?: number;
  activeConnections?: number;
  formats: string[];
  isTrial?: boolean;
  auth?: boolean;
  warnings: FieldWarning[];
}

/** `user_info` du `player_api.php` sans action (§5.1 : détecte format/expiration/connexions). */
export function parseAccountInfo(userInfo: unknown, serverInfo?: unknown): XtreamAccountInfo {
  const warnings: FieldWarning[] = [];
  const info: RawRecord = (userInfo && typeof userInfo === 'object' ? (userInfo as RawRecord) : {});
  const account: XtreamAccountInfo = { formats: [], warnings };
  const status = asText(info.status);
  if (status) account.status = status;
  const expiresAt = asEpochMs(info.exp_date);
  if (expiresAt !== undefined) account.expiresAt = expiresAt;
  const maxConnections = asInt(info.max_connections);
  if (maxConnections !== undefined) account.maxConnections = maxConnections;
  const activeConnections = asInt(info.active_cons);
  if (activeConnections !== undefined) account.activeConnections = activeConnections;
  if (info.is_trial !== undefined) account.isTrial = info.is_trial === true || info.is_trial === '1' || info.is_trial === 1;
  if (info.auth !== undefined) account.auth = info.auth === 1 || info.auth === true || info.auth === '1';
  const formats = asTextArray(info.allowed_output_formats);
  account.formats = formats;
  if (formats.length === 0) {
    warnings.push({ field: 'allowed_output_formats', reason: 'absent : formats non annonces par le fournisseur' });
  }
  if (status === undefined) warnings.push({ field: 'status', reason: 'absent : etat du compte inconnu' });
  if (expiresAt === undefined) warnings.push({ field: 'exp_date', reason: 'absent : expiration non exposee' });
  if (serverInfo && typeof serverInfo === 'object') {
    const server = serverInfo as RawRecord;
    if (asText(server.url) === undefined && asText(server.port) === undefined) {
      warnings.push({ field: 'server_info', reason: 'portail sans url ni port exposes' });
    }
  }
  return account;
}

export interface XtreamCategoryRecord {
  id: string;
  name: string;
  parentId?: string;
  sourceOrder: number;
}

export function parseCategory(raw: unknown, sourceOrder: number, warnings: FieldWarning[]): XtreamCategoryRecord | null {
  const record = raw as RawRecord;
  if (!record || typeof record !== 'object') {
    warnings.push({ field: 'categories', reason: 'entree non objet ignoree' });
    return null;
  }
  const id = asId(record.category_id);
  if (id === undefined) {
    warnings.push({ field: 'category_id', reason: 'categorie sans identifiant ignoree' });
    return null;
  }
  const name = asText(record.category_name) || 'Categorie ' + id;
  const category: XtreamCategoryRecord = { id, name, sourceOrder };
  const parentId = asId(record.parent_id);
  if (parentId !== undefined && parentId !== '0') category.parentId = parentId;
  return category;
}

export type XtreamContentType = 'live' | 'vod' | 'series';

export interface XtreamStreamRecord {
  providerId: string;
  title: string;
  categoryId?: string;
  logoOrPosterUrl?: string;
  epgId?: string;
  year?: number;
  durationSeconds?: number;
  summary?: string;
  /** extension réelle du conteneur (séries/VOD) : `container_extension` */
  containerExtension?: string;
  /** URL directe fournie par le portail, si présente */
  directSource?: string;
  /** identifiant d'épisode pour les séries */
  seriesId?: string;
  sourceOrder: number;
}

/**
 * Convertit une entrée de flux (live/vod/série) en enregistrement d'index. Un identifiant
 * manquant fait ignorer l'entrée avec un avertissement : une entrée sans identifiant ne peut pas
 * être résolue en URL de lecture, donc elle n'est pas indexable.
 */
export function parseStreamRecord(
  contentType: XtreamContentType,
  raw: unknown,
  sourceOrder: number,
  warnings: FieldWarning[]
): XtreamStreamRecord | null {
  const record = raw as RawRecord;
  if (!record || typeof record !== 'object') {
    warnings.push({ field: contentType, reason: 'entree non objet ignoree' });
    return null;
  }
  const providerId = idFor(contentType, record);
  if (providerId === undefined) {
    warnings.push({ field: contentType + '.id', reason: 'entree sans identifiant de flux ignoree' });
    return null;
  }
  const title = asText(record.name) || asText(record.title) || idFallbackTitle(contentType, providerId);
  const parsed: XtreamStreamRecord = { providerId, title, sourceOrder };
  const categoryId = asId(record.category_id);
  if (categoryId !== undefined) parsed.categoryId = categoryId;
  const logo = asText(record.stream_icon) || asText(record.cover);
  if (logo) parsed.logoOrPosterUrl = logo;
  const epgId = asText(record.epg_channel_id) || asText(record.epg_id);
  if (epgId) parsed.epgId = epgId;
  const year = asInt(record.year);
  if (year !== undefined && year > 1900) parsed.year = year;
  if (contentType === 'vod') {
    const duration = asInt(record.duration_secs) || asInt(record.duration);
    if (duration !== undefined) parsed.durationSeconds = duration;
  }
  const summary = asText(record.plot);
  if (summary) parsed.summary = clip(summary, 200);
  const extension = asText(record.container_extension);
  if (extension) parsed.containerExtension = extension.replace(/^\./, '').toLowerCase();
  const direct = asText(record.direct_source);
  if (direct) parsed.directSource = direct;
  if (contentType === 'series') {
    const seriesId = asId(record.series_id);
    if (seriesId !== undefined) parsed.seriesId = seriesId;
  }
  return parsed;
}

function idFor(contentType: XtreamContentType, record: RawRecord): string | undefined {
  if (contentType === 'series') return asId(record.series_id) || asId(record.stream_id);
  return asId(record.stream_id) || asId(record.id);
}

function idFallbackTitle(contentType: XtreamContentType, id: string): string {
  return (contentType === 'live' ? 'Chaine ' : contentType === 'vod' ? 'Film ' : 'Serie ') + id;
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/* ------------------------------------------------------------ séries (V1-C) */

export interface XtreamEpisode {
  providerId: string;
  title: string;
  seasonNumber?: number;
  episodeNumber?: number;
  durationSeconds?: number;
  summary?: string;
  containerExtension?: string;
}

export interface XtreamSeriesInfo {
  seasons: Array<{ seasonNumber: number; episodes: XtreamEpisode[] }>;
  warnings: FieldWarning[];
}

/** `get_series_info` : saisons/épisodes, avec les variantes de structure constatées. */
export function parseSeriesInfo(payload: unknown): XtreamSeriesInfo {
  const warnings: FieldWarning[] = [];
  const root = (payload && typeof payload === 'object' ? (payload as RawRecord) : {});
  const episodesRaw = root.episodes;
  const seasons: Array<{ seasonNumber: number; episodes: XtreamEpisode[] }> = [];
  if (episodesRaw && typeof episodesRaw === 'object' && !Array.isArray(episodesRaw)) {
    Object.keys(episodesRaw as RawRecord).forEach((seasonKey) => {
      const seasonNumber = parseInt(seasonKey.replace(/[^0-9-]/g, ''), 10);
      const list = (episodesRaw as RawRecord)[seasonKey];
      if (!Array.isArray(list)) {
        warnings.push({ field: 'episodes.' + seasonKey, reason: 'saison non tableau, ignoree' });
        return;
      }
      const episodes = list
        .map((raw, index) => parseEpisode(raw, index, warnings))
        .filter((episode): episode is XtreamEpisode => episode !== null);
      seasons.push({ seasonNumber: isNaN(seasonNumber) ? 0 : seasonNumber, episodes });
    });
  } else if (Array.isArray(episodesRaw)) {
    // variante plate : tous les épisodes dans un seul tableau
    const episodes = (episodesRaw as unknown[])
      .map((raw, index) => parseEpisode(raw, index, warnings))
      .filter((episode): episode is XtreamEpisode => episode !== null);
    const bySeason: Record<number, XtreamEpisode[]> = {};
    episodes.forEach((episode) => {
      const season = episode.seasonNumber === undefined ? 0 : episode.seasonNumber;
      (bySeason[season] = bySeason[season] || []).push(episode);
    });
    Object.keys(bySeason).forEach((key) => {
      seasons.push({ seasonNumber: parseInt(key, 10), episodes: bySeason[parseInt(key, 10)] });
    });
  } else {
    warnings.push({ field: 'episodes', reason: 'absent : serie sans episodes exposes' });
  }
  seasons.sort((a, b) => a.seasonNumber - b.seasonNumber);
  return { seasons, warnings };
}

function parseEpisode(raw: unknown, index: number, warnings: FieldWarning[]): XtreamEpisode | null {
  const record = raw as RawRecord;
  if (!record || typeof record !== 'object') {
    warnings.push({ field: 'episode', reason: 'entree non objet ignoree' });
    return null;
  }
  const providerId = asId(record.id) || asId(record.stream_id) || asId(record.episode_id);
  if (providerId === undefined) {
    warnings.push({ field: 'episode.id', reason: 'episode sans identifiant ignore' });
    return null;
  }
  const episode: XtreamEpisode = { providerId, title: asText(record.title) || 'Episode ' + (index + 1) };
  const season = asInt(record.season);
  if (season !== undefined) episode.seasonNumber = season;
  const number = asInt(record.episode_num) || asInt(record.episode);
  if (number !== undefined) episode.episodeNumber = number;
  const duration = asInt(record.duration_secs) || asInt(record.duration);
  if (duration !== undefined) episode.durationSeconds = duration;
  const info = record.info && typeof record.info === 'object' ? (record.info as RawRecord) : record;
  const plot = asText(info.plot);
  if (plot) episode.summary = clip(plot, 200);
  const extension = asText(record.container_extension) || asText(info.container_extension);
  if (extension) episode.containerExtension = extension.replace(/^\./, '').toLowerCase();
  return episode;
}
