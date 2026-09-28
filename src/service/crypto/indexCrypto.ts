/**
 * Format de fichier chiffré de l'index (§15.3) — correction des deux défauts P0 de la v1.2.
 *
 * En-tête en clair (32 octets), authentifié par l'AAD :
 *   u8[8]  magic            "IPTVCI1\0"
 *   u8     formatVersion     = 1
 *   u8     contentType
 *   u32    indexVersion
 *   u32    blockSize         = 4096
 *   u32    blockCount
 *   u32    schemaHash
 *   u8[6]  réservé (alignement sur 32 octets : 8+1+1+4+4+4+4 = 26)
 *
 * Bloc b : offset fixe `headerSize + b × (blockSize + 16)`, 4096 octets de cryptogramme puis
 * 16 octets de tag GCM. La longueur réelle du clair est stockée sur les 4 premiers octets du
 * clair ; le remplissage est ignoré à la relecture (pas de fuite de longueur au-delà du bloc).
 *
 * Dérivation (§15.3), une clé **par (indexVersion, contentType)** :
 *   prk      = HKDF-Extract(salt = profileIdHash ‖ u32be(indexVersion) ‖ contentType ‖ u32be(fileKind), ikm = masterKey)
 *   indexKey = HKDF-Expand(prk, info = "iptv/index-key/v1", L = 32)
 *   nonce(b) = HKDF-Extract(salt = u32be(b), ikm = prk) puis HKDF-Expand(…, info = "iptv/nonce/v1", L = 12)
 *   aad(b)   = magic ‖ profileIdHash ‖ contentType ‖ u32be(indexVersion) ‖ u32be(b) ‖ schemaHash
 *
 * Lecture de la ligne `nonce(b) = HKDF-Expand(prk, info = "iptv/nonce/v1", salt = u32be(b), L = 12)` :
 * RFC 5869 ne définit pas de paramètre `salt` sur Expand. L'interprétation retenue — et testée —
 * est Extract avec ce salt puis Expand, seule lecture cohérente avec la RFC. Deux versions
 * successives d'index n'utilisent jamais la même clé, donc `nonce = f(b)` ne peut pas se répéter
 * sous une même clé.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import { AppError } from '../../contracts/errors';
import { hkdfExpand, hkdfExtract, hmacSha256 } from './hkdf';

export const MAGIC = Buffer.from('IPTVCI1\u0000', 'latin1');
export const FORMAT_VERSION = 1;
export const BLOCK_SIZE = 4096;
export const TAG_LEN = 16;
export const HEADER_SIZE = 32;
export const RESERVED_HEADER_BYTES = HEADER_SIZE - (8 + 1 + 1 + 4 + 4 + 4 + 4);

export const CONTENT_TYPE_CODE: Record<string, number> = {
  live: 1,
  vod: 2,
  series: 3,
  episode: 4
};

export const CONTENT_TYPE_NAME: Record<number, string> = {
  1: 'live',
  2: 'vod',
  3: 'series',
  4: 'episode'
};

/** Empreinte non réversible de l'identifiant de profil (8 octets). */
export function profileIdHash(profileId: string): Buffer {
  return crypto.createHash('sha256').update('iptv/profile/' + profileId).digest().slice(0, 8);
}

/** Empreinte du schéma d'enregistrement, portée par l'en-tête et l'AAD. */
export function schemaHash(schemaDescriptor: string): number {
  const digest = crypto.createHash('sha256').update(schemaDescriptor).digest();
  return digest.readUInt32BE(0);
}

export interface IndexKeyParams {
  masterKey: Buffer;
  profileId: string;
  contentType: string;
  indexVersion: number;
  schemaHash: number;
  /**
   * Discriminant de fichier (`records`, `payload`, `title`, `buckets`, `groups`).
   *
   * Écart assumé et motivé par rapport à la formule littérale du §15.3 : sans ce discriminant,
   * deux fichiers du même `(profil, indexVersion, contentType)` dériveraient **la même clé et les
   * mêmes nonces**, ce qui rouvrirait exactement le défaut P0 (réutilisation du couple
   * (clé, nonce)) au niveau inter-fichiers. Le discriminant entre dans le **sel** de dérivation ;
   * l'AAD reste exactement celle du contrat. Un test vérifie que deux fichiers ne partagent ni clé
   * ni nonce et qu'un bloc déplacé d'un fichier à l'autre échoue à l'authentification.
   */
  fileKind: string;
}

