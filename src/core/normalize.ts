/**
 * Normalisation partagée (§9.3) — **un seul module** pour la correspondance EPG, les clés de tri,
 * la recherche et les tranches alphabétiques. Sa duplication par écran est interdite.
 *
 * Règles :
 *  - le titre affiché n'est jamais modifié ; ce module ne produit que des clés ;
 *  - la normalisation n'entre pas dans `sourceKey`/`variantKey` (§5.3) ;
 *  - cible Node 8.12 : pas d'échappement de propriété Unicode (`\p{...}`), pas de `normalize`
 *    exotique, pas de `String.prototype.normalize` absent (il existe depuis ES2015).
 *
 * Chaîne de traitement : NFKD → suppression des diacritiques → repli de casse → retrait des
 * préfixes fournisseur → retrait des suffixes qualité/langue → retrait de l'article initial →
 * compactage des espaces.
 */

/** Préfixes fournisseur : `FR|`, `|4K|`, `[VIP]`, flèches et emoji. */
const LEADING_TOKEN_RE = /^\s*(?:\[[^\]]{0,16}\]|\([^)]{0,16}\)|\|[^|]{0,16}\||[A-Za-z0-9]{1,4}\s*\||\|\s*)\s*/;
const EMOJI_RE = /[\u2190-\u21FF\u2300-\u27BF\u2B00-\u2BFF\uFE0F\u20E3]|[\uD83C-\uDBFF][\uDC00-\uDFFF]/g;

/** Suffixes qualité / langue (§9.3), retirés en fin de chaîne, séparateur toléré. */
const QUALITY_SUFFIXES = [
  'fhd', 'uhd', '4k', '8k', '2k', 'hevc', 'h265', 'h264', 'hd', 'sd', '1080p', '720p', '1080i',
  'multi', 'multi-audio', 'vf', 'vostfr', 'vo', 'fr', 'en', 'ar', 'de', 'es', 'it', 'pt', 'ru',
  'tr', 'nl', 'pl', 'raw'
];

/** Articles initiaux retirés pour le tri uniquement (§9.3). */
const LEADING_ARTICLES = [
  'les', 'le', 'la', 'des', 'du', 'de', 'une', 'un', 'the', 'a', 'an',
  'los', 'las', 'el', 'il', 'lo', 'gli', 'al'
];

const ARABIC_ARTICLE = '\u0627\u0644'; // ال

/** Diacritiques / signes à retirer par écriture. */
const ARABIC_MARKS_RE = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED\u0640]/g;
const HEBREW_MARKS_RE = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g;
const LATIN_GREEK_MARKS_RE = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF]/g;

/** Replis arabes exigés par §9.1. */
const ARABIC_FOLDS: Array<[RegExp, string]> = [
  [/[\u0622\u0623\u0625\u0627\u0671]/g, '\u0627'], // آ أ إ ا ٱ → ا
  [/\u0629/g, '\u0647'], // ة → ه
  [/[\u0649\u064A]/g, '\u064A'], // ى ي → ي
  [/\u0624/g, '\u0648'], // ؤ → و
  [/\u0626/g, '\u064A'], // ئ → ي
  [/[\u0643]/g, '\u0643'] // garde-fou de lisibilité
];

/** Replis grecs (accents, tréma). */
const GREEK_FOLDS: Array<[RegExp, string]> = [
  [/[\u03AC]/g, '\u03B1'],
  [/[\u03AD]/g, '\u03B5'],
  [/[\u03AE]/g, '\u03B7'],
  [/[\u03AF\u03CA\u0390]/g, '\u03B9'],
  [/[\u03CC]/g, '\u03BF'],
  [/[\u03CD\u03CB\u03B0]/g, '\u03C5'],
  [/[\u03CE]/g, '\u03C9'],
  [/[\u03C2]/g, '\u03C3']
];

export interface NormalizeOptions {
  /** retirer les préfixes/suffixes fournisseur (par défaut : oui) */
  stripProviderAffixes?: boolean;
  /** retirer l'article initial (par défaut : oui) */
  stripLeadingArticle?: boolean;
}

/** Pas de \p{...} : Node 8.12 ne connaît pas les échappements de propriété Unicode. */
function isCombining(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  );
}

function foldArabic(input: string): string {
  let out = input.replace(ARABIC_MARKS_RE, '');
  for (const [re, replacement] of ARABIC_FOLDS) out = out.replace(re, replacement);
  return out;
}

function foldHebrew(input: string): string {
  return input.replace(HEBREW_MARKS_RE, '');
}

