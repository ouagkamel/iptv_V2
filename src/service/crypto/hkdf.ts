/**
 * HKDF-SHA256 implémenté à la main (RFC 5869).
 *
 * Pourquoi : `crypto.hkdf` n'existe qu'à partir de Node 15, or le service tourne sur le Node 8.12
 * embarqué de webOS 6 (§2.3). L'implémentation est explicitement autorisée par §8.2/§15.3 et
 * couverte par les vecteurs de test RFC 5869 (cas 1 à 3) en CI.
 *
 * Zéro dépendance : seuls `crypto.createHmac('sha256', …)` et des Buffers sont utilisés.
 */

import * as crypto from 'crypto';

const HASH_LEN = 32;
const MAX_EXPAND_BLOCKS = 255;

export function hmacSha256(key: Buffer, data: Buffer): Buffer {
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(data);
  return hmac.digest();
}

/** HKDF-Extract(salt, ikm) → PRK (32 octets). Un salt vide devient 32 zéros (RFC 5869 §2.2). */
export function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  const effectiveSalt = salt.length === 0 ? Buffer.alloc(HASH_LEN, 0) : salt;
  return hmacSha256(effectiveSalt, ikm);
}

/** HKDF-Expand(prk, info, length). Lève si `length` dépasse 255 × 32 octets. */
export function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  if (length < 0 || length > MAX_EXPAND_BLOCKS * HASH_LEN) {
    throw new Error('hkdf: longueur demandee hors bornes');
  }
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  let counter = 1;
  let produced = 0;
  while (produced < length) {
    const input = Buffer.concat([previous, info, Buffer.from([counter])]);
    previous = hmacSha256(prk, input);
    blocks.push(previous);
    produced += previous.length;
    counter += 1;
  }
  return Buffer.concat(blocks).slice(0, length);
}

/** HKDF complet (Extract puis Expand), utilitaire. */
export function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return hkdfExpand(hkdfExtract(salt, ikm), info, length);
}
