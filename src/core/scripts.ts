/**
 * Scripts et tranches alphabétiques (§9.1) — `AlphabetNavigator` à stratégies **explicites**.
 *
 * Les tranches proviennent des scripts réellement présents dans les **données indexées**, jamais
 * de la locale de l'interface : une interface française sur un catalogue arabe affiche les
 * tranches arabes. Le service produit `BucketSet` (§15.2), l'UI ne recalcule rien.
 */

import type { BucketSet, ScriptId } from '../contracts/types';
import { normalizeTitle } from './normalize';

export interface ScriptDetection {
  script: ScriptId;
  /** première lettre retenue pour la tranche (`#` si aucune lettre exploitable) */
  bucketKey: string;
}

const LATIN_RE = /[a-z\u00DF-\u00FF\u0100-\u017F\u0180-\u024F]/;
const ARABIC_RE = /[\u0621-\u064A\u066E-\u06D3\u06FA-\u06FC]/;
const CYRILLIC_RE = /[\u0400-\u04FF]/;
const HEBREW_RE = /[\u05D0-\u05EA\u05EF-\u05F2]/;
const GREEK_RE = /[\u0391-\u03A9\u03B1-\u03C9]/;
const HANGUL_RE = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/;
const KANA_RE = /[\u3040-\u309F\u30A0-\u30FF]/;
const HAN_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const NUMERIC_RE = /[0-9]/;

/** Les 28 lettres arabes dans l'ordre alphabétique de tri (après repli §9.1). */
export const ARABIC_ORDER = '\u0627\u0628\u062A\u062B\u062C\u062D\u062E\u062F\u0630\u0631\u0632\u0633\u0634\u0635\u0636\u0637\u0638\u0639\u063A\u0641\u0642\u0643\u0644\u0645\u0646\u0647\u0648\u064A';
export const CYRILLIC_ORDER = 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЭЮЯ';
export const GREEK_ORDER = 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ';
export const HEBREW_ORDER = '\u05D0\u05D1\u05D2\u05D3\u05D4\u05D5\u05D6\u05D7\u05D8\u05D9\u05DB\u05DC\u05DE\u05E0\u05E1\u05E2\u05E3\u05E4\u05E5\u05E6\u05E7\u05E8\u05E9\u05EA';
export const LATIN_ORDER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const CJK_RANGE_LABELS: Array<[RegExp, string]> = [
  [HAN_RE, '漢'],
  [HANGUL_RE, '한'],
  [KANA_RE, 'かな']
];

/**
 * Détecte le script d'un titre normalisé et la tranche correspondante.
 * `#` regroupe ce qui n'a pas de lettre exploitable (dont les titres latins d'un catalogue arabe,
 * conformément à §9.1).
 */
export function detectScript(rawTitle: string): ScriptDetection {
  return detectNormalizedScript(normalizeTitle(rawTitle));
}

/** Détection à partir d'un titre déjà normalisé (§9.1). */
export function detectNormalizedScript(normalized: string): ScriptDetection {
  if (normalized === '') return { script: 'numeric', bucketKey: '#' };
  const first = firstStrongChar(normalized);
  if (first === null) return { script: 'numeric', bucketKey: '#' };
  const ch = first;
  const upper = ch.toUpperCase();
  if (LATIN_RE.test(ch)) return { script: 'latin', bucketKey: upper };
  if (NUMERIC_RE.test(ch)) return { script: 'numeric', bucketKey: ch };
  if (ARABIC_RE.test(ch)) return { script: 'arabic', bucketKey: ch };
  if (CYRILLIC_RE.test(ch)) return { script: 'cyrillic', bucketKey: upper };
  if (HEBREW_RE.test(ch)) return { script: 'hebrew', bucketKey: ch };
  if (GREEK_RE.test(ch)) return { script: 'greek', bucketKey: upper };
  for (const [re, label] of CJK_RANGE_LABELS) {
    if (re.test(ch)) return { script: 'cjk', bucketKey: label };
  }
  return { script: 'numeric', bucketKey: '#' };
}

function firstStrongChar(normalized: string): string | null {
  for (const ch of normalized) {
    if (/\s/.test(ch)) continue;
    if (/[0-9a-z\u00DF-\u024F\u0391-\u03C9\u0400-\u04FF\u05D0-\u05EA\u0621-\u06FC\u3040-\u9FFF\uAC00-\uD7A3]/i.test(ch)) {
      return ch;
    }
    // ponctuation ou symbole : on continue jusqu'à un caractère exploitable
  }
  return null;
}

/** Ordre canonique d'affichage des tranches pour un script donné. */
export function bucketOrder(script: ScriptId): string[] {
  switch (script) {
    case 'latin':
      return LATIN_ORDER.split('');
    case 'arabic':
      return ARABIC_ORDER.split('');
    case 'cyrillic':
      return CYRILLIC_ORDER.split('');
    case 'hebrew':
      return HEBREW_ORDER.split('');
    case 'greek':
      return GREEK_ORDER.split('');
    case 'numeric':
      return '0123456789'.split('');
    case 'cjk':
      return ['漢', '한', 'かな'];
  }
}