export interface DerivedKeys {
  indexKey: Buffer;
  profileIdDigest: Buffer;
  contentTypeCode: number;
}

/** Identifiant numérique du type de fichier, porté par le sel de dérivation. */
export function fileKindCode(fileKind: string): number {
  const digest = crypto.createHash('sha256').update('iptv/file-kind/' + fileKind).digest();
  return digest.readUInt32BE(0);
}

function derivationSalt(params: IndexKeyParams, contentTypeCode: number): Buffer {
  return Buffer.concat([
    profileIdHash(params.profileId),
    u32be(params.indexVersion),
    Buffer.from([contentTypeCode]),
    u32be(fileKindCode(params.fileKind))
  ]);
}

/** `indexKey` dépend de (indexVersion, contentType, fileKind) : jamais réutilisée entre deux index. */
export function deriveIndexKey(params: IndexKeyParams): DerivedKeys {
  const contentTypeCode = CONTENT_TYPE_CODE[params.contentType];
  if (contentTypeCode === undefined) throw new AppError('catalog/corrupt', 'contentType inconnu pour la derivation de cle');
  if (params.masterKey.length !== 32) throw new AppError('catalog/corrupt', 'cle maitre de taille invalide');
  const saltParts = [
    profileIdHash(params.profileId),
    u32be(params.indexVersion),
    Buffer.from([contentTypeCode])
  ];
  const prk = hkdfExtract(derivationSalt(params, contentTypeCode), params.masterKey);
  const indexKey = hkdfExpand(prk, Buffer.from('iptv/index-key/v1', 'utf8'), 32);
  return { indexKey, profileIdDigest: saltParts[0], contentTypeCode };
}

/** nonce(b) = Expand(Extract(salt = u32be(b), ikm = prk), "iptv/nonce/v1", 12). */
export function deriveNonce(params: IndexKeyParams, blockIndex: number): Buffer {
  const contentTypeCode = CONTENT_TYPE_CODE[params.contentType];
  if (contentTypeCode === undefined) throw new AppError('catalog/corrupt', 'contentType inconnu pour la derivation de nonce');
  const prk = hkdfExtract(derivationSalt(params, contentTypeCode), params.masterKey);
  const noncePrk = hkdfExtract(u32be(blockIndex), prk);
  return hkdfExpand(noncePrk, Buffer.from('iptv/nonce/v1', 'utf8'), 12);
}

export function buildAad(params: IndexKeyParams, blockIndex: number): Buffer {
  return Buffer.concat([
    MAGIC,
    profileIdHash(params.profileId),
    Buffer.from([CONTENT_TYPE_CODE[params.contentType]]),
    u32be(params.indexVersion),
    u32be(blockIndex),
    u32be(params.schemaHash)
  ]);
}

export function u32be(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0, 0);
  return buf;
}

export function buildHeader(params: IndexKeyParams, blockCount: number): Buffer {
  const header = Buffer.alloc(HEADER_SIZE, 0);
  MAGIC.copy(header, 0);
  header.writeUInt8(FORMAT_VERSION, 8);
  header.writeUInt8(CONTENT_TYPE_CODE[params.contentType], 9);
  header.writeUInt32BE(params.indexVersion >>> 0, 10);
  header.writeUInt32BE(BLOCK_SIZE, 14);
  header.writeUInt32BE(blockCount >>> 0, 18);
  header.writeUInt32BE(params.schemaHash >>> 0, 22);
  // octets 26..31 réservés (alignement 32 octets)
  return header;
}

export interface HeaderInfo {
  formatVersion: number;
  contentType: string;
  indexVersion: number;
  blockSize: number;
  blockCount: number;
  schemaHash: number;
}

