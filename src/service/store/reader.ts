/**
 * Lecteur d'index (§15.2) — pagination à curseur versionné, recherche binaire bornée, budget
 * d'octets, un seul bloc de clair en mémoire à la fois.
 *
 * Invariants portés par ce module :
 *  - un curseur d'une autre `indexVersion` produit `catalog/indexChanged`, jamais une page fausse ;
 *  - la recherche ne parcourt **jamais** linéairement le catalogue : recherche binaire sur l'index
 *    épars puis balayage borné à la page ;
 *  - une page est bornée en objets **et** en octets, avec un curseur valide ;
 *  - aucune URL de flux n'est lue hors de `getDetails`/`resolveStream`.
 */

import type { BucketSet, CatalogItem, CatalogPage, ContentRef, ContentType, Cursor, HostSafety } from '../../contracts/types';
import { AppError } from '../../contracts/errors';
import { normalizeQuery, hash32 } from '../../core/normalize';
import { MAX_PAGE_BYTES, PageAccumulator, makePage } from '../../core/pages';
import { BlockFileRandomReader, schemaHash, type IndexKeyParams } from '../crypto/indexCrypto';
import {
  DEFAULT_INLINE_SIZE,
  SCHEMA_BUCKETS,
  SCHEMA_GROUPS,
  SCHEMA_PAYLOAD,
  SCHEMA_RECORDS,
  SCHEMA_TITLE,
  TITLE_SPARSE_ENTRY_BYTES,
  TITLE_SPARSE_KEY_BYTES,
  TITLE_SPARSE_STRIDE
} from './constants';
import { filePathFor, indexDir, readManifest, type IndexManifest } from './manifest';
import {
  decodeHeavyPayload,
  decodeHostSafety,
  decodeInlinePayload,
  decodeSlot,
  decodeStreamMode,
  prefixKey,
  sortKey,
  SLOT_SIZE,
  type HeavyPayload,
  type InlinePayload
} from './record';

export interface CatalogReaderOptions {
  baseDir: string;
  profileId: string;
  contentType: ContentType;
  masterKey: Buffer;
  /** version d'index attendue ; une autre version valide ⇒ `catalog/indexChanged` */
  expectedIndexVersion?: number;
  /** interprétation de la clé de référence stockée : Xtream = providerId, M3U = sourceKey */
  refKind: 'providerId' | 'sourceKey';
}

export interface GroupSummary {
  id: string;
  name: string;
  sourceOrder: number;
  count: number;
  ranges: number[][];
}

export interface ReaderStats {
  blocksRead: number;
  recordsRead: number;
  payloadsRead: number;
  bytesReturned: number;
}

export class CatalogIndexReader {
  private readonly options: CatalogReaderOptions;
  readonly manifest: IndexManifest;
  private readonly records: BlockFileRandomReader;
  private readonly payload: BlockFileRandomReader;
  private readonly title: BlockFileRandomReader;
  private readonly buckets: BlockFileRandomReader;
  private readonly groups: BlockFileRandomReader;
  private readonly stats: ReaderStats = { blocksRead: 0, recordsRead: 0, payloadsRead: 0, bytesReturned: 0 };
  private groupsCache: GroupSummary[] | null = null;
  private bucketsCache: BucketSet | null = null;
  private sparseCount: number;
  private sparseKeyBytes = TITLE_SPARSE_KEY_BYTES;

  static open(options: CatalogReaderOptions): CatalogIndexReader {
    const manifest = readManifest(options.baseDir);
    if (!manifest) throw new AppError('catalog/indexMissing', 'aucun index valide pour ce profil');
    if (options.expectedIndexVersion !== undefined && manifest.indexVersion !== options.expectedIndexVersion) {
      throw new AppError('catalog/indexChanged', 'index remplace depuis l ouverture du lecteur');
    }
    if (manifest.contentType !== options.contentType) {
      throw new AppError('catalog/indexChanged', 'index d un autre type de contenu');
    }
    return new CatalogIndexReader(options, manifest);
  }

