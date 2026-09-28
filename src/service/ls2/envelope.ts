/**
 * Enveloppe LS2 unique (§15.4).
 *
 * Toutes les commandes répondent la même forme :
 *   `{ returnValue, indexVersion?, data?, error? }`
 * et aucune réponse ne transporte de secret — sauf `resolveStream`, dont l'**objet même** est l'URL
 * de lecture (donnée de session) : c'est la seule exception, explicitement autorisée par §6.1.
 *
 * Les plafonds du §15.2 (≤ 200 objets ET ≤ 256 Kio) sont vérifiés ici, après construction de la
 * page : une page qui dépasserait la limite est refusée, jamais envoyée « pour finir ».
 */

import { AppError, toShape } from '../../contracts/errors';
import type { Ls2Reply } from '../../contracts/types';

export const MAX_PAGE_OBJECTS = 200;
export const MAX_PAGE_BYTES = 256 * 1024;
export const MAX_DETAIL_BYTES = 32 * 1024;

export function ls2Ok<T>(data: T, indexVersion?: number): Ls2Reply<T> {
  const reply: Ls2Reply<T> = { returnValue: true, data };
  if (indexVersion !== undefined) reply.indexVersion = indexVersion;
  return reply;
}

export function ls2Fail(error: unknown, indexVersion?: number): Ls2Reply<never> {
  const reply: Ls2Reply<never> = { returnValue: false, error: toShape(error) };
  if (indexVersion !== undefined) reply.indexVersion = indexVersion;
  return reply;
}

export function ls2FailCode(code: AppError['code'], message: string, hint?: string): Ls2Reply<never> {
  return ls2Fail(new AppError(code, message, hint));
}

/** Taille UTF-8 sérialisée d'une réponse (mesure utile au diagnostic : champ `bytes`, sans contenu). */
export function replyBytes(reply: unknown): number {
  return Buffer.byteLength(JSON.stringify(reply === undefined ? null : reply), 'utf8');
}

export interface ReplyLimits {
  maxObjects?: number;
  maxBytes?: number;
  /** seul `resolveStream` peut transporter une URL de flux */
  allowStreamUrl?: boolean;
}

/**
 * Vérifie qu'une réponse respecte les plafonds et ne contient **aucun secret** transitant hors du
 * contrat. Lève si c'est le cas : mieux vaut une erreur explicite qu'une fuite silencieuse.
 */
export function assertReplySafe(reply: unknown, limits: ReplyLimits = {}): void {
  const bytes = replyBytes(reply);
  const maxBytes = limits.maxBytes === undefined ? MAX_PAGE_BYTES : limits.maxBytes;
  if (bytes > maxBytes) {
    throw new AppError('internal/unexpected', 'reponse LS2 au-dela du plafond d octets (' + bytes + ' octets)');
  }
  if (!limits.allowStreamUrl) {
    const serialized = JSON.stringify(reply === undefined ? null : reply) || '';
    const violations = findSecretPatterns(serialized);
    if (violations.length > 0) {
      throw new AppError(
        'internal/unexpected',
        'reponse LS2 contenant un element interdit (' + violations.join(', ') + ')'
      );
    }
  }
}

/**
 * URL présentes dans une réponse : logos, affiches, icônes EPG. Ce sont des **données** du catalogue,
 * pas des secrets, et leurs chemins portent souvent des identifiants longs et aléatoires.
 */
const URL_DANS_TEXTE = /\bhttps?:\/\/[^\s"'\\]+/gi;

/**
 * Motifs interdits hors `resolveStream` : identifiants d'URL, segments longs, clé de chiffrement.
 *
 * La règle « segment base64 long » vise les **secrets hors URL** (clé de chiffrement, jeton recopié
 * dans un champ texte). Elle est appliquée après retrait des URL : un logo réel du type
 * `https://images.pluto.tv/channels/64bab8ba5dc1660008969b5a/colorLogoPNG.png` contient sinon une
 * suite de plus de 40 caractères de classe base64 et faisait refuser **toute la page** par le service
 * (défaut constaté en phase 0A sur un catalogue réel) ; les secrets portés par une URL restent
 * couverts par les règles `userinfo`, `identifiant en requete` et `URL de flux`.
 */
export function findSecretPatterns(serialized: string): string[] {
  const found: string[] = [];
  if (/:\/\/[^/\s"']+:[^/\s"']+@/.test(serialized)) found.push('userinfo');
  if (/[?&](username|password|token|token2|user|pass|api_?key|auth|key)=/i.test(serialized)) found.push('identifiant en requete');
  const horsUrls = serialized.replace(URL_DANS_TEXTE, ' ');
  if (/\b(?:[A-Za-z0-9+/]{40,}={0,2})\b/.test(horsUrls)) found.push('segment base64 long');
  if (/"streamUrl"|"url"|"direct_source"/.test(serialized) && /:\/\/[^/\s"']+\/(?:live|movie|series)\//i.test(serialized)) {
    found.push('URL de flux');
  }
  if (/"masterKey"|"key"\s*:\s*"[A-Za-z0-9+/=]{20,}"/.test(serialized)) found.push('cle de chiffrement');
  return found;
}

/** Compte les objets d'une page renvoyée (contrôle du plafond « ≤ 200 objets »). */
export function assertObjectCap(items: unknown[], maxObjects: number = MAX_PAGE_OBJECTS): void {
  if (items.length > maxObjects) {
    throw new AppError('internal/unexpected', 'page au-dela du plafond d objets (' + items.length + ')');
  }
}
