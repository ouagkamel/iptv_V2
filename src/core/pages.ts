/**
 * Construction de page bornée (§15.2) : **≤ 200 objets ET ≤ 256 Kio de JSON UTF-8**.
 *
 * Le service coupe la page *avant* la limite d'octets si les objets sont lourds et renvoie un
 * curseur valide : il ne dépasse jamais la limite pour « finir » la page. La taille en octets est
 * calculée sans `Buffer` ni `TextEncoder` (module partagé avec l'interface, exécutable Node 8.12).
 */

import type { CatalogPage, Cursor } from '../contracts/types';

export const MAX_PAGE_OBJECTS = 200;
export const MAX_PAGE_BYTES = 256 * 1024;

/** Longueur UTF-8 sans dépendre de `Buffer` (disponible aussi côté interface). */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Poids d'un objet tel qu'il sera sérialisé dans la réponse LS2 (clés + valeurs + accolades). */
export function jsonByteLength(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value) === undefined ? '' : String(JSON.stringify(value)));
}

export interface PageBuildResult<T> {
  items: T[];
  /** vrai si des éléments ont été écartés à cause d'un plafond */
  truncated: boolean;
  bytes: number;
  /** ordinal du dernier élément retenu (base du curseur suivant) */
  lastOrdinal: number | null;
}

export interface BuildPageOptions {
  /** ordinal du premier élément candidat */
  startOrdinal: number;
  /** ordinal du dernier élément disponible (inclus) ; null si inconnu */
  endOrdinal: number | null;
  /**
   * Producteur paresseux : appelé pour chaque ordinal candidat et renvoie `null` pour ignorer
   * l'entrée (catégorie non retenue, filtre). Le producteur ne doit jamais construire le
   * tableau complet en mémoire.
   */
  producer: (ordinal: number) => { item: unknown; ordinal: number } | null;
  /** décide si la consommation s'arrête (fin de catégorie, fin de correspondance de préfixe) */
  stopAfter?: (ordinal: number) => boolean;
}

/**
 * Accumulateur borné : la page est coupée dès que le premier plafond (200 objets ou 256 Kio) est
 * atteint. Un appelant qui parcourt plusieurs plages (index par groupes) peut l'alimenter
 * plage après plage sans jamais reconstruire de tableau intermédiaire.
 */
export class PageAccumulator<T> {
  readonly items: T[] = [];
  bytes = 2; // « [ » et « ] »
  truncated = false;
  lastOrdinal: number | null = null;
  lastConsumedOrdinal: number | null = null;

  get full(): boolean {
    return this.truncated;
  }

  /** Ajoute un élément ; renvoie false si la page est déjà pleine (l'élément n'est pas ajouté). */
  tryAdd(item: T, ordinal: number): boolean {
    if (this.items.length >= MAX_PAGE_OBJECTS) {
      this.truncated = true;
      return false;
    }
    const itemBytes = jsonByteLength(item) + 1;
    if (this.bytes + itemBytes > MAX_PAGE_BYTES) {
      this.truncated = true;
      return false;
    }
    this.items.push(item);
    this.bytes += itemBytes;
    this.lastOrdinal = ordinal;
    return true;
  }

  result(): PageBuildResult<T> {
    return {
      items: this.items,
      truncated: this.truncated,
      bytes: this.bytes,
      lastOrdinal: this.lastOrdinal
    };
  }
}

/**
 * Consomme les entrées une par une, en coupant à 200 objets ou 256 Kio — le premier plafond
 * atteint gagne. `truncated` indique qu'un curseur doit être renvoyé.
 */
export function buildBoundedPage<T>(options: BuildPageOptions): PageBuildResult<T> {
  const acc = new PageAccumulator<T>();
  let ordinal = options.startOrdinal;
  let inspectCount = 0;
  const maxInspect = 20000; // borne dure contre un index corrompu : jamais de parcours linéaire
  while (options.endOrdinal === null || ordinal <= options.endOrdinal) {
    if (inspectCount >= maxInspect) {
      acc.truncated = true;
      break;
    }
    inspectCount += 1;
    const produced = options.producer(ordinal);
    if (produced !== null) {
      acc.lastConsumedOrdinal = produced.ordinal;
      if (!acc.tryAdd(produced.item as T, produced.ordinal)) break;
    }
    if (options.stopAfter && options.stopAfter(ordinal)) break;
    ordinal += 1;
  }
  return acc.result();
}

/** Assemble la page finale (curseur absent ⇒ fin de liste). */
export function makePage<T>(options: {
  result: PageBuildResult<T>;
  indexVersion: number;
  contentType: Cursor['contentType'];
  order: Cursor['order'];
  approximate: boolean;
  totalKnown?: number;
  queryKey?: string;
  /** ordinal à reprendre dans la page suivante */
  nextOrdinal?: number;
}): CatalogPage<T> {
  const { result } = options;
  const page: CatalogPage<T> = {
    items: result.items,
    indexVersion: options.indexVersion,
    approximate: options.approximate
  };
  if (options.totalKnown !== undefined) page.totalKnown = options.totalKnown;
  if (result.truncated && options.nextOrdinal !== undefined) {
    const cursor: Cursor = {
      indexVersion: options.indexVersion,
      contentType: options.contentType,
      order: options.order,
      ordinal: options.nextOrdinal
    };
    if (options.queryKey !== undefined) cursor.queryKey = options.queryKey;
    page.cursor = cursor;
  }
  return page;
}
