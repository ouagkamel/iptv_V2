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

/** Kinds versionnés : le numéro change si le schéma change (migration explicite, jamais silencieuse). */
export const KIND_VERSIONS = {
  profiles: 1,
  preferences: 1,
  favorites: 1,
  playbacks: 1,
  epgMappings: 1,
  importJobs: 1,
  masterKeys: 1,
  consents: 1
} as const;

export type KindName = keyof typeof KIND_VERSIONS;

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
    await this.ensureKind(name);
    const query: Record<string, unknown> = { where: Object.assign({ _kind: kindOf(name) }, where) };
    if (options.limit !== undefined) query.limit = options.limit;
    const reply = await this.call('luna://' + DB_SERVICE + '/find', { query, incDel: options.incDel === true });
    if (reply.returnValue === false) {
      throw new AppError('internal/unexpected', 'lecture DB8 refusee');
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

  private async ensureKind(name: KindName): Promise<void> {
    const kind = kindOf(name);
    if (this.knownKinds[kind]) return;
    const reply = await this.call('luna://' + DB_SERVICE + '/putKind', {
      id: kind,
      owner: APP_ID,
      private: true
    });
    // Un `putKind` sur un kind déjà existant n'est pas une erreur : on ne bloque pas l'usage.
    if (reply.returnValue === false) {
      const errorCode = String((reply.error as { errorCode?: string } | undefined)?.errorCode || '');
      if (errorCode.indexOf('exists') === -1 && errorCode !== '') {
        throw new AppError('internal/unexpected', 'creation du kind DB8 refusee');
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
  private counter = 0;

  readonly call: Ls2Caller = async (uri: string, params: Ls2CallParams) => {
    const action = uri.replace('luna://' + DB_SERVICE + '/', '');
    switch (action) {
      case 'putKind':
        return { returnValue: true };
      case 'put': {
        const objects = (params.objects || []) as Array<Record<string, unknown>>;
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
