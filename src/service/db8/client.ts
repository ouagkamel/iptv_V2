/**
 * Accès DB8 (§2.4, §8.1) — profils, préférences, favoris, correspondances EPG, reprises, `ImportJob`
 * et clé maître. **Jamais le catalogue** : les index compacts vivent dans l'espace privé du service.
 *
 * Le client ne dépend pas de `webos-service` : il reçoit une fonction d'appel LS2 (`call`). Sur la
 * TV, cette fonction est fournie par l'enregistrement `webos-service` ; en test, par un faux bus
 * en mémoire qui reproduit la sémantique de `put`/`find`/`del` (exact-match sur `where`).
 *
 * Règles portées ici :
 *  - les `kinds` sont préfixés par l'ID de l'application et **versionnés** ;
 *  - toute réponse est validée à l'exécution : on ne suppose jamais qu'un appel LS2 a réussi ;
 *  - aucun identifiant, aucune URL de flux et aucune clé ne peut être journalisé par ce module
 *    (les valeurs sensibles ne sortent qu'en retour d'appel).
 */

import { AppError } from '../../contracts/errors';

export const APP_ID = 'com.ouagkamel.app.iptvplayer';
export const DB_SERVICE = 'com.webos.service.db';

/**
 * Kinds versionnés : le numéro change si le schéma change (migration explicite, jamais silencieuse).
 *
 * Passés à **2** en 0.1.11 : les kinds v1 avaient été enregistrés **sans index**, et DB8 n'ajoute pas
 * d'index à un kind existant. Or « All queries must be on indexed fields » (guide DB8 de LG) : une
 * requête sur un champ non indexé ne renvoie rien (ou échoue), ce qui faisait perdre la clé maître —
 * l'index du catalogue devenait illisible avec le message trompeur « clé maître absente ». Les kinds
 * v2 sont créés avec leurs index ; les v1 restent sur l'appareil, inutilisés (le catalogue doit être
 * réimporté une fois, de toute façon illisible).
 */
export const KIND_VERSIONS = {
  profiles: 2,
  preferences: 2,
  favorites: 2,
  playbacks: 2,
  epgMappings: 2,
  importJobs: 2,
  masterKeys: 2,
  consents: 2,
  probes: 1
} as const;

export type KindName = keyof typeof KIND_VERSIONS;

/**
 * Index déclarés à `putKind`. DB8 n'accepte une requête que sur `_id`, `_kind` et ces propriétés :
 * la liste suit exactement ce que les dépôts interrogent (aucun index superflu, aucun champ
 * interrogé sans index). Toute requête hors de cette liste est refusée **côté client** avant d'être
 * envoyée : mieux vaut une erreur immédiate et explicite qu'un résultat vide qui a l'air valide.
 */
export const KIND_INDEXES: Record<KindName, Array<{name: string; props: string[]}>> = {
  profiles: [{name: 'id', props: ['id']}],
  preferences: [{name: 'profileId', props: ['profileId']}],
  favorites: [{name: 'profileId', props: ['profileId']}, {name: 'key', props: ['key']}],
  playbacks: [{name: 'profileId', props: ['profileId']}, {name: 'key', props: ['key']}],
  epgMappings: [{name: 'profileId', props: ['profileId']}],
  importJobs: [{name: 'jobId', props: ['jobId']}, {name: 'profileId', props: ['profileId']}],
  masterKeys: [{name: 'profileId', props: ['profileId']}],
  consents: [{name: 'profileId', props: ['profileId']}],
  probes: [{name: 'cle', props: ['cle']}]
};

/** Propriétés interrogeables d'un kind : `_id`, `_kind` et les propriétés indexées. */
export function champsInterrogeables(name: KindName): string[] {
  const champs = ['_id', '_kind'];
  KIND_INDEXES[name].forEach((index) => index.props.forEach((prop) => champs.push(prop)));
  return champs;
}

/** Toute propriété non indexée présente dans un `where` : doit rester vide, sinon la requête est invalide. */
export function champsNonIndexes(name: KindName, where: Record<string, unknown>): string[] {
  const permis = champsInterrogeables(name);
  return Object.keys(where).filter((champ) => permis.indexOf(champ) === -1);
}