  private constructor(options: CatalogReaderOptions, manifest: IndexManifest) {
    this.options = options;
    this.manifest = manifest;
    const base = indexDir(options.baseDir, manifest.indexVersion);
    const keyParams = (fileKind: string, schema: string): IndexKeyParams => ({
      masterKey: options.masterKey,
      profileId: options.profileId,
      contentType: options.contentType,
      indexVersion: manifest.indexVersion,
      schemaHash: schemaHash(schema),
      fileKind
    });
    this.records = new BlockFileRandomReader(join(base, 'records.bin'), { params: keyParams('records', SCHEMA_RECORDS) });
    this.payload = new BlockFileRandomReader(join(base, 'payload.bin'), { params: keyParams('payload', SCHEMA_PAYLOAD) });
    this.title = new BlockFileRandomReader(join(base, 'title.idx'), { params: keyParams('title', SCHEMA_TITLE) });
    this.buckets = new BlockFileRandomReader(join(base, 'buckets.idx'), { params: keyParams('buckets', SCHEMA_BUCKETS) });
    this.groups = new BlockFileRandomReader(join(base, 'groups.bin'), { params: keyParams('groups', SCHEMA_GROUPS) });
    const header = this.title.readRange(0, 8);
    const count = header.readUInt32BE(0);
    const stride = manifest.titleSparseStride || TITLE_SPARSE_STRIDE;
    this.sparseKeyBytes = manifest.titleSparseKeyBytes || TITLE_SPARSE_KEY_BYTES;
    void header;
    if (count !== manifest.entryCount) {
      throw new AppError('catalog/corrupt', 'compteur d entree incoherent entre index de titres et manifeste');
    }
    this.sparseCount = Math.ceil(count / (stride || TITLE_SPARSE_STRIDE));
  }

  get entryCount(): number {
    return this.manifest.entryCount;
  }

  get indexVersion(): number {
    return this.manifest.indexVersion;
  }

  getRecordSize(): number {
    return this.manifest.recordSize || SLOT_SIZE + DEFAULT_INLINE_SIZE;
  }

  getStats(): ReaderStats {
    this.stats.blocksRead =
      this.records.blocksRead + this.payload.blocksRead + this.title.blocksRead + this.buckets.blocksRead + this.groups.blocksRead;
    return Object.assign({}, this.stats);
  }

  /** Liste des groupes avec leurs plages d'ordinaux source (dictionnaire partagé, §5.2). */
  getGroups(): GroupSummary[] {
    if (this.groupsCache) return this.groupsCache;
    const data = this.readJsonFile(this.groups);
    this.groupsCache = (data.groups || []) as GroupSummary[];
    return this.groupsCache;
  }

  /** Tranches alphabétiques calculées à l'indexation ; jamais recalculées côté UI (§15.2). */
  getBuckets(): BucketSet {
    if (this.bucketsCache) return this.bucketsCache;
    const data = this.readJsonFile(this.buckets) as unknown as BucketSet;
    this.bucketsCache = data;
    return data;
  }

  /** Page à curseur. `order: 'source'` suit l'ordre fournisseur, `'title'` l'ordre alphabétique. */
  getPage(params: {
    categoryId?: string;
    order: 'source' | 'title';
    cursor?: Cursor;
  }): CatalogPage<CatalogItem> {
    const cursor = params.cursor;
    if (cursor) this.assertCursorCompatible(cursor, params.order === 'title' ? 'title' : 'source');
    const approximate = this.manifest.state !== 'valid';
    if (params.order === 'title') {
      const start = cursor && cursor.ordinal !== undefined ? cursor.ordinal : 0;
      const acc = new PageAccumulator<CatalogItem>();
      for (let position = start; position < this.entryCount; position++) {
        const ordinal = this.denseOrdinal(position);
        const item = this.readItem(ordinal);
        if (!acc.tryAdd(item, position)) {
          return this.page(acc, 'title', true, params.categoryId, position);
        }
      }
      return this.page(acc, 'title', false, params.categoryId);
    }
    const ranges = params.categoryId ? this.rangesForCategory(params.categoryId) : [[0, this.entryCount - 1]];
    const acc = new PageAccumulator<CatalogItem>();
    const startOrdinal = cursor && cursor.ordinal !== undefined ? cursor.ordinal : 0;
    let resumeOrdinal = startOrdinal;
    for (const range of ranges) {
      if (range[1] < startOrdinal) continue;
      const from = Math.max(range[0], startOrdinal);
      for (let ordinal = from; ordinal <= range[1]; ordinal++) {
        const item = this.readItem(ordinal);
        resumeOrdinal = ordinal + 1;
        if (!acc.tryAdd(item, ordinal)) {
          return this.page(acc, 'source', true, params.categoryId, ordinal);
        }
      }
    }
    return this.page(acc, 'source', false, params.categoryId);
  }