export function parseHeader(header: Buffer): HeaderInfo {
  if (header.length < HEADER_SIZE) throw new AppError('catalog/corrupt', 'en-tete d index tronque');
  if (!header.slice(0, 8).equals(MAGIC)) throw new AppError('catalog/corrupt', 'magic d index invalide');
  const formatVersion = header.readUInt8(8);
  if (formatVersion !== FORMAT_VERSION) throw new AppError('catalog/corrupt', 'version de format non supportee');
  const contentTypeCode = header.readUInt8(9);
  const contentType = CONTENT_TYPE_NAME[contentTypeCode];
  if (!contentType) throw new AppError('catalog/corrupt', 'contentType inconnu dans l en-tete');
  return {
    formatVersion,
    contentType,
    indexVersion: header.readUInt32BE(10),
    blockSize: header.readUInt32BE(14),
    blockCount: header.readUInt32BE(18),
    schemaHash: header.readUInt32BE(22)
  };
}

/** Chiffre un bloc déjà complété à `BLOCK_SIZE` (le préfixe de 4 octets porte la longueur réelle). */
export function encryptBlock(payload: Buffer, params: IndexKeyParams, blockIndex: number): Buffer {
  if (payload.length !== BLOCK_SIZE) {
    throw new AppError('catalog/corrupt', 'bloc interne de taille invalide');
  }
  const key = deriveIndexKey(params).indexKey;
  const nonce = deriveNonce(params, blockIndex);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(buildAad(params, blockIndex));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ciphertext, tag]);
}

/** Déchiffre le bloc `blockIndex` d'un fichier complet tenu en mémoire (usage tests/petits index). */
export function decryptBlock(file: Buffer, blockIndex: number, params: IndexKeyParams): Buffer {
  const header = parseHeader(file.slice(0, HEADER_SIZE));
  if (header.contentType !== params.contentType) {
    throw new AppError('catalog/indexChanged', 'bloc appartenant a un autre contentType');
  }
  if (header.indexVersion !== params.indexVersion) {
    throw new AppError('catalog/indexChanged', 'bloc appartenant a une autre version d index');
  }
  if (header.schemaHash !== params.schemaHash) {
    throw new AppError('catalog/corrupt', 'schema d enregistrement different');
  }
  if (blockIndex < 0 || blockIndex >= header.blockCount) {
    throw new AppError('catalog/corrupt', 'indice de bloc hors bornes');
  }
  const offset = HEADER_SIZE + blockIndex * (BLOCK_SIZE + TAG_LEN);
  const ciphertext = file.slice(offset, offset + BLOCK_SIZE);
  const tag = file.slice(offset + BLOCK_SIZE, offset + BLOCK_SIZE + TAG_LEN);
  return openGcm(ciphertext, tag, params, blockIndex, header.blockSize);
}

function openGcm(
  ciphertext: Buffer,
  tag: Buffer,
  params: IndexKeyParams,
  blockIndex: number,
  blockSize: number
): Buffer {
  const key = deriveIndexKey(params).indexKey;
  const nonce = deriveNonce(params, blockIndex);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(buildAad(params, blockIndex));
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new AppError('catalog/corrupt', 'authentification d un bloc d index en echec');
  }
  const realLength = plaintext.readUInt32BE(0);
  if (realLength > blockSize) throw new AppError('catalog/corrupt', 'longueur de bloc incoherente');
  // le remplissage n'est pas renvoyé : pas de fuite de longueur
  return plaintext.slice(4, 4 + realLength);
}

/** Chiffre un contenu complet en mémoire, par blocs de 4096 (utilisé par les tests et la CI). */
export function encryptContent(content: Buffer, params: IndexKeyParams): Buffer {
  const blockCount = Math.max(1, Math.ceil(content.length / BLOCK_SIZE));
  const chunks: Buffer[] = [buildHeader(params, blockCount)];
  for (let b = 0; b < blockCount; b++) {
    const slice = content.slice(b * BLOCK_SIZE, Math.min((b + 1) * BLOCK_SIZE, content.length));
    chunks.push(encryptBlock(padBlock(slice), params, b));
  }
  return Buffer.concat(chunks);
}

function padBlock(slice: Buffer): Buffer {
  const padded = Buffer.alloc(BLOCK_SIZE, 0);
  padded.writeUInt32BE(slice.length, 0);
  slice.copy(padded, 4);
  return padded;
}

