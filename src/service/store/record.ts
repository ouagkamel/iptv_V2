/**
 * Enregistrement d'index (§15.2) — secteur fixe de 128 octets, puis charge.
 *
 *   u32  payloadOffset        (offset relatif vers la charge variable, dans `payload.bin`)
 *   u16  payloadLength        (longueur de la charge lourde)
 *   u8   flags                (hasCredential | hostSafety | hasEpgId | playable | streamMode)
 *   u8   scriptBucket
 *   u32  sourceOrder
 *   u32  crcTitle
 *   u8[48] titleNormalized    (tronqué, zéro-terminé)
 *   u8[16] refHash            (variante/identifiant tronqué — jamais l'URL)
 *   u8[8]  prefixKey          (clé de tri : 8 premiers octets du titre normalisé, plié)
 *   u16  inlineLength         (charge courte réellement écrite ; zone inline complétée par des zéros)
 *   …    réservé jusqu'à 128 octets
 *
 * Les neuf premiers champs reprennent **exactement** l'ordre du §15.2 ; `inlineLength` occupe le
 * remplissage du secteur, ce qui laisse la zone fixe à 128 octets et l'accès aléatoire en O(1).
 *
 * La charge **interne** (courte, bornée par `inlinePayloadSize`) contient les champs d'affichage de
 * liste : titre affiché, groupe, logo/poster, épigraphe EPG, année/durée, résumé ≤ 200 caractères.
 * La charge **variable** (`payload.bin`) ne contient que ce qui est lourd : description complète
 * (servie par `getDetails`, ≤ 32 Kio) et URL de flux en mode `storedSecret`.
 *
 * Le CRC du titre permet de détecter une désynchronisation entre le secteur et sa charge sans
 * déchiffrer tout le fichier.
 */

import { CATEGORY_NONE } from './constants';

export const SLOT_SIZE = 128;
export const TITLE_NORMALIZED_BYTES = 48;
export const REF_HASH_BYTES = 16;
export const PREFIX_KEY_BYTES = 8;

/**
 * Longueur de la clé de tri conservée dans l'index épars : `prefix8` (normatif, §15.2) suivi d'une
 * **extension de 8 octets**. Sans elle, un catalogue dont les titres partagent leurs 8 premiers
 * octets (« chaine 0042 », « chaine 1500 »…) rendrait l'index épars incapable de discriminer et le
 * balayage borné dégénérerait en parcours quasi linéaire. L'extension est décrite dans le
 * manifeste (`titleSparseKeyBytes`), le `prefix8` reste présent et inchangé.
 */
export const SORT_KEY_BYTES = 16;

/** Clé de tri : `SORT_KEY_BYTES` premiers octets du titre normalisé (zéro-terminés si plus court). */
export function sortKey(titleNormalized: string, bytes: number = SORT_KEY_BYTES): Buffer {
  const key = Buffer.alloc(bytes, 0);
  const source = Buffer.from(titleNormalized, 'utf8');
  const take = Math.min(source.length, bytes);
  source.copy(key, 0, 0, take);
  if (take < bytes) key[take] = 0;
  return key;
}

/**
 * Sentinelle de secteur (offset 90, zone de remplissage). Elle permet de distinguer, à la reprise
 * d'un import (§15.5), un secteur réellement écrit du remplissage à zéro — sans elle, une entrée
 * sans titre ni charge serait indiscernable d'un secteur non écrit.
 */
export const SLOT_SENTINEL_OFFSET = 90;
export const SLOT_SENTINEL = 0xbeef;

export const FLAG_HAS_CREDENTIAL = 0x01;
export const FLAG_HAS_EPG_ID = 0x02;
export const FLAG_PLAYABLE = 0x04;
export const FLAG_STREAM_DERIVED = 0x08;
export const FLAG_STREAM_URL_NO_SECRET = 0x10;
export const FLAG_PRIVATE_HOST = 0x20;
export const FLAG_LAN_ALLOWED = 0x40;

export type HostSafetyCode = 0 | 1 | 2 | 3; // ok | private | unknown | allowed-lan