export function kindOf(name: KindName): string {
  return APP_ID + ':db:' + name + ':' + KIND_VERSIONS[name];
}

export interface Ls2CallParams {
  [key: string]: unknown;
}

export type Ls2Caller = (uri: string, params: Ls2CallParams) => Promise<{ returnValue?: boolean; [key: string]: unknown }>;

export interface Db8ClientOptions {
  call: Ls2Caller;
  appId?: string;
}

/** Détail lisible d'une réponse en échec : ` : erreurCode erreurTexte`, jamais de contenu sensible. */
function detailErreur(reply: Record<string, unknown>): string {
  const code = reply.errorCode !== undefined ? String(reply.errorCode) : '';
  const texte = reply.errorText !== undefined ? String(reply.errorText) : '';
  const interne = (reply.error || {}) as { errorCode?: unknown; errorText?: unknown };
  const codeInterne = interne.errorCode !== undefined ? String(interne.errorCode) : '';
  const texteInterne = interne.errorText !== undefined ? String(interne.errorText) : '';
  const morceaux = [
    [code, texte].filter((valeur) => valeur !== '').join(' '),
    [codeInterne, texteInterne].filter((valeur) => valeur !== '').join(' ')
  ].filter((valeur) => valeur !== '');
  return morceaux.length > 0 ? ' : ' + morceaux.join(' / ') : '';
}

export interface RapportMigrationDb8 {
  /** Nombre d'enregistrements repris des kinds v1. */
  migres: number;
  /** Paires `kind v2 <- kind v1` reprises. */
  kinds: string[];
  /** Kinds laissés de côté (cible déjà remplie, kind hérité absent ou illisible). */
  ignores: number;
}

export interface SondageDb8 {
  ok: boolean;
  etape: string;
  message?: string;
  kinds: Array<{kind: string; indexe: boolean; champs: string[]}>;
}

export class Db8Client {
  private readonly call: Ls2Caller;
  /** Cache des kinds créés pendant l'exécution : évite un `putKind` à chaque écriture. */
  private readonly knownKinds: Record<string, boolean> = {};

  constructor(options: Db8ClientOptions) {
    this.call = options.call;
    void options.appId;
  }

  async put(name: KindName, objects: Array<Record<string, unknown>>): Promise<string[]> {
    if (objects.length === 0) return [];
    await this.ensureKind(name);
    const reply = await this.call('luna://' + DB_SERVICE + '/put', {
      objects: objects.map((object) => Object.assign({ _kind: kindOf(name) }, object)),
      // `private: true` est une politique de suppression/désinstallation, pas un chiffrement (§8.1)
      private: true
    });
    if (reply.returnValue === false) {
      throw new AppError('internal/unexpected', 'ecriture DB8 refusee');
    }
    const results = reply.results as Array<{ id?: string }> | undefined;
    return (results || []).map((result) => result.id || '');
  }

  async find<T extends Record<string, unknown>>(
    name: KindName,
    where: Record<string, unknown>,
    options: { limit?: number; incDel?: boolean } = {}
  ): Promise<T[]> {
    const interdits = champsNonIndexes(name, where);
    if (interdits.length > 0) {
      // Erreur de programmation, pas de données : DB8 n'indexe pas ce champ, la requête ne peut pas
      // répondre. La refuser ici évite le pire des cas — un résultat vide crédible (D-40).
      throw new AppError(
        'internal/unexpected',
        'requete DB8 non indexee sur ' + interdits.join(', ') + ' (kind ' + name + ') — declarer un index dans KIND_INDEXES'
      );
    }
    await this.ensureKind(name);
    const query: Record<string, unknown> = { where: Object.assign({ _kind: kindOf(name) }, where) };
    if (options.limit !== undefined) query.limit = options.limit;
    const reply = await this.call('luna://' + DB_SERVICE + '/find', { query, incDel: options.incDel === true });
    if (reply.returnValue !== true) {
      // Un échec de base ne doit jamais devenir « aucune ligne » : c'est ainsi qu'un index manquant
      // s'est transformé en « clé maître absente » (D-40).
      throw new AppError('internal/unexpected', 'lecture DB8 refusee' + detailErreur(reply));
    }
    return ((reply.results || []) as T[]).slice();
  }

