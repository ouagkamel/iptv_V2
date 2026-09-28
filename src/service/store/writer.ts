/**
 * Écrivain d'index (§2.4, §15.2) : écrit dans un répertoire **temporaire** puis bascule
 * atomiquement. Un import annulé, interrompu ou en échec ne remplace jamais l'index validé.
 *
 * Ordre des fichiers : `records.bin` (ordre source), `payload.bin` (charges lourdes),
 * `title.idx` (index épars + table dense), `buckets.idx`, `groups.bin`, puis le manifeste.
 *
 * Mémoire bornée : les titres sont conservés dans des **tampons binaires** (12 octets de clé de
 * tri + 48 octets de titre normalisé par entrée, soit ≈ 15 Mio pour 250 000 entrées), pas sous
 * forme d'objets JavaScript. Le tri s'effectue sur une `Uint32Array` d'indices.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BucketSet, ContentType } from '../../contracts/types';
import { AppError } from '../../contracts/errors';
import { mkdirRecursive } from './fsutil';
import { accumulateNormalized, buildBucketSet, createBucketAccumulator } from '../../core/scripts';
import { normalizeTitle } from '../../core/normalize';
import {
  BlockFileRandomReader,
  BlockFileWriter,
  schemaHash,
  type IndexKeyParams
} from '../crypto/indexCrypto';
import {
  CATEGORY_NONE,
  REF_ENTRY_BYTES,
  DEFAULT_INLINE_SIZE,
  SCHEMA_BUCKETS,
  SCHEMA_GROUPS,
  SCHEMA_REFS,
  SCHEMA_PAYLOAD,
  SCHEMA_RECORDS,
  SCHEMA_TITLE,
  TITLE_SPARSE_ENTRY_BYTES,
  TITLE_SPARSE_KEY_BYTES,
  TITLE_SPARSE_STRIDE
} from './constants';
import { commitManifest, filePathFor, markSwapTimestamp, stagingDir, type IndexManifest } from './manifest';
import {
  decodeInlinePayload,
  decodeSlot,
  encodeHeavyPayload,
  encodeInlinePayload,
  encodeRecord,
  hasRecordSentinel,
  sortKey,
  SLOT_SIZE,
  TITLE_NORMALIZED_BYTES,
  type HeavyPayload,
  type InlinePayload
} from './record';

export interface IndexEntryInput {
  categoryId: string;
  /** titre affiché, jamais normalisé */
  title: string;
  /** clé de variante (M3U) ou identifiant fournisseur (Xtream), courte */
  refKey?: string;
  refHash: string;
  hostSafety: 'ok' | 'private' | 'unknown' | 'allowed-lan';
  streamMode: 'storedSecret' | 'derived' | 'urlNoSecret';
  hasCredential: boolean;
  playable: boolean;
  epgId?: string;
  logoOrPosterUrl?: string;
  year?: number;
  durationSeconds?: number;
  summary?: string;
  plot?: string;
  /** URL complète, uniquement en mode `storedSecret` */
  streamUrl?: string;
  /** forme repliée d'URL + identifiant de flux, en mode `derived` */
  streamForm?: string;
}

export interface GroupInput {
  id: string;
  name: string;
  sourceOrder: number;
}

export interface CatalogWriterOptions {
  baseDir: string;
  profileId: string;
  contentType: ContentType;
  indexVersion: number;
  masterKey: Buffer;
  inlineSize?: number;
  searchIndexKind?: 'title' | 'title+tokens';
}

const MAX_INLINE_TEXT = 200;

/** Octets par entrée du tampon de tri : clé (16) + ordinal source (4). */
const TITLE_KEY_BYTES = TITLE_SPARSE_KEY_BYTES + 4;