/* --------------------------------------------------------------- accès fichier */

interface FileCryptoOptions {
  params: IndexKeyParams;
  fsImpl?: typeof fs;
}

/**
 * Écrivain en flux : l'en-tête est réservé, les blocs sont écrits séquentiellement puis
 * `finish()` renseigne `blockCount` (l'en-tête n'est pas chiffré, il est patché en place).
 * Le pic mémoire reste borné à un bloc + le tampon d'appel.
 */
export class BlockFileWriter {
  private readonly fd: number;
  private readonly buffer: Buffer;
  private used = 0;
  private blockIndex = 0;
  private closed = false;

  /**
   * `append: true` rouvre un fichier existant **à la suite** du dernier bloc complet (reprise
   * d'import, §15.5). L'en-tête est relu pour connaître le nombre de blocs déjà écrits, puis
   * réécrit à la fin avec la nouvelle valeur : aucune écriture partielle n'est exposée.
   */
  constructor(filePath: string, private readonly options: FileCryptoOptions, append = false) {
    const fsImpl = options.fsImpl || fs;
    if (append) {
      this.fd = fsImpl.openSync(filePath, 'r+');
      const header = Buffer.alloc(HEADER_SIZE);
      const read = fsImpl.readSync(this.fd, header, 0, HEADER_SIZE, 0);
      if (read !== HEADER_SIZE) throw new AppError('catalog/corrupt', 'fichier d index tronque (en-tete)');
      this.blockIndex = parseHeader(header).blockCount;
    } else {
      this.fd = fsImpl.openSync(filePath, 'w');
      this.blockIndex = 0;
      fsImpl.writeSync(this.fd, buildHeader(options.params, 0), 0, HEADER_SIZE, 0);
    }
    this.buffer = Buffer.alloc(BLOCK_SIZE, 0);
  }

  get blocksWritten(): number {
    return this.blockIndex;
  }

  /** Blocs déjà présents dans le fichier (mode ajout compris). */
  get blockCount(): number {
    return this.blockIndex;
  }

  write(chunk: Buffer): void {
    if (this.closed) throw new AppError('internal/unexpected', 'ecriture sur un index deja ferme');
    let offset = 0;
    while (offset < chunk.length) {
      const space = BLOCK_SIZE - 4 - this.used; // 4 octets de longueur en tete de clair
      const take = Math.min(space, chunk.length - offset);
      chunk.copy(this.buffer, 4 + this.used, offset, offset + take);
      this.used += take;
      offset += take;
      if (this.used === BLOCK_SIZE - 4) this.flushBlock();
    }
  }

  private flushBlock(): void {
    const padded = Buffer.alloc(BLOCK_SIZE, 0);
    this.buffer.copy(padded, 0, 0, 4 + this.used);
    padded.writeUInt32BE(this.used, 0);
    const record = encryptBlock(padded, this.options.params, this.blockIndex);
    const fsImpl = this.options.fsImpl || fs;
    fsImpl.writeSync(
      this.fd,
      record,
      0,
      record.length,
      HEADER_SIZE + this.blockIndex * (BLOCK_SIZE + TAG_LEN)
    );
    this.blockIndex += 1;
    this.buffer.fill(0);
    this.used = 0;
  }

  finish(): { blockCount: number } {
    return this.seal();
  }

  /**
   * Scelle le fichier : le bloc en cours est écrit, l'en-tête est mis à jour avec le nombre de blocs
   * réellement valides, puis le descripteur est fermé. Un fichier **scellé** se relit en mode ajout
   * (reprise d'import, §15.5) ; un fichier laissé ouvert ne serait pas relisible.
   */
  seal(options?: { padLastBlock?: boolean }): { blockCount: number } {
    if (this.closed) return { blockCount: this.blockIndex };
    if (options && options.padLastBlock && this.used > 0 && this.used < USABLE_BLOCK_BYTES) {
      // Le bloc partiel est complété **par des zéros écrits comme données** : le fichier se termine
      // alors sur une frontière de bloc, ce qui rend l'ajout possible sans réutiliser un couple
      // (clé, nonce) — réécrire un bloc scellé serait une faute cryptographique (§15.3).
      this.used = USABLE_BLOCK_BYTES;
    }
    if (this.used > 0 || this.blockIndex === 0) this.flushBlock();
    const fsImpl = this.options.fsImpl || fs;
    const header = buildHeader(this.options.params, this.blockIndex);
    fsImpl.writeSync(this.fd, header, 0, HEADER_SIZE, 0);
    fsImpl.fsyncSync(this.fd);
    fsImpl.closeSync(this.fd);
    this.closed = true;
    return { blockCount: this.blockIndex };
  }

