/**
 * Dépôts DB8 (§2.4) — un seul endroit qui convertit entre les modèles du §5.1 et les
 * enregistrements persistés. Aucun de ces dépôts ne conserve ni ne renvoie d'URL de flux : une URL
 * n'est jamais une donnée de catalogue (§5.1), elle n'est produite que par `resolveStream()`.
 *
 * La clé maître de profil (32 octets) est stockée en base64 dans son propre kind, jamais journalisée,
 * supprimée avec le profil (§15.3, §15.4 `deleteProfile`).
 */

import * as crypto from 'crypto';
import type { ContentRef, FavoriteRecord, PlaybackPosition, Profile, ImportJob } from '../../contracts/types';
import { redactUrl } from '../../core/urltools';
import { Db8Client, kindOf } from './client';

export interface ProfileRepository {
  list(): Promise<Profile[]>;
  get(profileId: string): Promise<Profile | null>;
  save(profile: Profile): Promise<void>;
  remove(profileId: string): Promise<void>;
}

export interface ImportJobRepository {
  /** Chargé au démarrage du service : permet la reprise après mort du service (§15.5). */
  get(jobId: string): Promise<ImportJob | null>;
  activeForProfile(profileId: string): Promise<ImportJob | null>;
  save(job: ImportJob): Promise<void>;
  remove(jobId: string): Promise<void>;
}

export interface MasterKeyRepository {
  get(profileId: string): Promise<Buffer | null>;
  ensure(profileId: string): Promise<Buffer>;
  remove(profileId: string): Promise<void>;
}

export interface ConsentRecord {
  profileId: string;
  /** hôte déjà accepté en HTTP clair (avertissement mémorisé une fois par profil et par hôte, §8.2) */
  insecureHost?: string;
  kind: 'persistProfile' | 'persistPlaylistUrls' | 'insecureHttp';
  acceptedAt: number;
}

export interface ConsentRepository {
  record(consent: ConsentRecord): Promise<void>;
  list(profileId: string): Promise<ConsentRecord[]>;
  has(profileId: string, kind: ConsentRecord['kind'], host?: string): Promise<boolean>;
  remove(profileId: string): Promise<void>;
}

/* ------------------------------------------------------------------ profils */

export function createProfileRepository(db: Db8Client): ProfileRepository {
  return {
    async list(): Promise<Profile[]> {
      const rows = await db.find<Record<string, unknown>>('profiles', {});
      return rows.map(rowToProfile);
    },
    async get(profileId: string): Promise<Profile | null> {
      const rows = await db.find<Record<string, unknown>>('profiles', { id: profileId }, { limit: 1 });
      return rows.length > 0 ? rowToProfile(rows[0]) : null;
    },
    async save(profile: Profile): Promise<void> {
      const row = profileToRow(profile);
      const existing = await db.find<Record<string, unknown>>('profiles', { id: profile.id }, { limit: 1 });
      if (existing.length > 0 && existing[0]._id) row._id = existing[0]._id;
      await db.put('profiles', [row]);
    },
    async remove(profileId: string): Promise<void> {
      const rows = await db.find<Record<string, unknown>>('profiles', { id: profileId });
      const ids = rows.map((row) => String(row._id || '')).filter((id) => id !== '');
      await db.del('profiles', ids);
    }
  };
}

/** Le profil persisté ne contient un secret que si l'utilisateur y a consenti (§3.5, §8.2). */
function profileToRow(profile: Profile): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: profile.id,
    name: profile.name,
    providerType: profile.providerType,
    preferredLiveFormat: profile.preferredLiveFormat,
    status: profile.status,
    persistSecrets: profile.persistSecrets === true
  };
  if (profile.baseUrl) row.baseUrl = profile.baseUrl;
  if (profile.playlistUrl) row.playlistUrl = profile.playlistUrl;
  if (profile.epgUrl) row.epgUrl = profile.epgUrl;
  if (profile.lanAllowed) row.lanAllowed = true;
  if (profile.userAgent) row.userAgent = profile.userAgent;
  if (profile.lastSyncAt !== undefined) row.lastSyncAt = profile.lastSyncAt;
  if (profile.persistSecrets === true) {
    if (profile.username !== undefined) row.username = profile.username;
    // Le mot de passe est conservé parce que le consentement l'autorise explicitement ; il n'est
    // jamais renvoyé à l'interface (voir `redactProfile`).
    if (profile.password !== undefined) row.password = profile.password;
  }
  return row;
}