  /** Supprime des enregistrements par identifiant (`del` accepte `ids` dans l'API DB8). */
  async del(name: KindName, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const reply = await this.call('luna://' + DB_SERVICE + '/del', {
      ids: ids,
      purge: true
    });
    if (reply.returnValue === false) {
      throw new AppError('internal/unexpected', 'suppression DB8 refusee');
    }
    return (reply.count as number) || ids.length;
  }

  /** Supprime **tous** les enregistrements d'un kind (utilisé par la suppression de profil). */
  async delKind(name: KindName): Promise<number> {
    const reply = await this.call('luna://' + DB_SERVICE + '/del', {
      query: { where: { _kind: kindOf(name) } },
      purge: true
    });
    if (reply.returnValue === false) {
      throw new AppError('internal/unexpected', 'suppression DB8 refusee');
    }
    return (reply.count as number) || 0;
  }

  /** Met à jour un enregistrement existant (par `_id`), sans créer de doublon. */
  async merge(name: KindName, objects: Array<Record<string, unknown>>): Promise<number> {
    if (objects.length === 0) return 0;
    await this.ensureKind(name);
    const reply = await this.call('luna://' + DB_SERVICE + '/merge', {
      objects: objects.map((object) => Object.assign({ _kind: kindOf(name) }, object))
    });
    if (reply.returnValue === false) {
      throw new AppError('internal/unexpected', 'fusion DB8 refusee');
    }
    return (reply.count as number) || objects.length;
  }

  /**
   * **Migration des kinds v1 vers v2.** Les kinds v1 ont été enregistrés sans index : plus aucune
   * requête indexée ne peut les lire (c'est la cause du défaut D-40). Les données, elles, sont
   * intactes — y compris la **clé maître** avec laquelle l'index chiffré a été écrit. Les reprendre
   * évite un réimport complet du portail.
   *
   * Principe : la cible ne doit pas déjà contenir de lignes (jamais de mélange de deux générations),
   * la lecture du kind hérité se fait **sans contrainte de champ** (`_kind` seul, aucune propriété à
   * indexer), et chaque échec est simplement ignoré — le réimport reste la solution de repli.
   */
  async migrateLegacyKinds(): Promise<RapportMigrationDb8> {
    const rapport: RapportMigrationDb8 = { migres: 0, kinds: [], ignores: 0 };
    for (const name of Object.keys(KIND_VERSIONS) as KindName[]) {
      if (name === 'probes') continue;
      if (KIND_VERSIONS[name] <= 1) continue;
      const legacyId = APP_ID + ':db:' + name + ':1';
      await this.ensureKind(name);
      const cibles = await this.find<Record<string, unknown>>(name, {});
      if (cibles.length > 0) {
        rapport.ignores += 1;
        continue;
      }
      let lignes: Array<Record<string, unknown>> = [];
      try {
        const reply = await this.call('luna://' + DB_SERVICE + '/find', { query: { where: { _kind: legacyId } } });
        if (reply.returnValue !== true) {
          rapport.ignores += 1;
          continue;
        }
        lignes = ((reply.results || []) as Array<Record<string, unknown>>).slice();
      } catch (_erreur) {
        rapport.ignores += 1;
        continue;
      }
      if (lignes.length === 0) {
        rapport.ignores += 1;
        continue;
      }
      const copies = lignes.map((ligne) => {
        const copie: Record<string, unknown> = {};
        Object.keys(ligne).forEach((cle) => {
          if (cle !== '_id' && cle !== '_kind') copie[cle] = ligne[cle];
        });
        return copie;
      });
      await this.put(name, copies);
      rapport.migres += copies.length;
      rapport.kinds.push(kindOf(name) + ' <- ' + legacyId);
    }
    return rapport;
  }