  abort(): void {
    if (this.closed) return;
    const fsImpl = this.options.fsImpl || fs;
    try {
      fsImpl.closeSync(this.fd);
    } catch (_err) {
      /* fermeture best-effort */
    }
    this.closed = true;
  }
}

/** Lecteur à accès aléatoire : un bloc = une lecture disque de taille fixe, un déchiffrement. */
export class BlockFileReader {
  private readonly fsImpl: typeof fs;
  readonly header: HeaderInfo;
  private fd: number | null;

  constructor(private readonly filePath: string, private readonly options: FileCryptoOptions) {
    this.fsImpl = options.fsImpl || fs;
    this.fd = this.fsImpl.openSync(filePath, 'r');
    const headerBuf = Buffer.alloc(HEADER_SIZE);
    this.fsImpl.readSync(this.fd, headerBuf, 0, HEADER_SIZE, 0);
    this.header = parseHeader(headerBuf);
    if (this.header.blockSize !== BLOCK_SIZE) {
      throw new AppError('catalog/corrupt', 'taille de bloc non supportee par ce lecteur');
    }
    if (this.header.contentType !== options.params.contentType) {
      throw new AppError('catalog/indexChanged', 'index d un autre contentType');
    }
    if (this.header.indexVersion !== options.params.indexVersion) {
      throw new AppError('catalog/indexChanged', 'index d une autre version');
    }
  }

  readBlock(blockIndex: number): Buffer {
    if (this.fd === null) throw new AppError('catalog/corrupt', 'lecteur d index ferme');
    if (blockIndex < 0 || blockIndex >= this.header.blockCount) {
      throw new AppError('catalog/corrupt', 'indice de bloc hors bornes');
    }
    const offset = HEADER_SIZE + blockIndex * (BLOCK_SIZE + TAG_LEN);
    const record = Buffer.alloc(BLOCK_SIZE + TAG_LEN);
    const read = this.fsImpl.readSync(this.fd, record, 0, record.length, offset);
    if (read !== record.length) throw new AppError('catalog/corrupt', 'bloc d index tronque');
    const ciphertext = record.slice(0, BLOCK_SIZE);
    const tag = record.slice(BLOCK_SIZE);
    return openGcm(ciphertext, tag, this.options.params, blockIndex, this.header.blockSize);
  }

  close(): void {
    if (this.fd === null) return;
    try {
      this.fsImpl.closeSync(this.fd);
    } finally {
      this.fd = null;
    }
  }
}

/** Empreinte HMAC-SHA256 tronquée, utilisée pour `variantKey` (§5.3) et les vérifications. */
export function hmacTruncated(key: Buffer, data: string, bytes: number): string {
  return hmacSha256(key, Buffer.from(data, 'utf8')).slice(0, bytes).toString('hex');
}

/** Octets utiles d'un bloc : 4096 moins les 4 octets de longueur réelle en tête de clair. */
export const USABLE_BLOCK_BYTES = BLOCK_SIZE - 4;

/**
 * Lecture par plage sur un fichier chiffré à blocs de taille fixe, avec **un seul bloc en mémoire**
 * (§15.2 : « n'en garde qu'un en mémoire à la fois »). Sert à l'accès aléatoire aux enregistrements
 * (offsets calculés) et aux charges variables de `payload.bin`.
 */
export class BlockFileRandomReader {
  private readonly fsImpl: typeof fs;
  private fd: number | null;
  private cachedBlockIndex = -1;
  private cachedPlaintext: Buffer | null = null;
  /** Nombre de déchiffrements effectués : exposé au diagnostic et utilisé par les tests de budget. */
  blocksRead = 0;

