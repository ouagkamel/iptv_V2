/**
 * Manifeste d'index (§15.2) et bascule atomique (§2.4).
 *
 * Le manifeste est le **seul** fichier non chiffré : il ne contient aucun titre, aucune URL et
 * aucun identifiant — uniquement la structure (version, compteurs, tailles de blocs, état,
 * tranches alphabétiques agrégées). Il est écrit par `temp + fsync + rename`, jamais en place.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BucketSet, ContentType } from '../../contracts/types';
import { AppError } from '../../contracts/errors';
import { FILE_KINDS } from './constants';
import type { FileKind } from './constants';

export interface IndexManifest {
  profileId: string;
  contentType: ContentType;
  indexVersion: number;
  entryCount: number;
  recordSize: number;
  inlineSize: number;
  titleSparseStride: number;
  /** octets de clé par entrée éparse (8 normatifs + extension de discrimination) */
  titleSparseKeyBytes: number;
  searchIndexKind: 'title' | 'title+tokens';
  scriptBuckets: BucketSet;
  state: 'building' | 'valid';
  createdAt: number;
  /** empreintes de schéma par fichier (portées aussi par l'en-tête chiffré) */
  schemaHashes: Record<FileKind, number>;
  /** nombre de blocs écrits par fichier (diagnostic et vérification de troncature) */
  blockCounts: Record<FileKind, number>;
  etag?: string;
}

export interface ManifestLocation {
  /** répertoire du profil + type de contenu, contenant `manifest.json` et `index-v<N>/` */
  baseDir: string;
}

export function manifestPath(baseDir: string): string {
  return path.join(baseDir, 'manifest.json');
}

export function previousManifestPath(baseDir: string): string {
  return path.join(baseDir, 'manifest.prev.json');
}

export function indexDir(baseDir: string, indexVersion: number): string {
  return path.join(baseDir, 'index-v' + indexVersion);
}

export function stagingDir(baseDir: string, indexVersion: number): string {
  return path.join(baseDir, 'index-v' + indexVersion + '.tmp');
}

export function filePathFor(baseDir: string, indexVersion: number, kind: FileKind): string {
  switch (kind) {
    case 'records':
      return path.join(indexDir(baseDir, indexVersion), 'records.bin');
    case 'payload':
      return path.join(indexDir(baseDir, indexVersion), 'payload.bin');
    case 'title':
      return path.join(indexDir(baseDir, indexVersion), 'title.idx');
    case 'buckets':
      return path.join(indexDir(baseDir, indexVersion), 'buckets.idx');
    case 'groups':
      return path.join(indexDir(baseDir, indexVersion), 'groups.bin');
  }
}

/** Écriture atomique d'un JSON : fichier temporaire, `fsync`, `rename`. */
export function writeJsonAtomic(targetPath: string, value: unknown): void {
  const tmpPath = targetPath + '.tmp-' + process.pid;
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, payload, 0, payload.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, targetPath);
  const dirFd = fs.openSync(path.dirname(targetPath), 'r');
  try {
    // certaines plateformes (webOS) n'exposent pas fsync sur un descripteur de répertoire
    try {
      fs.fsyncSync(dirFd);
    } catch (_err) {
      /* accepté : le rename reste atomique */
    }
  } finally {
    fs.closeSync(dirFd);
  }
}

export function readManifest(baseDir: string): IndexManifest | null {
  const file = manifestPath(baseDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as IndexManifest;
  } catch (_err) {
    throw new AppError('catalog/corrupt', 'manifeste d index illisible');
  }
}

export function readPreviousManifest(baseDir: string): IndexManifest | null {
  const file = previousManifestPath(baseDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as IndexManifest;
  } catch (_err) {
    return null;
  }
}

/**
 * Bascule atomique : le nouveau manifeste remplace l'ancien en une seule opération.
 * L'ancien manifeste est conservé à part pendant la rétention (§2.4, valeur de départ 30 s),
 * ce qui permet à un lecteur déjà ouvert de terminer sa page avant `catalog/indexChanged`.
 */
export function commitManifest(baseDir: string, manifest: IndexManifest): void {
  const current = readManifest(baseDir);
  if (current) writeJsonAtomic(previousManifestPath(baseDir), current);
  writeJsonAtomic(manifestPath(baseDir), manifest);
}

/** Supprime les répertoires temporaires orphelins et les versions non élues (§2.4). */
export function pruneOrphans(baseDir: string, keepVersions: number[]): string[] {
  const removed: string[] = [];
  if (!fs.existsSync(baseDir)) return removed;
  const entries = fs.readdirSync(baseDir);
  for (const name of entries) {
    const full = path.join(baseDir, name);
    if (name.indexOf('.tmp') !== -1) {
      removeDirRecursive(full);
      removed.push(name);
      continue;
    }
    const match = /^index-v(\d+)$/.exec(name);
    if (match && keepVersions.indexOf(parseInt(match[1], 10)) === -1) {
      if (isRetentionActive(baseDir)) continue;
      removeDirRecursive(full);
      removed.push(name);
    }
  }
  return removed;
}

/** Rétention bornée : vrai tant que l'ancien manifeste doit rester lisible. */
export function isRetentionActive(baseDir: string, now: number = Date.now()): boolean {
  const previous = readPreviousManifest(baseDir);
  if (!previous) return false;
  const swappedAtFile = path.join(baseDir, '.swap-timestamp');
  if (!fs.existsSync(swappedAtFile)) return false;
  try {
    const swappedAt = parseInt(fs.readFileSync(swappedAtFile, 'utf8'), 10);
    return now - swappedAt < PREVIOUS_INDEX_RETENTION_MS_VALUE;
  } catch (_err) {
    return false;
  }
}

const PREVIOUS_INDEX_RETENTION_MS_VALUE = 30000;

export function markSwapTimestamp(baseDir: string, now: number = Date.now()): void {
  writeJsonAtomic(path.join(baseDir, '.swap-timestamp'), now);
}

export function removeDirRecursive(target: string): void {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }
  for (const name of fs.readdirSync(target)) {
    removeDirRecursive(path.join(target, name));
  }
  fs.rmdirSync(target);
}

/** Nettoyage d'un profil supprimé : index, temporaires et résolutions en cache (§15.4). */
export function deleteProfileFiles(profileRoot: string): void {
  removeDirRecursive(profileRoot);
}

export const ALL_FILE_KINDS = FILE_KINDS;