export class CatalogIndexWriter {
  private readonly options: CatalogWriterOptions;
  private readonly inlineSize: number;
  private readonly params: IndexKeyParams;
  private readonly recordsWriter: BlockFileWriter;
  private readonly payloadWriter: BlockFileWriter;
  private titleKeys: Buffer; // clé de tri (16 octets) + u32 ordinal, par entrée
  private titlesText: Buffer; // 48 octets de titre normalisé, par entrée
  private capacity: number;
  private count = 0;
  private payloadOffset = 0;
  private readonly groups: Record<string, { id: string; name: string; sourceOrder: number; count: number; ranges: number[][] }> = {};
  private lastCategory: string | null = null;
  private lastRangeEnd = -1;
  private warnings: string[] = [];
  /**
   * Index de références construit pendant l'import : 16 octets d'empreinte + 4 octets d'ordinal par
   * entrée, triés à la fin pour permettre une **recherche binaire** — l'application demande un détail
   * ou résout un flux sans jamais balayer le catalogue (§15.2).
   */
  private refKeys: Buffer = Buffer.alloc(4096 * REF_ENTRY_BYTES);
  private refOrdinals: Buffer = Buffer.alloc(4096 * 4);
  private refCount = 0;
  private finished = false;
  private committed = false;
  private readonly staging: string;
  private recordSize: number;

  /**
   * `resume` rouvre un staging interrompu (§15.5) : les fichiers chiffrés sont rouverts à la suite
   * du dernier bloc, et l'état interne (compteurs, groupes, plages, clés de tri) est **reconstruit
   * en relisant les secteurs déjà écrits**. Aucune donnée de tri non vérifiée n'est supposée.
   */
  constructor(options: CatalogWriterOptions, resume?: { inlineSize: number; recordSize: number }) {
    this.options = options;
    this.inlineSize = resume ? resume.inlineSize : options.inlineSize || DEFAULT_INLINE_SIZE;
    this.recordSize = resume ? resume.recordSize : SLOT_SIZE + this.inlineSize;
    this.staging = stagingDir(options.baseDir, options.indexVersion);
    if (resume) {
      if (!fs.existsSync(this.staging)) {
        throw new AppError('catalog/indexMissing', 'aucun index temporaire a reprendre');
      }
    } else {
      if (fs.existsSync(this.staging)) {
        throw new AppError('catalog/busy', 'un import est deja en cours pour ce profil');
      }
      mkdirRecursive(this.staging);
    }
    this.params = {
      masterKey: options.masterKey,
      profileId: options.profileId,
      contentType: options.contentType,
      indexVersion: options.indexVersion,
      schemaHash: schemaHash(SCHEMA_RECORDS),
      fileKind: 'records'
    };
    this.recordsWriter = new BlockFileWriter(
      path.join(this.staging, 'records.bin'),
      { params: this.params },
      Boolean(resume)
    );
    this.payloadWriter = new BlockFileWriter(
      path.join(this.staging, 'payload.bin'),
      {
        params: {
          masterKey: options.masterKey,
          profileId: options.profileId,
          contentType: options.contentType,
          indexVersion: options.indexVersion,
          schemaHash: schemaHash(SCHEMA_PAYLOAD),
          fileKind: 'payload'
        }
      },
      Boolean(resume)
    );
    this.capacity = 1024;
    this.titleKeys = Buffer.alloc(this.capacity * TITLE_KEY_BYTES);
    this.titlesText = Buffer.alloc(this.capacity * TITLE_NORMALIZED_BYTES);
    if (resume) this.restoreFromStaging();
    else this.writeStagingState();
  }

  /** Fichier d'état du staging : non secret (compteurs et tailles, aucun titre, aucune URL). */
  private writeStagingState(): void {
    fs.writeFileSync(
      path.join(this.staging, 'staging.json'),
      JSON.stringify({
        profileId: this.options.profileId,
        contentType: this.options.contentType,
        indexVersion: this.options.indexVersion,
        inlineSize: this.inlineSize,
        recordSize: this.recordSize,
        createdAt: Date.now()
      }),
      'utf8'
    );
  }