  /**
   * **Sonde DB8** : enregistre les kinds, écrit un témoin, le relit **par son index**, puis le
   * supprime. C'est la seule vérification qui distingue « DB8 répond » de « DB8 répond *ce qui est
   * demandé* » ; sans elle, un kind enregistré sans index et une base vide se ressemblent (D-40).
   * Aucune donnée d'utilisateur n'est touchée : le kind `probes` ne sert qu'ici.
   */
  async sonde(): Promise<SondageDb8> {
    const kinds: SondageDb8['kinds'] = [];
    for (const name of Object.keys(KIND_VERSIONS) as KindName[]) {
      try {
        await this.ensureKind(name);
        kinds.push({
          kind: kindOf(name),
          indexe: KIND_INDEXES[name].length > 0,
          champs: KIND_INDEXES[name].map((index) => index.props.join('+'))
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        kinds.push({ kind: kindOf(name), indexe: false, champs: [] });
        return { ok: false, etape: 'putKind ' + name, message: message, kinds: kinds };
      }
    }
    const temoin = 'sonde-' + Date.now().toString(36);
    try {
      const ids = await this.put('probes', [{ cle: temoin, at: Date.now() }]);
      const relus = await this.find<Record<string, unknown>>('probes', { cle: temoin }, { limit: 1 });
      await this.del('probes', ids.filter((id) => id !== ''));
      if (relus.length !== 1) {
        return {
          ok: false,
          etape: 'find probes',
          message: 'temoin ecrit mais non relu par son index (' + relus.length + ' ligne(s))',
          kinds: kinds
        };
      }
      return { ok: true, etape: 'ecriture puis relecture indexee', kinds: kinds };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, etape: 'ecriture/relecture du temoin', message: message, kinds: kinds };
    }
  }

  private async ensureKind(name: KindName): Promise<void> {
    const kind = kindOf(name);
    if (this.knownKinds[kind]) return;
    const reply = await this.call('luna://' + DB_SERVICE + '/putKind', {
      id: kind,
      owner: APP_ID,
      private: true,
      // DB8 : « All queries must be on indexed fields » — sans ces index, aucune requête ne répond.
      indexes: KIND_INDEXES[name].map((index) => ({
        name: index.name,
        props: index.props.map((prop) => ({name: prop}))
      }))
    });
    if (reply.returnValue !== true) {
      const detail = detailErreur(reply);
      // Un `putKind` sur un kind déjà existant n'est pas une erreur : on ne bloque pas l'usage. Le
      // texte est examiné en plus du code : le code est numérique (« 61115 »), il ne dit rien.
      if (detail.toLowerCase().indexOf('exist') === -1) {
        throw new AppError('internal/unexpected', 'creation du kind DB8 refusee' + detail);
      }
    }
    this.knownKinds[kind] = true;
  }
}

/**
 * Faux bus en mémoire reproduisant la sémantique DB8 utilisée ici : `putKind`, `put`, `find`
 * (correspondance exacte, `_id` inclus), `del`, `merge`. Il sert aux tests et au simulateur : le
 * service ne doit pas dépendre d'un appareil pour être vérifiable.
 */
export class FakeDb8Bus {
  private readonly stores: Record<string, Array<Record<string, unknown>>> = {};
  /** Kinds enregistres et leurs index : c'est ce qui decide quelles requetes sont valides. */
  readonly kinds: Record<string, string[]> = {};
  private counter = 0;

  /** Propriétés interrogeables d'un kind enregistré : `_id`, `_kind` et ses index. */
  private champs(kind: string): string[] {
    return ['_id', '_kind'].concat(this.kinds[kind] || []);
  }