export interface RecordSlotInput {
  sourceOrder: number;
  titleNormalized: string;
  categoryId: string;
  refHash: string;
  hasCredential: boolean;
  hasEpgId: boolean;
  playable: boolean;
  hostSafety: 'ok' | 'private' | 'unknown' | 'allowed-lan';
  streamMode: 'storedSecret' | 'derived' | 'urlNoSecret';
  scriptBucket: number;
  /** charge courte, sérialisée (≤ inlinePayloadSize octets) */
  inlinePayload: Buffer;
  /** charge lourde : description complète, URL en mode storedSecret */
  heavyPayload: Buffer | null;
  /** offset de la charge lourde dans `payload.bin` (0 si absente) */
  payloadOffset: number;
  /** longueur de la charge lourde (0 si absente) */
  payloadLength: number;
}

export interface EncodedRecord {
  slot: Buffer;
  inlinePayload: Buffer;
  heavyPayload: Buffer | null;
}

/** CRC32 (table pré-calculée, sans dépendance). */
const CRC_TABLE: number[] = (function buildCrcTable(): number[] {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table.push(crc >>> 0);
  }
  return table;
})();

export function crc32(input: string): number {
  const bytes = Buffer.from(input, 'utf8');
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Clé de tri : 8 premiers octets du titre normalisé, pliés en 8 octets (jamais un hash faible). */
export function prefixKey(titleNormalized: string): Buffer {
  return sortKey(titleNormalized, PREFIX_KEY_BYTES);
}

function foldTitle(titleNormalized: string): Buffer {
  const out = Buffer.alloc(TITLE_NORMALIZED_BYTES, 0);
  const bytes = Buffer.from(titleNormalized, 'utf8');
  const take = Math.min(bytes.length, TITLE_NORMALIZED_BYTES - 1);
  bytes.copy(out, 0, 0, take);
  out[take] = 0;
  return out;
}

export function encodeFlags(input: RecordSlotInput): number {
  let flags = 0;
  if (input.hasCredential) flags |= FLAG_HAS_CREDENTIAL;
  if (input.hasEpgId) flags |= FLAG_HAS_EPG_ID;
  if (input.playable) flags |= FLAG_PLAYABLE;
  if (input.streamMode === 'derived') flags |= FLAG_STREAM_DERIVED;
  if (input.streamMode === 'urlNoSecret') flags |= FLAG_STREAM_URL_NO_SECRET;
  if (input.hostSafety === 'private') flags |= FLAG_PRIVATE_HOST;
  if (input.hostSafety === 'allowed-lan') flags |= FLAG_LAN_ALLOWED;
  return flags;
}

export function decodeHostSafety(flags: number): 'ok' | 'private' | 'unknown' | 'allowed-lan' {
  if (flags & FLAG_LAN_ALLOWED) return 'allowed-lan';
  if (flags & FLAG_PRIVATE_HOST) return 'private';
  return 'ok';
}

export function decodeStreamMode(flags: number): 'storedSecret' | 'derived' | 'urlNoSecret' {
  if (flags & FLAG_STREAM_DERIVED) return 'derived';
  if (flags & FLAG_STREAM_URL_NO_SECRET) return 'urlNoSecret';
  return 'storedSecret';
}

/**
 * Encode un enregistrement : le secteur de 128 octets ne dépend pas de la charge, ce qui autorise
 * la lecture d'une page « source » sans toucher aux charges lourdes.
 */
export function encodeRecord(input: RecordSlotInput): EncodedRecord {
  if (input.inlinePayload.length > 0xffff) {
    throw new Error('charge courte au-dela de 65535 octets');
  }
  const slot = Buffer.alloc(SLOT_SIZE, 0);
  const flags = encodeFlags(input);
  if (input.payloadOffset > 0xffffffff) throw new Error('offset de charge hors bornes');
  if (input.payloadLength > 0xffff) throw new Error('charge lourde au-dela de 65535 octets');
  slot.writeUInt32BE(input.payloadOffset >>> 0, 0);
  slot.writeUInt16BE(input.payloadLength, 4);
  slot.writeUInt8(flags, 6);
  slot.writeUInt8(input.scriptBucket & 0xff, 7);
  slot.writeUInt32BE(input.sourceOrder >>> 0, 8);
  slot.writeUInt32BE(crc32(input.titleNormalized), 12);
  foldTitle(input.titleNormalized).copy(slot, 16);
  Buffer.from(input.refHash, 'hex').copy(slot, 16 + TITLE_NORMALIZED_BYTES, 0, REF_HASH_BYTES);
  prefixKey(input.titleNormalized).copy(slot, 16 + TITLE_NORMALIZED_BYTES + REF_HASH_BYTES);
  slot.writeUInt16BE(input.inlinePayload.length, 88); // inlineLength (zone de remplissage du secteur)
  slot.writeUInt16BE(SLOT_SENTINEL, SLOT_SENTINEL_OFFSET);
  return { slot, inlinePayload: input.inlinePayload, heavyPayload: input.heavyPayload };
}

export interface DecodedSlot {
  payloadOffset: number;
  payloadLength: number;
  inlineLength: number;
  flags: number;
  scriptBucket: number;
  sourceOrder: number;
  crcTitle: number;
  titleNormalized: string;
  refHash: string;
  prefixKey: Buffer;
}

/** Vrai si ce secteur a réellement été écrit (reprise d'import). */
export function hasRecordSentinel(slot: Buffer): boolean {
  return slot.length >= SLOT_SENTINEL_OFFSET + 2 && slot.readUInt16BE(SLOT_SENTINEL_OFFSET) === SLOT_SENTINEL;
}

export function decodeSlot(slot: Buffer): DecodedSlot {
  if (slot.length < SLOT_SIZE) throw new Error('secteur tronque');
  const titleBytes = slot.slice(16, 16 + TITLE_NORMALIZED_BYTES);
  const terminator = titleBytes.indexOf(0);
  return {
    payloadOffset: slot.readUInt32BE(0),
    payloadLength: slot.readUInt16BE(4),
    inlineLength: slot.readUInt16BE(88),
    flags: slot.readUInt8(6),
    scriptBucket: slot.readUInt8(7),
    sourceOrder: slot.readUInt32BE(8),
    crcTitle: slot.readUInt32BE(12),
    titleNormalized: titleBytes.slice(0, terminator === -1 ? undefined : terminator).toString('utf8'),
    refHash: slot.slice(16 + TITLE_NORMALIZED_BYTES, 16 + TITLE_NORMALIZED_BYTES + REF_HASH_BYTES).toString('hex'),
    prefixKey: slot.slice(
      16 + TITLE_NORMALIZED_BYTES + REF_HASH_BYTES,
      16 + TITLE_NORMALIZED_BYTES + REF_HASH_BYTES + PREFIX_KEY_BYTES
    )
  };
}

/** Charge courte sérialisée : clés courtes pour rester sous le plafond de 256 Kio par page. */
export interface InlinePayload {
  t: string; // titre affiché
  g: string; // groupe (categoryId)
  r?: string; // clé de référence courte : providerId (Xtream) ou sourceKey (M3U)
  l?: string; // logo/poster
  e?: string; // epgId
  y?: number; // année
  d?: number; // durée en secondes
  s?: string; // résumé ≤ 200 caractères
}

export function encodeInlinePayload(payload: InlinePayload): Buffer {
  if (payload.s !== undefined && payload.s.length > 200) {
    const clipped = Object.assign({}, payload, { s: payload.s.slice(0, 200) });
    return Buffer.from(JSON.stringify(clipped), 'utf8');
  }
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

export function decodeInlinePayload(buffer: Buffer): InlinePayload {
  return JSON.parse(buffer.toString('utf8')) as InlinePayload;
}

/** Charge lourde : servie uniquement par `getDetails` (plafond 32 Kio, §15.2). */
export interface HeavyPayload {
  /** description complète, ≤ 32 Kio */
  p?: string;
  /** URL de flux complète (mode `storedSecret` uniquement) */
  u?: string;
  /** forme repliée d'URL et identifiant de flux (mode `derived`) */
  f?: string;
  /** identifiant fournisseur ou clé de variante, pour re-résoudre le flux */
  id?: string;
}

export const MAX_DETAIL_BYTES = 32 * 1024;

export function encodeHeavyPayload(payload: HeavyPayload): Buffer {
  const buffer = Buffer.from(JSON.stringify(payload), 'utf8');
  if (buffer.length > MAX_DETAIL_BYTES) {
    throw new Error('charge lourde au-dela du plafond de 32 Kio');
  }
  return buffer;
}

export function decodeHeavyPayload(buffer: Buffer): HeavyPayload {
  return JSON.parse(buffer.toString('utf8')) as HeavyPayload;
}

export { CATEGORY_NONE };
