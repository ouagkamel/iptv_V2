/** Constantes partagées par l'écrivain et le lecteur d'index. */

/** Catégorie de repli quand une entrée n'a pas de groupe (jamais un groupe vide affiché). */
export const CATEGORY_NONE = '__sans_groupe__';

/** Schémas d'enregistrement : leur empreinte entre dans l'en-tête et l'AAD (§15.3). */
export const SCHEMA_RECORDS = 'iptv/index/v1/records:slot128+inline';
export const SCHEMA_PAYLOAD = 'iptv/index/v1/payload';
export const SCHEMA_TITLE = 'iptv/index/v1/title:sparse32+dense';
export const SCHEMA_BUCKETS = 'iptv/index/v1/buckets';
export const SCHEMA_GROUPS = 'iptv/index/v1/groups';
/** Index dense `refHash → ordinal` : résout une référence en O(log n), jamais par balayage. */
export const SCHEMA_REFS = 'iptv/index/v1/refs:hash16+ordinal4';

/** Types de fichiers chiffrés ; chacun a son propre sel de dérivation (voir IndexKeyParams). */
export const FILE_KINDS = ['records', 'payload', 'title', 'buckets', 'groups', 'refs'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** Taille de la charge courte enregistrée en ligne dans `records.bin`. */
export const DEFAULT_INLINE_SIZE = 384;

/** Pas de l'index épars de titres (§15.2 : « toutes les 32 entrées »). */
export const TITLE_SPARSE_STRIDE = 32;

/** Octets de clé conservés par entrée éparse : 8 normatifs + 8 de discrimination. */
export const TITLE_SPARSE_KEY_BYTES = 16;

/** Octets par entrée de l'index de références : 16 octets d'empreinte + 4 octets d'ordinal. */
export const REF_ENTRY_BYTES = 20;

/** Octets par entrée éparse : clé de tri + u32 ordinal source. */
export const TITLE_SPARSE_ENTRY_BYTES = TITLE_SPARSE_KEY_BYTES + 4;

/** Rétention de l'ancien index après bascule (§2.4 : valeur de départ 30 s). */
export const PREVIOUS_INDEX_RETENTION_MS = 30000;