function foldGreek(input: string): string {
  let out = input;
  for (const [re, replacement] of GREEK_FOLDS) out = out.replace(re, replacement);
  return out;
}

/**
 * Ligatures et lettres sans décomposition de compatibilité : sans ce tableau,
 * `Cœur` ne rejoindrait pas `Coeur` dans une recherche.
 */
const LIGATURES: Array<[RegExp, string]> = [
  [/\u0153/g, 'oe'], // œ
  [/\u0152/g, 'OE'],
  [/\u00e6/g, 'ae'], // æ
  [/\u00c6/g, 'AE'],
  [/\u00df/g, 'ss'], // ß
  [/\u00f8/g, 'o'],
  [/\u00d8/g, 'O'],
  [/\u0142/g, 'l'],
  [/\u0111/g, 'd'],
  [/\u00f0/g, 'd'],
  [/\u00fe/g, 'th'],
  [/\u0131/g, 'i']
];

/** NFKD + suppression des diacritiques, sans toucher aux écritures qui portent du sens. */
export function foldDiacritics(input: string): string {
  let folded = input;
  for (const [re, replacement] of LIGATURES) folded = folded.replace(re, replacement);
  return foldDecomposed(folded);
}

function foldDecomposed(input: string): string {
  const decomposed = input.normalize('NFKD');
  let out = '';
  for (const ch of decomposed) {
    const code = ch.codePointAt(0) as number;
    if (!isCombining(code)) out += ch;
  }
  return out.replace(EMOJI_RE, ' ');
}

function stripAffixes(input: string): string {
  let out = input.trim();
  // jusqu'à deux préfixes du type `[VIP]`, `FR|`
  for (let i = 0; i < 2; i++) {
    const next = out.replace(LEADING_TOKEN_RE, '');
    if (next === out) break;
    out = next.trim();
  }
  out = out.replace(/^[|\[\]()\-–—•·:.\s]+/, '');
  // suffixes qualité/langue, bornés (au plus trois)
  for (let i = 0; i < 3; i++) {
    const m = /[\s|._-]+([A-Za-z0-9-]+)\s*$/.exec(out);
    if (!m) break;
    const token = m[1].toLowerCase();
    if (QUALITY_SUFFIXES.indexOf(token) === -1) break;
    out = out.slice(0, m.index).trim();
  }
  return out;
}

function stripLeadingArticle(input: string): string {
  if (input.lastIndexOf(ARABIC_ARTICLE, 0) === 0 && input.length > ARABIC_ARTICLE.length + 1) {
    return input.slice(ARABIC_ARTICLE.length);
  }
  const apostrophe = /^(l['\u2019])(.+)$/i.exec(input);
  if (apostrophe) return apostrophe[2];
  for (const article of LEADING_ARTICLES) {
    if (input.indexOf(article + ' ') === 0) return input.slice(article.length + 1);
  }
  return input;
}

/** Clé de tri/recherche : chaîne normalisée, sans accents, minuscule. */
export function normalizeTitle(raw: string, options: NormalizeOptions = {}): string {
  const strip = options.stripProviderAffixes !== false;
  const keepArticle = options.stripLeadingArticle === false;
  if (typeof raw !== 'string') return '';
  let title = foldDiacritics(raw).replace(/\s+/g, ' ').trim();
  if (title === '') return '';
  title = foldArabic(title);
  title = foldHebrew(title);
  title = foldGreek(title);
  title = title.toLowerCase();
  if (strip) title = stripAffixes(title);
  title = foldDiacritics(title).replace(/\s+/g, ' ').trim();
  if (title === '') return '';
  if (!keepArticle) {
    const withoutArticle = stripLeadingArticle(title);
    if (withoutArticle.length > 1) title = withoutArticle;
  }
  return title.replace(/\s+/g, ' ').trim();
}

/** Clé de recherche d'une requête utilisateur : même traitement, mais mots-arrêts conservés. */
export function normalizeQuery(raw: string): string {
  return normalizeTitle(raw, { stripProviderAffixes: true, stripLeadingArticle: false });
}

/** Titre normalisé pour l'affichage trié secondaire (jamais affiché tel quel). */
export function normalizeForDisplaySort(raw: string): string {
  return normalizeTitle(raw, { stripProviderAffixes: false, stripLeadingArticle: false });
}

/** Empreinte courte et stable, utilisée comme `queryKey` dans un curseur de recherche. */
export function hash32(input: string): string {
  // djb2-xor 32 bits, suffisant pour une empreinte de requête (jamais un secret).
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}