  /**
   * Recherche indexée : recherche binaire sur l'index épars, puis balayage borné à la page.
   * Aucun parcours linéaire, aucun tri en mémoire, aucune construction du tableau complet.
   */
  search(params: { query: string; cursor?: Cursor }): CatalogPage<CatalogItem> {
    const normalizedQuery = normalizeQuery(params.query);
    const queryKey = hash32(normalizedQuery);
    const approximate = this.manifest.state !== 'valid';
    if (normalizedQuery === '') {
      return { items: [], indexVersion: this.indexVersion, approximate };
    }
    const cursor = params.cursor;
    let startPosition: number;
    if (cursor) {
      if (cursor.order !== 'search') throw new AppError('catalog/indexChanged', 'curseur de recherche utilise sur un autre ordre');
      this.assertCursorCompatible(cursor, 'search', queryKey);
      startPosition = cursor.ordinal !== undefined ? cursor.ordinal : 0;
    } else {
      startPosition = this.firstPositionWithPrefix(normalizedQuery);
    }
    const acc = new PageAccumulator<CatalogItem>();
    const queryKeyBytes = sortKey(normalizedQuery, this.sparseKeyBytes);
    for (let position = startPosition; position < this.entryCount; position++) {
      const ordinal = this.denseOrdinal(position);
      const record = this.readSlotAndInline(ordinal);
      const titleKey = sortKey(record.slot.titleNormalized, this.sparseKeyBytes);
      const matches = record.slot.titleNormalized.indexOf(normalizedQuery) === 0;
      if (!matches && compareKeys(titleKey, queryKeyBytes) > 0) {
        // l'ordre alphabétique est contigu : plus aucune correspondance possible après ce point
        return this.page(acc, 'search', false, undefined, undefined, queryKey);
      }
      if (matches) {
        const item = this.buildItem(ordinal, record.slot, record.inline);
        if (!acc.tryAdd(item, position)) {
          return this.page(acc, 'search', true, undefined, position, queryKey);
        }
      }
    }
    return this.page(acc, 'search', false, undefined, undefined, queryKey);
  }

  /** Description complète d'un élément : seule voie d'accès aux charges lourdes (§15.2). */
  getDetails(ordinal: number): { item: CatalogItem; heavy: HeavyPayload } {
    const record = this.readSlotAndInline(ordinal);
    const heavy = this.readHeavy(record.slot.payloadOffset, record.slot.payloadLength);
    return { item: this.buildItem(ordinal, record.slot, record.inline), heavy };
  }

  /** Recherche de l'ordinal d'une entrée à partir de son `refHash` (contrôle, tests, reprise). */
  /** Diagnostic : clé de tri effectivement utilisée par l'index épars. */
  get sortKeyBytes(): number {
    return this.sparseKeyBytes;
  }

  findOrdinalByRefHash(refHash: string): number | null {
    for (let position = 0; position < this.entryCount; position++) {
      const ordinal = this.denseOrdinal(position);
      const slot = this.readSlot(ordinal);
      if (slot.refHash === refHash) return ordinal;
    }
    return null;
  }

  close(): void {
    this.records.close();
    this.payload.close();
    this.title.close();
    this.buckets.close();
    this.groups.close();
  }

  /* ------------------------------------------------------------------ interne */

  private page(
    acc: PageAccumulator<CatalogItem>,
    order: 'source' | 'title' | 'search',
    truncated: boolean,
    categoryId?: string,
    nextOrdinal?: number,
    queryKey?: string
  ): CatalogPage<CatalogItem> {
    const result = acc.result();
    result.truncated = truncated;
    const totalKnown = order === 'search' ? undefined : categoryId ? this.countForCategory(categoryId) : this.entryCount;
    const page = makePage<CatalogItem>({
      result,
      indexVersion: this.indexVersion,
      contentType: this.options.contentType,
      order,
      approximate: this.manifest.state !== 'valid',
      totalKnown,
      nextOrdinal: nextOrdinal,
      queryKey: queryKey
    });
    this.stats.bytesReturned += result.bytes;
    if (result.bytes > MAX_PAGE_BYTES) {
      // garde-fou : la coupure doit se produire avant la limite (§15.2)
      throw new AppError('catalog/corrupt', 'page au-dela du plafond d octets');
    }
    return page;
  }

  private countForCategory(categoryId: string): number | undefined {
    for (const group of this.getGroups()) {
      if (group.id === categoryId) return group.count;
    }
    return undefined;
  }

  private rangesForCategory(categoryId: string): number[][] {
    for (const group of this.getGroups()) {
      if (group.id === categoryId) return group.ranges.length > 0 ? group.ranges : [];
    }
    return [];
  }

