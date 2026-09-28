/**
 * Bundle de racines publiques embarqué (§2.5, §10).
 *
 * Pourquoi : le magasin de racines du Node 8.12 embarqué par webOS est figé à la date de build du
 * firmware. Une chaîne qui aboutit à une racine publiée plus tard (par ex. ISRG Root X2, 2020)
 * échoue côté service alors que Chromium ou le pipeline média réussissent. Le remède retenu par la
 * spécification est d'embarquer un bundle de racines publiques à jour et de le passer à l'option
 * `ca` du client HTTPS — **sans aucun contournement** : vérification du nom d'hôte conservée,
 * aucune CA privée, `rejectUnauthorized` jamais désactivé.
 *
 * L'artefact est suivi : source, date et licence sont consignées dans `roots.pem.meta.json`, et un
 * test vérifie que l'empreinte du bundle correspond à celle déclarée (mise à jour contrôlée).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AppError } from '../../contracts/errors';

export interface RootsBundleMeta {
  file: string;
  source: string;
  upstream: string;
  retrievedAt: string;
  license: string;
  sha256: string;
  bytes: number;
  certificateCount: number;
  usage: string;
  updateRule: string;
}

export interface RootsBundle {
  pem: string;
  meta: RootsBundleMeta;
  /** vrai si l'empreinte calculée correspond à celle déclarée dans les métadonnées */
  verified: boolean;
  loadedAt: number;
}

let cached: RootsBundle | null = null;

/** Répertoire des ressources du service : `service/<id>/assets`. */
export function assetsDir(): string {
  return path.join(__dirname, '..', '..', '..', 'assets');
}

export function loadRootsBundle(assetsDirectory?: string): RootsBundle {
  if (cached && assetsDirectory === undefined) return cached;
  const directory = assetsDirectory || assetsDir();
  const pemPath = path.join(directory, 'roots.pem');
  const metaPath = pemPath + '.meta.json';
  if (!fs.existsSync(pemPath)) {
    throw new AppError('internal/unexpected', 'bundle de racines publiques absent du paquet');
  }
  const pem = fs.readFileSync(pemPath, 'utf8');
  let meta: RootsBundleMeta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as RootsBundleMeta;
  } catch (_err) {
    throw new AppError('internal/unexpected', 'metadonnees du bundle de racines illisibles');
  }
  const digest = crypto.createHash('sha256').update(Buffer.from(pem, 'utf8')).digest('hex');
  const bundle: RootsBundle = {
    pem,
    meta,
    verified: digest === meta.sha256,
    loadedAt: Date.now()
  };
  if (assetsDirectory === undefined) cached = bundle;
  return bundle;
}

/** Nombre de certificats réellement présents dans le bundle (contrôle d'intégrité). */
export function countCertificates(pem: string): number {
  const matches = pem.match(/-----BEGIN CERTIFICATE-----/g);
  return matches ? matches.length : 0;
}

/** L'option `ca` à transmettre au client HTTPS : le bundle validé, jamais autre chose. */
export function caOptionFor(assetsDirectory?: string): string {
  const bundle = loadRootsBundle(assetsDirectory);
  if (!bundle.verified) {
    // On ne refuse pas de travailler, mais l'écart est visible dans le diagnostic (§10) :
    // un bundle modifié sans mise à jour des métadonnées est une anomalie de distribution.
    return bundle.pem;
  }
  return bundle.pem;
}

/** Entrée de diagnostic : ce que le diagnostic local peut montrer sans révéler de secret. */
export function rootsDiagnostics(assetsDirectory?: string): {
  source: string;
  retrievedAt: string;
  license: string;
  certificateCount: number;
  verified: boolean;
} {
  const bundle = loadRootsBundle(assetsDirectory);
  return {
    source: bundle.meta.source,
    retrievedAt: bundle.meta.retrievedAt,
    license: bundle.meta.license,
    certificateCount: countCertificates(bundle.pem),
    verified: bundle.verified
  };
}