  /** Reconstruit l'état interne depuis les secteurs écrits (source de vérité : `records.bin`). */
  private restoreFromStaging(): void {
    const recordsPath = path.join(this.staging, 'records.bin');
    const reader = new BlockFileRandomReader(recordsPath, { params: this.params });
    try {
      const maxRecords = Math.floor(reader.dataLength / this.recordSize);
      this.ensureCapacity(Math.max(1024, maxRecords));
      let ordinal = 0;
      while (ordinal < maxRecords) {
        const bytes = reader.readRange(ordinal * this.recordSize, this.recordSize);
        const slot = bytes.slice(0, SLOT_SIZE);
        if (!hasRecordSentinel(slot)) break;
        const decoded = decodeSlot(slot);
        const inlineBytes = bytes.slice(SLOT_SIZE, SLOT_SIZE + decoded.inlineLength);
        const inline = decodeInlinePayload(inlineBytes);
        const categoryId = inline.g || CATEGORY_NONE;
        if (!this.groups[categoryId]) {
          this.groups[categoryId] = {
            id: categoryId,
            name: categoryId === CATEGORY_NONE ? 'Sans groupe' : categoryId,
            sourceOrder: Object.keys(this.groups).length,
            count: 0,
            ranges: []
          };
        }
        const group = this.groups[categoryId];
        group.count += 1;
        if (this.lastCategory === categoryId && this.lastRangeEnd === ordinal - 1) {
          group.ranges[group.ranges.length - 1][1] = ordinal;
        } else {
          group.ranges.push([ordinal, ordinal]);
        }
        this.lastCategory = categoryId;
        this.lastRangeEnd = ordinal;
        const normalizedBytes = decodeSlot(slot).titleNormalized;
        sortKey(normalizedBytes, TITLE_SPARSE_KEY_BYTES).copy(this.titleKeys, ordinal * TITLE_KEY_BYTES);
        this.titleKeys.writeUInt32BE(ordinal, ordinal * TITLE_KEY_BYTES + TITLE_SPARSE_KEY_BYTES);
        const folded = Buffer.alloc(TITLE_NORMALIZED_BYTES, 0);
        Buffer.from(normalizedBytes, 'utf8').copy(folded, 0, 0, TITLE_NORMALIZED_BYTES - 1);
        folded.copy(this.titlesText, ordinal * TITLE_NORMALIZED_BYTES);
        ordinal += 1;
      }
      this.count = ordinal;
      this.payloadOffset = payloadDataLength(this.staging, this.options);
    } finally {
      reader.close();
    }
  }

  /**
   * Inspecte un staging conservé (import interrompu) **sans rien y écrire** : compteurs, groupes et
   * octets de charge, tels qu'ils étaient au dernier point de reprise. Sert au diagnostic local et à
   * `getImportJob` ; la reprise d'un import redémarre la source interrompue avec un staging neuf
   * (voir JOURNAL, décision « reprise »).
   */
  static inspectStaging(options: CatalogWriterOptions): {
    entryCount: number;
    payloadBytes: number;
    categories: string[];
  } {
    const staging = stagingDir(options.baseDir, options.indexVersion);
    const stateFile = path.join(staging, 'staging.json');
    if (!fs.existsSync(stateFile)) {
      throw new AppError('catalog/indexMissing', 'staging sans etat : rien a inspecter');
    }
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { inlineSize: number; recordSize: number };
    if (state.recordSize !== SLOT_SIZE + state.inlineSize) {
      throw new AppError('catalog/corrupt', 'etat de staging incoherent');
    }
    const writer = new CatalogIndexWriter(options, state);
    const categories = Object.keys(writer.groups);
    return { entryCount: writer.count, payloadBytes: writer.payloadOffset, categories: categories };
  }

  /** Supprime un staging conservé (reimport propre de la même source). */
  static discardStaging(options: CatalogWriterOptions): void {
    const staging = stagingDir(options.baseDir, options.indexVersion);
    if (fs.existsSync(staging)) removeDir(staging);
  }

  get entryCount(): number {
    return this.count;
  }

  get recordSizeUsed(): number {
    return this.recordSize;
  }

  /** Déclare un groupe avant ses entrées (nom affiché, ordre fournisseur). */
  defineGroup(group: GroupInput): void {
    const existing = this.groups[group.id];
    if (existing) {
      existing.name = group.name;
      existing.sourceOrder = group.sourceOrder;
      return;
    }
    this.groups[group.id] = {
      id: group.id,
      name: group.name,
      sourceOrder: group.sourceOrder,
      count: 0,
      ranges: []
    };
  }