  private assertCursorCompatible(cursor: Cursor, expectedOrder: Cursor['order'], queryKey?: string): void {
    if (cursor.indexVersion !== this.indexVersion) {
      throw new AppError('catalog/indexChanged', 'curseur d une version d index revolue', 'rejouer la meme requete');
    }
    if (cursor.order !== expectedOrder) {
      throw new AppError('catalog/indexChanged', 'curseur reutilise sur un autre ordre de tri');
    }
    if (expectedOrder === 'search' && cursor.queryKey !== queryKey) {
      throw new AppError('catalog/indexChanged', 'curseur de recherche lie a une autre requete');
    }
    if (cursor.contentType !== this.options.contentType) {
      throw new AppError('catalog/indexChanged', 'curseur d un autre type de contenu');
    }
  }

  private readSlot(ordinal: number) {
    const size = this.getRecordSize();
    const bytes = this.records.readRange(ordinal * size, SLOT_SIZE);
    this.stats.recordsRead += 1;
    return decodeSlot(bytes);
  }

  private readSlotAndInline(ordinal: number) {
    const size = this.getRecordSize();
    const bytes = this.records.readRange(ordinal * size, size);
    this.stats.recordsRead += 1;
    const slot = decodeSlot(bytes.slice(0, SLOT_SIZE));
    const inline = decodeInlinePayload(bytes.slice(SLOT_SIZE, SLOT_SIZE + slot.inlineLength));
    return { slot, inline };
  }

  /** Lecture d'une entrée complète (secteur + charge courte) pour une page de liste. */
  private readItem(ordinal: number): CatalogItem {
    const record = this.readSlotAndInline(ordinal);
    return this.buildItem(ordinal, record.slot, record.inline);
  }

  private readHeavy(offset: number, length: number): HeavyPayload {
    if (length === 0) return {};
    this.stats.payloadsRead += 1;
    const bytes = this.payload.readRange(offset, length);
    return decodeHeavyPayload(bytes);
  }

  private buildItem(ordinal: number, slot: ReturnType<typeof decodeSlot>, inline: InlinePayload): CatalogItem {
    const ref: ContentRef = {
      profileId: this.options.profileId,
      contentType: this.options.contentType,
      displayName: inline.t
    };
    if (inline.r) {
      if (this.options.refKind === 'providerId') ref.providerId = inline.r;
      else ref.sourceKey = inline.r;
    }
    const hostSafety = decodeHostSafety(slot.flags) as HostSafety;
    const item: CatalogItem = {
      ref,
      categoryId: inline.g,
      title: inline.t,
      sourceOrder: slot.sourceOrder,
      hostSafety,
      playable: (slot.flags & 0x04) !== 0
    };
    if (inline.l) item.logoOrPosterUrl = inline.l;
    if (inline.e) item.epgId = inline.e;
    if (inline.y !== undefined) item.year = inline.y;
    if (inline.d !== undefined) item.durationSeconds = inline.d;
    if (inline.s) item.summary = inline.s;
    void ordinal;
    return item;
  }

  private readJsonFile(reader: BlockFileRandomReader): Record<string, unknown> {
    const text = reader.readAll().toString('utf8').replace(/\u0000+$/g, '');
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch (_err) {
      throw new AppError('catalog/corrupt', 'fichier d index illisible');
    }
  }

  private denseOrdinal(position: number): number {
    const offset = 8 + this.sparseCount * TITLE_SPARSE_ENTRY_BYTES + position * 4;
    const bytes = this.title.readRange(offset, 4);
    return bytes.readUInt32BE(0);
  }

  /** Recherche binaire sur l'index épars : premier bloc dont la clé >= celle de la requête. */
  private firstPositionWithPrefix(normalizedQuery: string): number {
    const key = sortKey(normalizedQuery, this.sparseKeyBytes);
    if (this.sparseCount === 0) return 0;
    const stride = this.manifest.titleSparseStride || TITLE_SPARSE_STRIDE;
    let low = 0;
    let high = this.sparseCount - 1;
    let answer = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const entry = this.title.readRange(8 + mid * TITLE_SPARSE_ENTRY_BYTES, TITLE_SPARSE_ENTRY_BYTES);
      const cmp = compareKeys(entry.slice(0, this.sparseKeyBytes), key);
      if (cmp >= 0) {
        answer = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    if (answer === -1) {
      // La requête trie au-delà de tous les points épars : seule la dernière tranche peut contenir
      // une correspondance, inutile de balayer depuis le début du catalogue.
      return Math.max(0, (this.sparseCount - 1) * stride);
    }
    // On repart du bloc épars **précédent** : la région de correspondance peut commencer à
    // l'intérieur du bloc courant, les entrées entre deux points épars n'étant pas contraintes.
    return Math.max(0, (answer - 1) * stride);
  }
}

function compareKeys(a: Buffer, b: Buffer): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = a[i] - b[i];
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

function join(base: string, name: string): string {
  return base.replace(/[\\/]$/, '') + '/' + name;
}

export { filePathFor };