function rowToProfile(row: Record<string, unknown>): Profile {
  const providerType = (row.providerType as Profile['providerType']) || 'xtream';
  const profile: Profile = {
    kind: providerType,
    id: String(row.id),
    name: String(row.name || ''),
    providerType: providerType,
    preferredLiveFormat: (row.preferredLiveFormat as Profile['preferredLiveFormat']) || 'auto',
    status: (row.status as Profile['status']) || 'unconfigured',
    persistSecrets: row.persistSecrets === true
  };
  if (row.baseUrl) profile.baseUrl = String(row.baseUrl);
  if (row.playlistUrl) profile.playlistUrl = String(row.playlistUrl);
  if (row.epgUrl) profile.epgUrl = String(row.epgUrl);
  if (row.lanAllowed === true) profile.lanAllowed = true;
  if (typeof row.userAgent === 'string' && row.userAgent !== '') profile.userAgent = row.userAgent;
  if (typeof row.lastSyncAt === 'number') profile.lastSyncAt = row.lastSyncAt;
  if (typeof row.username === 'string') profile.username = row.username;
  if (typeof row.password === 'string') profile.password = row.password;
  return profile;
}

/** Vue destinée à l'interface : jamais de mot de passe, jamais d'URL de lecture (§15.1). */
/**
 * Profil **assaini** pour l'interface et le diagnostic (§9.2) : ni mot de passe, ni nom
 * d'utilisateur — seule l'information « des identifiants sont mémorisés » est utile.
 */
export function redactProfile(profile: Profile): Profile {
  const copy: Profile = Object.assign({}, profile);
  const hasCredentials = Boolean(profile.username || profile.password);
  delete copy.password;
  delete copy.username;
  copy.hasCredentials = hasCredentials;
  // Les adresses sont rédigées : une URL de portail saisie avec des identifiants ne doit jamais
  // ressortir telle quelle dans une vue ou un diagnostic (§9.2).
  if (copy.baseUrl) copy.baseUrl = redactUrl(copy.baseUrl);
  if (copy.playlistUrl) copy.playlistUrl = redactUrl(copy.playlistUrl);
  if (copy.epgUrl) copy.epgUrl = redactUrl(copy.epgUrl);
  return copy;
}

/* --------------------------------------------------------------- clé maître */

export function createMasterKeyRepository(db: Db8Client): MasterKeyRepository {
  return {
    async get(profileId: string): Promise<Buffer | null> {
      const rows = await db.find<Record<string, unknown>>('masterKeys', { profileId }, { limit: 1 });
      if (rows.length === 0) return null;
      const encoded = String(rows[0].key || '');
      try {
        const key = Buffer.from(encoded, 'base64');
        return key.length === 32 ? key : null;
      } catch (_err) {
        return null;
      }
    },
    async ensure(profileId: string): Promise<Buffer> {
      const existing = await this.get(profileId);
      if (existing) return existing;
      const key = crypto.randomBytes(32);
      const rows = await db.find<Record<string, unknown>>('masterKeys', { profileId }, { limit: 1 });
      const row: Record<string, unknown> = { profileId, key: key.toString('base64') };
      if (rows.length > 0 && rows[0]._id) row._id = rows[0]._id;
      await db.put('masterKeys', [row]);
      return key;
    },
    async remove(profileId: string): Promise<void> {
      const rows = await db.find<Record<string, unknown>>('masterKeys', { profileId });
      await db.del('masterKeys', rows.map((row) => String(row._id || '')).filter((id) => id !== ''));
    }
  };
}

/* ------------------------------------------------------------- import jobs */