  /** Ajoute une entrée ; l'ordre d'appel **est** l'ordre source (§15.2). */
  append(entry: IndexEntryInput): void {
    if (this.finished) throw new AppError('internal/unexpected', 'index deja finalise');
    this.ensureCapacity(this.count + 1);
    const ordinal = this.count;
    const categoryId = entry.categoryId || CATEGORY_NONE;
    if (!this.groups[categoryId]) {
      this.groups[categoryId] = {
        id: categoryId,
        name: categoryId === CATEGORY_NONE ? 'Sans groupe' : categoryId,
        sourceOrder: Object.keys(this.groups).length,
        count: 0,
        ranges: []
      };
    }
    const group = this.groups[categoryId];
    group.count += 1;
    if (this.lastCategory === categoryId && this.lastRangeEnd === ordinal - 1) {
      const last = group.ranges[group.ranges.length - 1];
      last[1] = ordinal;
    } else {
      group.ranges.push([ordinal, ordinal]);
    }
    this.lastCategory = categoryId;
    this.lastRangeEnd = ordinal;

    const normalized = normalizeTitle(entry.title);
    const heavy: HeavyPayload = {};
    if (entry.plot) heavy.p = entry.plot;
    if ((entry.streamMode === 'storedSecret' || entry.streamMode === 'urlNoSecret') && entry.streamUrl) {
      // `storedSecret` : URL porteuse d'identifiants, chiffrée au repos ; `urlNoSecret` : URL publique
      // imposée par le portail, non reconstituable mais sans secret
      heavy.u = entry.streamUrl;
    }
    if (entry.streamMode === 'derived' && entry.streamForm) heavy.f = entry.streamForm;
    if (entry.refKey) heavy.id = entry.refKey;
    const hasHeavy = Object.keys(heavy).length > 0;
    const heavyBuffer = hasHeavy ? encodeHeavyPayload(heavy) : null;

    const inline: InlinePayload = { t: entry.title, g: categoryId };
    if (entry.refKey) inline.r = entry.refKey;
    if (entry.logoOrPosterUrl) inline.l = clip(entry.logoOrPosterUrl, MAX_INLINE_TEXT, this.warnings, 'logo tronque');
    if (entry.epgId) inline.e = clip(entry.epgId, 64, this.warnings, 'epgId tronque');
    if (entry.year !== undefined) inline.y = entry.year;
    if (entry.durationSeconds !== undefined) inline.d = entry.durationSeconds;
    if (entry.summary) inline.s = clip(entry.summary, MAX_INLINE_TEXT, this.warnings, 'resume tronque');
    const inlinePayload = fitInline(inline, this.inlineSize, this.warnings);

    this.collectRef(entry.refHash, ordinal);

    const encoded = encodeRecord({
      sourceOrder: ordinal,
      titleNormalized: normalized,
      categoryId,
      refHash: entry.refHash,
      hasCredential: entry.hasCredential,
      hasEpgId: Boolean(entry.epgId),
      playable: entry.playable,
      hostSafety: entry.hostSafety,
      streamMode: entry.streamMode,
      scriptBucket: 0,
      inlinePayload,
      heavyPayload: heavyBuffer,
      payloadOffset: heavyBuffer ? this.payloadOffset : 0,
      payloadLength: heavyBuffer ? heavyBuffer.length : 0
    });

    const record = Buffer.alloc(this.recordSize, 0);
    encoded.slot.copy(record, 0);
    encoded.inlinePayload.copy(record, SLOT_SIZE);
    this.recordsWriter.write(record);
    if (heavyBuffer) {
      // Payloads alignés sur 4 octets : la longueur reste exacte, seul le remplissage change.
      const padded = Buffer.alloc(pad4(heavyBuffer.length), 0);
      heavyBuffer.copy(padded, 0);
      this.payloadWriter.write(padded);
      this.payloadOffset += padded.length;
    }

    sortKey(normalized, TITLE_SPARSE_KEY_BYTES).copy(this.titleKeys, this.count * TITLE_KEY_BYTES);
    this.titleKeys.writeUInt32BE(ordinal, this.count * TITLE_KEY_BYTES + TITLE_SPARSE_KEY_BYTES);
    const foldedTitle = Buffer.alloc(TITLE_NORMALIZED_BYTES, 0);
    Buffer.from(normalized, 'utf8').copy(foldedTitle, 0, 0, TITLE_NORMALIZED_BYTES - 1);
    foldedTitle.copy(this.titlesText, this.count * TITLE_NORMALIZED_BYTES);
    this.count += 1;
  }