  constructor(private readonly filePath: string, private readonly options: FileCryptoOptions) {
    this.fsImpl = options.fsImpl || fs;
    this.fd = this.fsImpl.openSync(filePath, 'r');
    const headerBuf = Buffer.alloc(HEADER_SIZE);
    this.fsImpl.readSync(this.fd, headerBuf, 0, HEADER_SIZE, 0);
    this.header = parseHeader(headerBuf);
    if (this.header.blockSize !== BLOCK_SIZE) {
      throw new AppError('catalog/corrupt', 'taille de bloc non supportee par ce lecteur');
    }
    if (this.header.contentType !== options.params.contentType) {
      throw new AppError('catalog/indexChanged', 'fichier d un autre contentType');
    }
    if (this.header.indexVersion !== options.params.indexVersion) {
      throw new AppError('catalog/indexChanged', 'fichier d une autre version d index');
    }
  }

  readonly header: HeaderInfo;

  /**
   * Longueur réelle des données écrites : les blocs sont complétés par du remplissage, donc
   * `blockCount × 4092` surestime la fin du fichier. Utilisé par la reprise d'import pour ne pas
   * lire au-delà de ce qui a été scellé.
   */
  get dataLength(): number {
    if (this.header.blockCount === 0) return 0;
    const last = this.block(this.header.blockCount - 1);
    return (this.header.blockCount - 1) * USABLE_BLOCK_BYTES + last.length;
  }

  readRange(offset: number, length: number): Buffer {
    if (length === 0) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let remaining = length;
    let cursor = offset;
    while (remaining > 0) {
      const blockIndex = Math.floor(cursor / USABLE_BLOCK_BYTES);
      const inner = cursor % USABLE_BLOCK_BYTES;
      const block = this.block(blockIndex);
      const take = Math.min(remaining, block.length - inner);
      if (take <= 0) throw new AppError('catalog/corrupt', 'plage demandee hors des donnees');
      chunks.push(block.slice(inner, inner + take));
      remaining -= take;
      cursor += take;
    }
    return Buffer.concat(chunks);
  }

  private block(blockIndex: number): Buffer {
    if (this.cachedBlockIndex === blockIndex && this.cachedPlaintext !== null) return this.cachedPlaintext;
    if (this.fd === null) throw new AppError('catalog/corrupt', 'lecteur ferme');
    if (blockIndex < 0 || blockIndex >= this.header.blockCount) {
      throw new AppError('catalog/corrupt', 'indice de bloc hors bornes');
    }
    const diskOffset = HEADER_SIZE + blockIndex * (BLOCK_SIZE + TAG_LEN);
    const record = Buffer.alloc(BLOCK_SIZE + TAG_LEN);
    const read = this.fsImpl.readSync(this.fd, record, 0, record.length, diskOffset);
    if (read !== record.length) throw new AppError('catalog/corrupt', 'bloc tronque');
    const plaintext = openGcm(record.slice(0, BLOCK_SIZE), record.slice(BLOCK_SIZE), this.options.params, blockIndex, this.header.blockSize);
    this.cachedBlockIndex = blockIndex;
    this.cachedPlaintext = plaintext;
    this.blocksRead += 1;
    return plaintext;
  }

  /** Lit l'intégralité du clair (fichiers petits : dictionnaire de groupes, tranches). */
  readAll(): Buffer {
    const chunks: Buffer[] = [];
    for (let blockIndex = 0; blockIndex < this.header.blockCount; blockIndex++) {
      chunks.push(this.block(blockIndex));
    }
    return Buffer.concat(chunks);
  }

  /** Vide le cache : appelé à la fermeture pour ne pas garder de clair en mémoire. */
  clearCache(): void {
    this.cachedPlaintext = null;
    this.cachedBlockIndex = -1;
  }

  close(): void {
    this.clearCache();
    if (this.fd === null) return;
    try {
      this.fsImpl.closeSync(this.fd);
    } finally {
      this.fd = null;
    }
  }
}