export function createImportJobRepository(db: Db8Client): ImportJobRepository {
  return {
    async get(jobId: string): Promise<ImportJob | null> {
      const rows = await db.find<Record<string, unknown>>('importJobs', { jobId }, { limit: 1 });
      return rows.length > 0 ? (rows[0].job as ImportJob) : null;
    },
    async activeForProfile(profileId: string): Promise<ImportJob | null> {
      const rows = await db.find<Record<string, unknown>>('importJobs', { profileId });
      const active = rows
        .map((row) => row.job as ImportJob)
        .filter((job) => isActivePhase(job.phase));
      if (active.length === 0) return null;
      return active.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    },
    async save(job: ImportJob): Promise<void> {
      const rows = await db.find<Record<string, unknown>>('importJobs', { jobId: job.jobId }, { limit: 1 });
      const row: Record<string, unknown> = { jobId: job.jobId, profileId: job.profileId, job };
      if (rows.length > 0 && rows[0]._id) row._id = rows[0]._id;
      await db.put('importJobs', [row]);
    },
    async remove(jobId: string): Promise<void> {
      const rows = await db.find<Record<string, unknown>>('importJobs', { jobId });
      await db.del('importJobs', rows.map((row) => String(row._id || '')).filter((id) => id !== ''));
    }
  };
}

function isActivePhase(phase: ImportJob['phase']): boolean {
  return phase === 'downloading' || phase === 'parsing' || phase === 'writing' || phase === 'validating' || phase === 'swapping';
}

/* ------------------------------------------------------- consentements */

export function createConsentRepository(db: Db8Client): ConsentRepository {
  return {
    async record(consent: ConsentRecord): Promise<void> {
      const where: Record<string, unknown> = { profileId: consent.profileId, kind: consent.kind };
      if (consent.insecureHost) where.insecureHost = consent.insecureHost;
      const rows = await db.find<Record<string, unknown>>('consents', where, { limit: 1 });
      const row = Object.assign({}, consent) as unknown as Record<string, unknown>;
      if (rows.length > 0 && rows[0]._id) row._id = rows[0]._id;
      await db.put('consents', [row]);
    },
    async list(profileId: string): Promise<ConsentRecord[]> {
      const rows = await db.find<Record<string, unknown>>('consents', { profileId });
      return rows.map((row) => row as unknown as ConsentRecord);
    },
    async has(profileId: string, kind: ConsentRecord['kind'], host?: string): Promise<boolean> {
      const where: Record<string, unknown> = { profileId, kind };
      if (host !== undefined) where.insecureHost = host;
      const rows = await db.find<Record<string, unknown>>('consents', where, { limit: 1 });
      return rows.length > 0;
    },
    async remove(profileId: string): Promise<void> {
      const rows = await db.find<Record<string, unknown>>('consents', { profileId });
      await db.del('consents', rows.map((row) => String(row._id || '')).filter((id) => id !== ''));
    }
  };
}

/* --------------------------------------- favoris, reprises, EPG (V1-B/V1-C) */

export interface FavoriteRepository {
  list(profileId: string): Promise<FavoriteRecord[]>;
  add(record: FavoriteRecord): Promise<void>;
  remove(profileId: string, ref: ContentRef): Promise<void>;
  removeAll(profileId: string): Promise<void>;
}

export interface PlaybackRepository {
  list(profileId: string): Promise<PlaybackPosition[]>;
  save(position: PlaybackPosition): Promise<void>;
  removeAll(profileId: string): Promise<void>;
}