  /** Finalise les fichiers, renvoie le manifeste prêt à être publié (écriture dans le staging). */
  /** Paramètres de dérivation de clé d'un fichier de l'index (§15.3, `fileKind` dans le sel). */
  private paramsFor(fileKind: string, schema: string): IndexKeyParams {
    return {
      masterKey: this.options.masterKey,
      profileId: this.options.profileId,
      contentType: this.options.contentType,
      indexVersion: this.options.indexVersion,
      schemaHash: schemaHash(schema),
      fileKind
    };
  }

  /** Ajoute une empreinte de référence à l'index dense (`refHash` hexadécimal de 16 octets). */
  private collectRef(refHash: string, ordinal: number): void {
    if (this.refCount * REF_ENTRY_BYTES + REF_ENTRY_BYTES > this.refKeys.length) {
      const grown = Buffer.alloc(this.refKeys.length * 2);
      this.refKeys.copy(grown, 0, 0, this.refCount * REF_ENTRY_BYTES);
      this.refKeys = grown;
    }
    if (this.refCount * 4 + 4 > this.refOrdinals.length) {
      const grown = Buffer.alloc(this.refOrdinals.length * 2);
      this.refOrdinals.copy(grown, 0, 0, this.refCount * 4);
      this.refOrdinals = grown;
    }
    Buffer.from(refHash.slice(0, 32), 'hex').copy(this.refKeys, this.refCount * REF_ENTRY_BYTES);
    this.refOrdinals.writeUInt32BE(ordinal, this.refCount * 4);
    this.refCount += 1;
  }

  /** Compare deux empreintes de l'index (octet par octet, sans allocation). */
  private compareRefAt(left: number, right: number): number {
    const baseLeft = left * REF_ENTRY_BYTES;
    const baseRight = right * REF_ENTRY_BYTES;
    for (let index = 0; index < 16; index++) {
      const difference = this.refKeys[baseLeft + index] - this.refKeys[baseRight + index];
      if (difference !== 0) return difference;
    }
    return this.refOrdinals.readUInt32BE(left * 4) - this.refOrdinals.readUInt32BE(right * 4);
  }

  /** Écrit `refs.idx` : entrées triées par empreinte, recherchables par dichotomie. */
  private writeRefsIndex(): { blockCount: number } {
    const order: number[] = new Array(this.refCount);
    for (let index = 0; index < this.refCount; index++) order[index] = index;
    order.sort((left, right) => this.compareRefAt(left, right));
    const writer = new BlockFileWriter(
      path.join(this.staging, 'refs.idx'),
      { params: this.paramsFor('refs', SCHEMA_REFS) }
    );
    const record = Buffer.alloc(REF_ENTRY_BYTES);
    for (let index = 0; index < order.length; index++) {
      this.refKeys.copy(record, 0, order[index] * REF_ENTRY_BYTES, order[index] * REF_ENTRY_BYTES + 16);
      record.writeUInt32BE(this.refOrdinals.readUInt32BE(order[index] * 4), 16);
      writer.write(record);
    }
    return writer.finish();
  }