export interface BucketAccumulator {
  /** clé `script|bucket` → compteur */
  counts: Record<string, number>;
  /** clé `script|bucket` → ordinal du premier élément rencontré (ordre trié) */
  firstOrdinal: Record<string, number>;
  totals: Record<string, number>;
}

export function createBucketAccumulator(): BucketAccumulator {
  return { counts: {}, firstOrdinal: {}, totals: {} };
}

/** Appelé une fois par entrée, dans l'ordre alphabétique (ordinal croissant). */
export function accumulateBucket(acc: BucketAccumulator, rawTitle: string, ordinal: number): void {
  accumulateNormalized(acc, normalizeTitle(rawTitle), ordinal);
}

/**
 * Variante pour un titre **déjà normalisé** : l'écrivain d'index ne renormalise pas 250 000 titres
 * deux fois (§11.1 : un seul module de normalisation, un seul passage par entrée).
 */
export function accumulateNormalized(acc: BucketAccumulator, normalizedTitle: string, ordinal: number): void {
  const detected = detectNormalizedScript(normalizedTitle);
  const key = detected.script + '|' + detected.bucketKey;
  acc.counts[key] = (acc.counts[key] || 0) + 1;
  if (acc.firstOrdinal[key] === undefined) acc.firstOrdinal[key] = ordinal;
  acc.totals[detected.script] = (acc.totals[detected.script] || 0) + 1;
}

/** Script dominant : celui qui porte le plus d'entrées (hors tranche `#` isolée). */
export function dominantScript(acc: BucketAccumulator): ScriptId {
  const candidates: ScriptId[] = ['latin', 'arabic', 'cyrillic', 'hebrew', 'greek', 'cjk', 'numeric'];
  let best: ScriptId = 'latin';
  let bestCount = -1;
  for (const script of candidates) {
    const count = acc.totals[script] || 0;
    if (count > bestCount) {
      best = script;
      bestCount = count;
    }
  }
  return bestCount <= 0 ? 'latin' : best;
}

/** Assemble le `BucketSet` renvoyé au service (jamais recalculé côté UI). */
export function buildBucketSet(acc: BucketAccumulator): BucketSet {
  const script = dominantScript(acc);
  const order = bucketOrder(script);
  const buckets: BucketSet['buckets'] = [];
  for (const key of order) {
    const composite = script + '|' + key;
    const count = acc.counts[composite] || 0;
    if (count === 0) continue; // les tranches vides sont masquées (§9.1)
    buckets.push({ key, count, startOrdinal: acc.firstOrdinal[composite] as number });
  }
  const hashKey = script + '|#';
  const hashCount = acc.counts[hashKey] || 0;
  if (hashCount > 0) {
    // `#` toujours en fin de liste s'il existe des entrées sans tranche exploitable
    buckets.push({ key: '#', count: hashCount, startOrdinal: acc.firstOrdinal[hashKey] as number });
  }
  // Titres écrits dans un autre script : regroupés dans `#` du script dominant (§9.1,
  // « les titres purement latins d'un catalogue arabe restent dans # »).
  const candidates: ScriptId[] = ['latin', 'arabic', 'cyrillic', 'hebrew', 'greek', 'cjk', 'numeric'];
  let otherCount = 0;
  let otherFirst = Number.MAX_SAFE_INTEGER;
  for (const other of candidates) {
    if (other === script) continue;
    const keys = bucketOrder(other).concat(['#']);
    for (const key of keys) {
      const composite = other + '|' + key;
      const count = acc.counts[composite] || 0;
      if (count > 0) {
        otherCount += count;
        otherFirst = Math.min(otherFirst, acc.firstOrdinal[composite] as number);
      }
    }
  }
  if (otherCount > 0) {
    const hashEntry = buckets.filter((bucket) => bucket.key === '#')[0];
    if (hashEntry) {
      hashEntry.count += otherCount;
      hashEntry.startOrdinal = Math.min(hashEntry.startOrdinal, otherFirst);
    } else {
      buckets.push({ key: '#', count: otherCount, startOrdinal: otherFirst });
    }
  }
  if (buckets.length === 0) {
    buckets.push({ key: '#', count: 0, startOrdinal: 0 });
  }
  return { script, buckets, generatedFrom: 'index' };
}

/** Ordinal de départ d'une tranche dans un `BucketSet`, pour le saut alphabétique. */
export function bucketStartOrdinal(set: BucketSet, key: string): number | null {
  for (const bucket of set.buckets) {
    if (bucket.key === key) return bucket.startOrdinal;
  }
  return null;
}