/** Les favoris et reprises sont indexés par `ContentRef` (§5.3), jamais par URL. */
export function createFavoriteRepository(db: Db8Client): FavoriteRepository {
  const keyOf = (ref: ContentRef): string =>
    [ref.profileId, ref.contentType, ref.providerId || ref.sourceKey || '', ref.logicalKey || ''].join('|');
  return {
    async list(profileId: string): Promise<FavoriteRecord[]> {
      const rows = await db.find<Record<string, unknown>>('favorites', { profileId, deleted: false });
      return rows.map((row) => row.record as FavoriteRecord).filter(Boolean);
    },
    async add(record: FavoriteRecord): Promise<void> {
      const key = keyOf(record.ref);
      const rows = await db.find<Record<string, unknown>>('favorites', { key }, { limit: 1 });
      const row: Record<string, unknown> = { key, profileId: record.ref.profileId, record, deleted: false };
      if (rows.length > 0 && rows[0]._id) row._id = rows[0]._id;
      await db.put('favorites', [row]);
    },
    async remove(profileId: string, ref: ContentRef): Promise<void> {
      void profileId;
      const rows = await db.find<Record<string, unknown>>('favorites', { key: keyOf(ref) });
      await db.del('favorites', rows.map((row) => String(row._id || '')).filter((id) => id !== ''));
    },
    async removeAll(profileId: string): Promise<void> {
      const rows = await db.find<Record<string, unknown>>('favorites', { profileId });
      await db.del('favorites', rows.map((row) => String(row._id || '')).filter((id) => id !== ''));
    }
  };
}

export function createPlaybackRepository(db: Db8Client): PlaybackRepository {
  const keyOf = (position: PlaybackPosition): string => [position.profileId, position.ref.contentType, position.ref.providerId || position.ref.sourceKey || ''].join('|');
  return {
    async list(profileId: string): Promise<PlaybackPosition[]> {
      const rows = await db.find<Record<string, unknown>>('playbacks', { profileId });
      return rows.map((row) => row.record as PlaybackPosition).filter(Boolean);
    },
    async save(position: PlaybackPosition): Promise<void> {
      const key = keyOf(position);
      const rows = await db.find<Record<string, unknown>>('playbacks', { key }, { limit: 1 });
      const row: Record<string, unknown> = { key, profileId: position.profileId, record: position };
      if (rows.length > 0 && rows[0]._id) row._id = rows[0]._id;
      await db.put('playbacks', [row]);
    },
    async removeAll(profileId: string): Promise<void> {
      const rows = await db.find<Record<string, unknown>>('playbacks', { profileId });
      await db.del('playbacks', rows.map((row) => String(row._id || '')).filter((id) => id !== ''));
    }
  };
}

/**
 * Suppression de profil (§15.4 `deleteProfile`) : efface **tout** ce que DB8 contient, renvoie la
 * liste des kinds touchés, et laisse à l'appelant la suppression des fichiers d'index et des
 * résolutions en cache. La clé maître disparaît avec le reste : l'ancien index devient illisible.
 */
export interface ProfileDeletionSummary {
  kindsCleared: string[];
  masterKeyRemoved: boolean;
}

export async function deleteProfileData(
  db: Db8Client,
  profileId: string,
  repositories: {
    profiles: ProfileRepository;
    importJobs: ImportJobRepository;
    masterKeys: MasterKeyRepository;
    consents: ConsentRepository;
    favorites: FavoriteRepository;
    playbacks: PlaybackRepository;
  }
): Promise<ProfileDeletionSummary> {
  const kindsCleared: string[] = [];
  await repositories.profiles.remove(profileId);
  kindsCleared.push(kindOf('profiles'));

  const jobs = await db.find<Record<string, unknown>>('importJobs', { profileId });
  await db.del('importJobs', jobs.map((row) => String(row._id || '')).filter((id) => id !== ''));
  kindsCleared.push(kindOf('importJobs'));

  await repositories.favorites.removeAll(profileId);
  kindsCleared.push(kindOf('favorites'));
  await repositories.playbacks.removeAll(profileId);
  kindsCleared.push(kindOf('playbacks'));

  for (const kind of ['epgMappings', 'preferences'] as const) {
    const rows = await db.find<Record<string, unknown>>(kind, { profileId });
    if (rows.length > 0) {
      await db.del(kind, rows.map((row) => String(row._id || '')).filter((id) => id !== ''));
    }
    kindsCleared.push(kindOf(kind));
  }

  const masterKey = await repositories.masterKeys.get(profileId);
  await repositories.masterKeys.remove(profileId);
  kindsCleared.push(kindOf('masterKeys'));

  await repositories.consents.remove(profileId);
  kindsCleared.push(kindOf('consents'));

  return { kindsCleared, masterKeyRemoved: masterKey !== null };
}