  readonly call: Ls2Caller = async (uri: string, params: Ls2CallParams) => {
    const action = uri.replace('luna://' + DB_SERVICE + '/', '');
    switch (action) {
      case 'putKind': {
        // DB8 refuse un `putKind` sur un kind existant : on reproduit le refus, sinon un kind
        // enregistre sans index (schema v1) passerait pour un kind conforme (D-40).
        const id = String(params.id || '');
        if (this.kinds[id]) {
          return { returnValue: false, errorCode: 61115, errorText: "db: kind already exists: '" + id + "'" };
        }
        const indexes = (params.indexes || []) as Array<{ props?: Array<{ name?: string }> }>;
        this.kinds[id] = indexes.reduce<string[]>((champs, index) => {
          (index.props || []).forEach((prop) => {
            if (prop && prop.name) champs.push(String(prop.name));
          });
          return champs;
        }, []);
        return { returnValue: true, kind: id, indexes: indexes.length };
      }
      case 'put': {
        const objects = (params.objects || []) as Array<Record<string, unknown>>;
        const kindInconnu = objects.map((o) => String(o._kind)).find((kind) => !this.kinds[kind]);
        if (kindInconnu) {
          return { returnValue: false, errorCode: -3970, errorText: 'db: kind not registered' };
        }
        const results: Array<{ id: string }> = [];
        objects.forEach((object) => {
          const kind = String(object._kind);
          const list = this.stores[kind] || (this.stores[kind] = []);
          const id = (object._id as string) || 'id-' + ++this.counter;
          const index = list.findIndex((existing) => existing._id === id);
          const record = Object.assign({}, object, { _id: id });
          if (index === -1) list.push(record);
          else list[index] = record;
          results.push({ id });
        });
        return { returnValue: true, results };
      }
      case 'merge': {
        const objects = (params.objects || []) as Array<Record<string, unknown>>;
        objects.forEach((object) => {
          const kind = String(object._kind);
          const list = this.stores[kind] || (this.stores[kind] = []);
          const id = object._id as string;
          const index = list.findIndex((existing) => existing._id === id);
          if (index === -1) list.push(Object.assign({}, object));
          else list[index] = Object.assign({}, list[index], object);
        });
        return { returnValue: true, count: objects.length };
      }
      case 'find': {
        const query = (params.query || {}) as { where?: Record<string, unknown>; limit?: number };
        const where = query.where || {};
        const kind = String(where._kind);
        if (!this.kinds[kind]) {
          return { returnValue: false, errorCode: -3970, errorText: 'db: kind not registered' };
        }
        const permis = this.champs(kind);
        const interdits = Object.keys(where).filter((champ) => permis.indexOf(champ) === -1);
        if (interdits.length > 0) {
          return {
            returnValue: false,
            errorCode: -3965,
            errorText: 'db: no index for query (' + interdits.join(', ') + ')'
          };
        }
        const list = (this.stores[kind] || []).filter((record) => matches(record, where));
        const limited = query.limit === undefined ? list : list.slice(0, query.limit);
        return { returnValue: true, results: limited.map((record) => Object.assign({}, record)) };
      }
      case 'del': {
        const ids = (params.ids || []) as string[];
        if (ids.length > 0) {
          let removed = 0;
          Object.keys(this.stores).forEach((kind) => {
            const list = this.stores[kind];
            const kept = list.filter((record) => ids.indexOf(String(record._id)) === -1);
            removed += list.length - kept.length;
            this.stores[kind] = kept;
          });
          return { returnValue: true, count: removed };
        }
        const query = (params.query || {}) as { where?: Record<string, unknown> };
        const where = query.where || {};
        const kind = String(where._kind);
        const list = this.stores[kind] || [];
        const kept = list.filter((record) => !matches(record, where));
        this.stores[kind] = kept;
        return { returnValue: true, count: list.length - kept.length };
      }
      default:
        return { returnValue: false, error: { errorCode: 'unknown-action' } };
    }
  };

  /** Contenu brut, pour les assertions de test (jamais exposé par le service). */
  dump(): Record<string, Array<Record<string, unknown>>> {
    return this.stores;
  }
}

function matches(record: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.keys(where).every((key) => {
    const expected = where[key];
    const actual = record[key];
    if (Array.isArray(expected)) {
      return Array.isArray(actual) ? expected.every((value) => actual.indexOf(value) !== -1) : false;
    }
    return actual === expected;
  });
}