  finish(): { manifest: IndexManifest } {
    if (this.finished) throw new AppError('internal/unexpected', 'index deja finalise');
    this.finished = true;
    const recordsResult = this.recordsWriter.finish();
    const payloadResult = this.payloadWriter.finish();
    const order = this.buildTitleOrder();
    const buckets = this.buildBuckets(order);
    const titleResult = this.writeTitleIndex(order, buckets);
    const bucketsResult = this.writeJsonFile('buckets', buckets);
    const groupsResult = this.writeGroups();
    const refsResult = this.writeRefsIndex();
    const manifest: IndexManifest = {
      profileId: this.options.profileId,
      contentType: this.options.contentType,
      indexVersion: this.options.indexVersion,
      entryCount: this.count,
      recordSize: this.recordSize,
      inlineSize: this.inlineSize,
      titleSparseStride: TITLE_SPARSE_STRIDE,
      titleSparseKeyBytes: TITLE_SPARSE_KEY_BYTES,
      searchIndexKind: this.options.searchIndexKind || 'title',
      scriptBuckets: buckets,
      state: 'valid',
      createdAt: Date.now(),
      schemaHashes: {
        records: schemaHash(SCHEMA_RECORDS),
        payload: schemaHash(SCHEMA_PAYLOAD),
        title: schemaHash(SCHEMA_TITLE),
        buckets: schemaHash(SCHEMA_BUCKETS),
        groups: schemaHash(SCHEMA_GROUPS),
        refs: schemaHash(SCHEMA_REFS)
      },
      blockCounts: {
        records: recordsResult.blockCount,
        payload: payloadResult.blockCount,
        title: titleResult.blockCount,
        buckets: bucketsResult.blockCount,
        groups: groupsResult.blockCount,
        refs: refsResult.blockCount
      }
    };
    fs.writeFileSync(path.join(this.staging, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    return { manifest };
  }

  /** Bascule atomique : `rename` du staging puis publication du manifeste (§2.4). */
  commit(manifest: IndexManifest): void {
    if (!this.finished) throw new AppError('internal/unexpected', 'finaliser l index avant de le publier');
    if (this.committed) return;
    const target = path.join(this.options.baseDir, 'index-v' + manifest.indexVersion);
    fs.renameSync(this.staging, target);
    commitManifest(this.options.baseDir, manifest);
    markSwapTimestamp(this.options.baseDir);
    this.committed = true;
  }

  /**
   * Abandon **en conservant** le staging : utilisé quand l'import échoue (échec réseau, service
   * arrêté). Rien de l'index validé n'est touché, et une reprise ultérieure reste possible.
   */
  abortStagingKeep(): void {
    if (this.committed) return;
    this.finished = true;
    // Scellement : l'en-tête est mis à jour et le dernier bloc partiel est écrit, ce qui rend le
    // staging **relisible pour diagnostic** (compteurs, groupes) sans permettre d'y ajouter des
    // enregistrements : reprendre un index partiel demanderait d'aligner les enregistrements sur
    // les blocs (voir JOURNAL, décision « reprise »), sinon le couple (clé, nonce) serait réutilisé.
    try {
      this.recordsWriter.seal();
    } catch (_err) {
      /* best-effort */
    }
    try {
      this.payloadWriter.seal();
    } catch (_err) {
      /* best-effort */
    }
  }

  /** Abandon : rien de l'index validé n'est touché et le staging est supprimé (§15.5). */
  abort(): void {
    if (this.committed) return;
    try {
      this.recordsWriter.abort();
    } catch (_err) {
      /* best-effort */
    }
    try {
      this.payloadWriter.abort();
    } catch (_err) {
      /* best-effort */
    }
    removeDir(this.staging);
  }

  getWarnings(): string[] {
    return this.warnings.slice();
  }

  /** Croissance géométrique des tampons de tri : jamais de reconstruction d'objets par entrée. */
  private ensureCapacity(needed: number): void {
    if (needed <= this.capacity) return;
    let capacity = this.capacity;
    while (capacity < needed) capacity *= 2;
    const titleKeys = Buffer.alloc(capacity * TITLE_KEY_BYTES);
    this.titleKeys.copy(titleKeys, 0, 0, this.count * TITLE_KEY_BYTES);
    this.titleKeys = titleKeys;
    const titlesText = Buffer.alloc(capacity * TITLE_NORMALIZED_BYTES);
    this.titlesText.copy(titlesText, 0, 0, this.count * TITLE_NORMALIZED_BYTES);
    this.titlesText = titlesText;
    this.capacity = capacity;
  }

  /** Table d'ordre alphabétique : tri stable par clé de 8 octets puis par ordinal. */
  private buildTitleOrder(): Uint32Array {
    const count = this.count;
    const order = new Uint32Array(count);
    for (let i = 0; i < count; i++) order[i] = i;
    const keys = this.titleKeys;
    const sort = Array.prototype.sort as unknown as (this: Uint32Array, cmp: (a: number, b: number) => number) => Uint32Array;
    sort.call(order, (a: number, b: number) => {
      const ka = a * TITLE_KEY_BYTES;
      const kb = b * TITLE_KEY_BYTES;
      for (let i = 0; i < TITLE_SPARSE_KEY_BYTES; i++) {
        const diff = keys[ka + i] - keys[kb + i];
        if (diff !== 0) return diff;
      }
      return a - b;
    });
    return order;
  }

  private buildBuckets(order: Uint32Array): BucketSet {
    const acc = createBucketAccumulator();
    for (let position = 0; position < order.length; position++) {
      const ordinal = order[position];
      const titleBytes = this.titlesText.slice(ordinal * TITLE_NORMALIZED_BYTES, (ordinal + 1) * TITLE_NORMALIZED_BYTES);
      const terminator = titleBytes.indexOf(0);
      const title = titleBytes.slice(0, terminator === -1 ? undefined : terminator).toString('utf8');
      accumulateNormalized(acc, title, position);
    }
    return buildBucketSet(acc);
  }

  private writeTitleIndex(order: Uint32Array, buckets: BucketSet): { blockCount: number } {
    void buckets;
    const writer = new BlockFileWriter(path.join(this.staging, 'title.idx'), {
      params: {
        masterKey: this.options.masterKey,
        profileId: this.options.profileId,
        contentType: this.options.contentType,
        indexVersion: this.options.indexVersion,
        schemaHash: schemaHash(SCHEMA_TITLE),
        fileKind: 'title'
      }
    });
    try {
      const header = Buffer.alloc(8);
      header.writeUInt32BE(order.length >>> 0, 0);
      // en-tête : nombre d'entrées puis pas de l'index épars (la taille de clé vient du manifeste)
      header.writeUInt32BE(TITLE_SPARSE_STRIDE, 4);
      writer.write(header);
      const sparseCount = Math.ceil(order.length / TITLE_SPARSE_STRIDE);
      const chunkRows = Math.max(1, Math.floor((64 * 1024) / TITLE_SPARSE_ENTRY_BYTES));
      const sparseChunk = Buffer.alloc(chunkRows * TITLE_SPARSE_ENTRY_BYTES);
      let sparseBuffer = 0;
      for (let k = 0; k < sparseCount; k++) {
        const position = k * TITLE_SPARSE_STRIDE;
        const ordinal = order[position];
        const base = sparseBuffer * TITLE_SPARSE_ENTRY_BYTES;
        this.titleKeys.copy(
          sparseChunk,
          base,
          ordinal * TITLE_KEY_BYTES,
          ordinal * TITLE_KEY_BYTES + TITLE_SPARSE_KEY_BYTES
        );
        sparseChunk.writeUInt32BE(ordinal, base + TITLE_SPARSE_KEY_BYTES);
        sparseBuffer += 1;
        if (sparseBuffer === chunkRows) {
          writer.write(sparseChunk.slice(0, sparseBuffer * TITLE_SPARSE_ENTRY_BYTES));
          sparseBuffer = 0;
        }
      }
      if (sparseBuffer > 0) writer.write(sparseChunk.slice(0, sparseBuffer * TITLE_SPARSE_ENTRY_BYTES));
      // table dense : ordinal alphabétique → ordinal source
      const denseChunk = Buffer.alloc(1024 * 4);
      let denseBuffer = 0;
      for (let position = 0; position < order.length; position++) {
        denseChunk.writeUInt32BE(order[position], denseBuffer * 4);
        denseBuffer += 1;
        if (denseBuffer === 1024) {
          writer.write(denseChunk.slice(0, denseBuffer * 4));
          denseBuffer = 0;
        }
      }
      if (denseBuffer > 0) writer.write(denseChunk.slice(0, denseBuffer * 4));
      return writer.finish();
    } catch (err) {
      writer.abort();
      throw err;
    }
  }

  private writeJsonFile(kind: 'buckets' | 'groups', value: unknown): { blockCount: number } {
    const filePath = filePathFor(this.options.baseDir, this.options.indexVersion, kind);
    const target = path.join(this.staging, path.basename(filePath));
    const writer = new BlockFileWriter(target, {
      params: {
        masterKey: this.options.masterKey,
        profileId: this.options.profileId,
        contentType: this.options.contentType,
        indexVersion: this.options.indexVersion,
        schemaHash: schemaHash(kind === 'buckets' ? SCHEMA_BUCKETS : SCHEMA_GROUPS),
        fileKind: kind
      }
    });
    try {
      writer.write(Buffer.from(JSON.stringify(value), 'utf8'));
      return writer.finish();
    } catch (err) {
      writer.abort();
      throw err;
    }
  }

  private writeGroups(): { blockCount: number } {
    const groups = Object.keys(this.groups)
      .map((id) => this.groups[id])
      .sort((a, b) => a.sourceOrder - b.sourceOrder);
    return this.writeJsonFile('groups', { v: 1, groups });
  }
}

/**
 * Ajuste la charge courte pour tenir dans la zone inline du secteur : le résumé est réduit avant
 * le logo, et le logo n'est supprimé qu'en dernier recours. Toute coupe est journalisée dans les
 * avertissements d'import (sans contenu sensible) — la page de liste reste ainsi bornée (§15.2).
 */
function fitInline(payload: InlinePayload, inlineSize: number, warnings: string[]): Buffer {
  const attempts: Array<() => InlinePayload> = [
    () => payload,
    () => Object.assign({}, payload, { s: payload.s === undefined ? undefined : payload.s.slice(0, 120) }),
    () => Object.assign({}, payload, { s: payload.s === undefined ? undefined : payload.s.slice(0, 60), l: payload.l === undefined ? undefined : payload.l.slice(0, 96) }),
    () => Object.assign({}, payload, { s: undefined, l: undefined })
  ];
  for (let i = 0; i < attempts.length; i++) {
    const candidate = attempts[i]();
    const buffer = encodeInlinePayload(candidate);
    if (buffer.length <= inlineSize) {
      if (i > 0 && warnings.indexOf('charge courte reduite') === -1) warnings.push('charge courte reduite');
      return buffer;
    }
  }
  throw new AppError('catalog/corrupt', 'charge courte au-dela de la zone inline');
}

function clip(value: string, max: number, warnings: string[], reason: string): string {
  if (value.length <= max) return value;
  if (warnings.indexOf(reason) === -1) warnings.push(reason);
  return value.slice(0, max);
}

function pad4(length: number): number {
  return Math.ceil(length / 4) * 4;
}

/** `fs.mkdirSync(..., {recursive:true})` n'existe pas dans les types Node 8 : création manuelle. */

function removeDir(target: string): void {
  if (!fs.existsSync(target)) return;
  for (const name of fs.readdirSync(target)) {
    const full = path.join(target, name);
    if (fs.statSync(full).isDirectory()) removeDir(full);
    else fs.unlinkSync(full);
  }
  fs.rmdirSync(target);
}

export { decodeInlinePayload };

/**
 * Fin **physique** de `payload.bin` : les blocs sont complétés par des zéros, donc la somme des
 * longueurs déclarées ne suffit pas — c'est la position réelle qui fait foi pour reprendre l'ajout.
 */
function payloadDataLength(staging: string, options: CatalogWriterOptions): number {
  const file = path.join(staging, 'payload.bin');
  if (!fs.existsSync(file)) return 0;
  const reader = new BlockFileRandomReader(file, {
    params: {
      masterKey: options.masterKey,
      profileId: options.profileId,
      contentType: options.contentType,
      indexVersion: options.indexVersion,
      schemaHash: schemaHash(SCHEMA_PAYLOAD),
      fileKind: 'payload'
    }
  });
  try {
    return reader.dataLength;
  } finally {
    reader.close();
  }
}
