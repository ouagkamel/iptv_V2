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

/**
 * Noms possibles du service de base DB8, **dans l'ordre d'essai**.
 *
 * LG documente la base des televiseurs sous `luna://com.palm.db` (reference « Database » et exemples
 * officiels, simulateur compris) ; les images webOS OSE exposent le meme service sous
 * `com.webos.service.db`. Un nom qui n'existe pas sur la plateforme fait repondre au bus
 * « Service does not exist » (-1) : ce n'est **pas** une base absente, c'est un nom a essayer
 * autrement. Le client essaie ces noms au premier appel et retient celui qui repond (D-42).
 */
export const DB_SERVICES: string[] = ['com.palm.db', 'com.webos.service.db'];
export const DB_SERVICE = DB_SERVICES[0];

/** Nom du service JS (le meme que `SERVICE_NAME` de `ls2/service.ts`, verifie par les tests). */
export const SERVICE_NAME_DB8 = APP_ID + '.service';

/**
 * Valeurs possibles du parametre `owner` d'un kind, **dans l'ordre d'essai**.
 *
 * DB8 n'accorde `putKind` qu'au proprietaire du kind — ou a un administrateur :
 * `MojDbKind::hasOwnerPermission` rend vrai pour `req.admin() || req.domain() == m_owner`, et
 * `configure()` refuse (`-3963 db: permission denied`) tout autre appelant, y compris pour une
 * **creation**. L'appelant, ici, est le **service** : sur un appareil ou le domaine du service est
 * son nom (`…service`), declarer l'ID de l'application comme proprietaire est donc refuse (D-43).
 * On essaie l'ID de l'application (le domaine des applications, et ce que la purge des kinds
 * `private` attend a la desinstallation) puis le nom du service ; le premier accepte est retenu.
 */
export const OWNERS_DB8: string[] = [APP_ID, SERVICE_NAME_DB8];

/** Vrai si l'echec dit que le **service** n'existe pas (nom a reessayer), et non la base. */
export function serviceIntrouvable(erreur: unknown): boolean {
  return /service\s+does\s+not\s+exist|no\s+such\s+service/i.test(texteDe(erreur));
}

/**
 * Vrai si le refus vient du **moteur de permissions de DB8** : `-3963 db: permission denied`. Dans ce
 * cas precis, `owner` ne correspond pas au domaine de l'appelant : un autre proprietaire peut etre
 * accepte (D-43). Ne jamais confondre avec « Service does not exist » (D-42) ni avec un refus de bus.
 */
export function permissionRefusee(message: string): boolean {
  return /permission\s+denied|-3963/.test(message);
}

/**
 * Vrai si un refus de `putKind` vient bien d'un kind **deja enregistre** (mise a jour refusee par
 * certaines versions) — et non d'un service absent. La nuance vaut son prix : « Service does not
 * exist » contient « exist » ; l'avaler ferait passer une base injoignable pour une base prete (D-42).
 */
export function kindDejaEnregistre(message: string): boolean {
  const texte = message.toLowerCase();
  return /already\s+exists/.test(texte) || /kind[^.]{0,40}exist/.test(texte);
}

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

/**
 * Clause `where` de DB8. La forme documentée est un **tableau** d'objets `{prop, op, val}`
 * (`MojDbQuery::addClauses` lit `prop`, `op`, `val`) — et non une correspondance `{champ: valeur}`,
 * qui n'ajoute tout simplement aucune clause.
 */
export interface ClauseDb8 {
  prop: string;
  op: string;
  val: unknown;
}

/** Traduit le `where` des dépôts en clauses DB8 ; nos dépôts n'utilisent que l'égalité. */
export function clausesDe(where: Record<string, unknown>): ClauseDb8[] {
  return Object.keys(where).map((prop) => ({ prop: prop, op: '=', val: where[prop] }));
}

/** Limite haute imposée par le schéma du service (`limit` : 0 à 500). */
export const LIMITE_MAX_DB8 = 500;

export interface Ls2CallParams {
  [key: string]: unknown;
}

export type Ls2Caller = (uri: string, params: Ls2CallParams) => Promise<{ returnValue?: boolean; [key: string]: unknown }>;

export interface Db8ClientOptions {
  call: Ls2Caller;
  appId?: string;
}

/** Détail lisible d'une réponse en échec : ` : erreurCode erreurTexte`, jamais de contenu sensible. */
function detailErreur(reponse: Record<string, unknown>): string {
  // Tolérance d'enveloppe : si un appelant remet l'objet `Message` de `webos-service` au lieu de sa
  // charge utile, l'erreur est cherchée dans `payload` — un refus DB8 ne doit jamais être muet.
  const reply =
    reponse.errorCode === undefined &&
    reponse.errorText === undefined &&
    reponse.payload &&
    typeof reponse.payload === 'object'
      ? (reponse.payload as Record<string, unknown>)
      : reponse;
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

/** Message d'une erreur quelconque, sans jamais supposer qu'elle en est une. */
function texteDe(erreur: unknown): string {
  return erreur instanceof Error ? erreur.message : String(erreur);
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
  /** Nom du service DB8 effectivement retenu (`com.palm.db` sur televiseur). */
  service: string;
  /** Proprietaire de kind accepte par la plateforme (`req.domain() == owner`, D-43). */
  owner: string;
  kinds: Array<{kind: string; indexe: boolean; champs: string[]}>;
}

export class Db8Client {
  private readonly call: Ls2Caller;
  /** Cache des kinds créés pendant l'exécution : évite un `putKind` à chaque écriture. */
  private readonly knownKinds: Record<string, boolean> = {};
  /** Service DB8 retenu apres le premier appel reussi (`null` tant qu'aucun n'a abouti). */
  private service: string | null = null;
  /** Dernier nom de service essaye : sert au diagnostic quand **aucun** nom ne repond. */
  private dernierNom: string | null = null;
  /** Proprietaire de kind accepte par la plateforme (`null` tant qu'aucun n'a abouti). */
  private owner: string | null = null;

  constructor(options: Db8ClientOptions) {
    this.call = options.call;
    void options.appId;
  }

  /** Nom du service DB8 retenu (`null` tant qu'aucun appel n'a abouti). */
  serviceDb(): string | null {
    return this.service;
  }

  /** Nom de service a afficher au diagnostic : le nom retenu, sinon le dernier essaye. */
  serviceDbPourDiagnostic(): string {
    return this.service || this.dernierNom || '';
  }

  /** Proprietaire de kind retenu (`owner` exige par DB8), pour le diagnostic. */
  ownerDbPourDiagnostic(): string {
    return this.owner || '';
  }

  /**
   * Un appel a DB8, nom de service compris. Au premier appel — ou apres un `Service does not exist`
   * — les noms de `DB_SERVICES` sont essayes dans l'ordre ; le premier qui repond est retenu pour la
   * suite de la session. Toute autre erreur remonte telle quelle : un nom de service ne se devine pas
   * au-dela de cette liste, et une erreur de base ne doit pas etre masquee par un second essai.
   */
  private async appel(action: string, params: Ls2CallParams): Promise<Record<string, unknown>> {
    // Une fois un nom retenu, il n'est plus remis en cause : c'est celui de cette plateforme.
    const candidats = this.service ? [this.service] : DB_SERVICES.slice();
    return this.appelSur(candidats, action, params);
  }

  /** Essais successifs sur une liste de noms de service : le premier qui repond est retenu. */
  private async appelSur(candidats: string[], action: string, params: Ls2CallParams): Promise<Record<string, unknown>> {
    let derniere: unknown = null;
    for (let i = 0; i < candidats.length; i += 1) {
      try {
        this.dernierNom = candidats[i];
        const reply = await this.call('luna://' + candidats[i] + '/' + action, params);
        this.service = candidats[i];
        return reply;
      } catch (erreur) {
        derniere = erreur;
        if (i + 1 < candidats.length && serviceIntrouvable(erreur)) continue;
        throw erreur;
      }
    }
    throw derniere instanceof Error ? derniere : new Error(String(derniere));
  }

  async put(name: KindName, objects: Array<Record<string, unknown>>): Promise<string[]> {
    if (objects.length === 0) return [];
    await this.ensureKind(name);
    // Le schéma du service (`put`) n'accepte que `objects` (et `shardId`) : toute autre clé est
    // refusée (`additionalProperties: false`). `private` appartient à `putKind`, pas à `put`.
    const reply = await this.appel('put', {
      objects: objects.map((object) => Object.assign({ _kind: kindOf(name) }, object))
    });
    if (reply.returnValue !== true) {
      throw new AppError('internal/unexpected', 'ecriture DB8 refusee' + detailErreur(reply));
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
    // Requête au format DB8 : `from` est **obligatoire** (`MojDbQuery::fromObject` le lit comme un
    // champ requis), les clauses forment un tableau, et `incDel`/`limit` vivent **dans** la requête.
    // Le schéma du service n'accepte rien d'autre au premier niveau (D-41).
    const query: Record<string, unknown> = { from: kindOf(name) };
    const clauses = clausesDe(where);
    if (clauses.length > 0) query.where = clauses;
    if (options.incDel === true) query.incDel = true;
    if (options.limit !== undefined) query.limit = Math.max(0, Math.min(LIMITE_MAX_DB8, options.limit));
    const reply = await this.appel('find', { query: query });
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
    const reply = await this.appel('del', {
      ids: ids,
      purge: true
    });
    if (reply.returnValue !== true) {
      throw new AppError('internal/unexpected', 'suppression DB8 refusee' + detailErreur(reply));
    }
    return (reply.count as number) || ids.length;
  }

  /** Supprime **tous** les enregistrements d'un kind (utilisé par la suppression de profil). */
  async delKind(name: KindName): Promise<number> {
    await this.ensureKind(name);
    // `del` accepte `query.ids` ou `query.query` : ici une requête sans clause — c'est le kind
    // entier qui part (`from` reste obligatoire).
    const reply = await this.appel('del', {
      query: { from: kindOf(name) },
      purge: true
    });
    if (reply.returnValue !== true) {
      throw new AppError('internal/unexpected', 'suppression DB8 refusee' + detailErreur(reply));
    }
    return (reply.count as number) || 0;
  }

  /** Met à jour un enregistrement existant (par `_id`), sans créer de doublon. */
  async merge(name: KindName, objects: Array<Record<string, unknown>>): Promise<number> {
    if (objects.length === 0) return 0;
    await this.ensureKind(name);
    const reply = await this.appel('merge', {
      objects: objects.map((object) => Object.assign({ _kind: kindOf(name) }, object))
    });
    if (reply.returnValue !== true) {
      throw new AppError('internal/unexpected', 'fusion DB8 refusee' + detailErreur(reply));
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
        // Lecture du kind hérité **sans clause** : `from` suffit, et la requête est servie par
        // l'index implicite `_id` que DB8 enregistre pour tout kind (`configureIndexes`).
        const reply = await this.appel('find', { query: { from: legacyId } });
        if (reply.returnValue !== true) {
          rapport.ignores += 1;
          continue;
        }
        lignes = ((reply.results || []) as Array<Record<string, unknown>>).filter(
          (ligne) => String(ligne._kind) === legacyId
        );
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
        return { ok: false, etape: 'putKind ' + name, message: message, kinds: kinds, service: this.serviceDbPourDiagnostic(),
        owner: this.ownerDbPourDiagnostic() };
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
          kinds: kinds,
          service: this.serviceDbPourDiagnostic(),
        owner: this.ownerDbPourDiagnostic()
        };
      }
      return { ok: true, etape: 'ecriture puis relecture indexee', kinds: kinds, service: this.serviceDbPourDiagnostic(),
        owner: this.ownerDbPourDiagnostic() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, etape: 'ecriture/relecture du temoin', message: message, kinds: kinds, service: this.serviceDbPourDiagnostic(),
        owner: this.ownerDbPourDiagnostic() };
    }
  }

  private async ensureKind(name: KindName): Promise<void> {
    const kind = kindOf(name);
    if (this.knownKinds[kind]) return;
    // Charge utile : le schéma du service (`putKind`) n'accepte que `id`, `owner`, `private`,
    // `indexes`, `revSets`… et rien d'autre (`additionalProperties: false`).
    //
    // `owner` : DB8 n'accepte que le propriétaire du kind (`req.domain() == owner`, ou admin). Le
    // domaine de l'appelant — le service — n'est pas celui de l'application sur tous les appareils :
    // les deux valeurs plausibles sont essayées, la première acceptée est retenue (D-43).
    const proprietaires = this.owner ? [this.owner] : OWNERS_DB8.slice();
    const essayes: string[] = [];
    let dernierDetail = '';
    for (let i = 0; i < proprietaires.length; i += 1) {
      const proprietaire = proprietaires[i];
      essayes.push(proprietaire);
      let reply: Record<string, unknown>;
      try {
        reply = await this.appel('putKind', {
          id: kind,
          owner: proprietaire,
          private: true,
          indexes: KIND_INDEXES[name].map((index) => ({
            name: index.name,
            props: index.props.map((prop) => ({ name: prop }))
          }))
        });
      } catch (erreur) {
        const texte = texteDe(erreur);
        // Kind déjà enregistré (mise à jour refusée par certaines versions) : ce n'est pas un échec.
        if (kindDejaEnregistre(texte)) {
          this.owner = proprietaire;
          this.knownKinds[kind] = true;
          return;
        }
        // Propriétaire refusé : essayer la valeur suivante s'il en reste une.
        if (permissionRefusee(texte) && i + 1 < proprietaires.length) {
          dernierDetail = texte;
          continue;
        }
        if (permissionRefusee(texte) && essayes.length > 1) {
          throw new AppError(
            'internal/unexpected',
            'creation du kind DB8 refusee : permission refusee pour les proprietaires essayes (' +
              essayes.join(', ') + ') : ' + texte
          );
        }
        throw erreur;
      }
      if (reply.returnValue !== true) {
        const detail = detailErreur(reply);
        // Même tolérance quand le refus arrive en réponse (charge utile validée, `returnValue: false`).
        if (kindDejaEnregistre(detail)) {
          this.owner = proprietaire;
          this.knownKinds[kind] = true;
          return;
        }
        if (permissionRefusee(detail) && i + 1 < proprietaires.length) {
          dernierDetail = detail;
          continue;
        }
        throw new AppError('internal/unexpected', 'creation du kind DB8 refusee' + detail);
      }
      this.owner = proprietaire;
      this.knownKinds[kind] = true;
      return;
    }
    throw new AppError(
      'internal/unexpected',
      'creation du kind DB8 refusee : permission refusee pour les proprietaires essayes (' +
        essayes.join(', ') + ')' + (dernierDetail ? ' : ' + dernierDetail : '')
    );
  }
}

/**
 * Faux bus en mémoire reproduisant la sémantique DB8 **telle que le service l'expose** : schémas
 * stricts de chaque méthode (`additionalProperties: false`), `putKind` refusé sur un kind existant,
 * requête indexée obligatoire (`-3965`), kind non enregistré refusé à l'écriture (`-3970`). Il sert
 * aux tests et au simulateur : un client qui parle un dialecte à lui doit échouer **ici**, pas sur
 * la TV.
 *
 * Références des schémas : `src/db/MojDbServiceSchemas.cpp` du dépôt `webosose/db8` (putKind, put,
 * find, del, merge). Codes : `-3965` no index for query, `-3970` kind not registered, `-4029`
 * schema validation.
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

  private inconnues(params: Record<string, unknown>, autorisees: string[]): string | null {
    const cles = Object.keys(params || {});
    for (let i = 0; i < cles.length; i += 1) {
      if (autorisees.indexOf(cles[i]) === -1) return cles[i];
    }
    return null;
  }

  private schema(reason: string): Record<string, unknown> {
    return { returnValue: false, errorCode: -4029, errorText: 'schema validation failed: ' + reason };
  }

  readonly call: Ls2Caller = async (uri: string, params: Ls2CallParams) => {
    // Le faux bus repond quel que soit le nom de service : c'est au client de choisir le bon
    // (`com.palm.db` sur televiseur, `com.webos.service.db` sur webOS OSE) — teste separement.
    const action = uri.replace(/^luna:\/\/[^/]+\//, '');
    switch (action) {
      case 'putKind': {
        // DB8 refuse un `putKind` sur un kind existant : on reproduit le refus, sinon un kind
        // enregistre sans index (schema v1) passerait pour un kind conforme (D-40).
        const inconnu = this.inconnues(params, [
          'id',
          'owner',
          'private',
          'assignId',
          'sync',
          'extends',
          'schema',
          'indexes',
          'revSets'
        ]);
        if (inconnu) return this.schema('putKind: cle inattendue ' + inconnu);
        const id = String(params.id || '');
        const owner = String(params.owner || '');
        if (id.length < 3 || owner.length < 1) return this.schema('putKind: id/owner requis');
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
        // `putKind` accepte `private` ; `put` non (schema : `objects` et `shardId` seulement).
        const inconnu = this.inconnues(params, ['objects', 'shardId']);
        if (inconnu) return this.schema('put: cle inattendue ' + inconnu);
        const objects = (params.objects || []) as Array<Record<string, unknown>>;
        if (!Array.isArray(params.objects)) return this.schema('put: objects requis');
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
        const inconnu = this.inconnues(params, ['query', 'objects', 'ignoreMissing', 'props']);
        if (inconnu) return this.schema('merge: cle inattendue ' + inconnu);
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
        const inconnu = this.inconnues(params, ['query', 'count', 'watch', 'subscribe']);
        if (inconnu) return this.schema('find: cle inattendue ' + inconnu);
        const requete = this.requete(params.query);
        if (typeof requete === 'string') return this.schema(requete);
        const query = requete as { from: string; where?: Array<{ prop: string; op: string; val: unknown }>; limit?: number };
        if (!this.kinds[query.from]) {
          return { returnValue: false, errorCode: -3970, errorText: 'db: kind not registered' };
        }
        const clauses = query.where || [];
        const permis = this.champs(query.from);
        const interdits = clauses.map((clause) => clause.prop).filter((champ) => permis.indexOf(champ) === -1);
        if (interdits.length > 0) {
          return {
            returnValue: false,
            errorCode: -3965,
            errorText: 'db: no index for query (' + interdits.join(', ') + ')'
          };
        }
        const list = (this.stores[query.from] || []).filter((record) => matches(record, clauses));
        const limited = query.limit === undefined ? list : list.slice(0, query.limit);
        return { returnValue: true, results: limited.map((record) => Object.assign({}, record)) };
      }
      case 'del': {
        const inconnu = this.inconnues(params, ['query', 'ids', 'purge']);
        if (inconnu) return this.schema('del: cle inattendue ' + inconnu);
        const ids = params.ids as string[] | undefined;
        if (Array.isArray(ids) && ids.length > 0) {
          let removed = 0;
          Object.keys(this.stores).forEach((kind) => {
            const list = this.stores[kind];
            const kept = list.filter((record) => ids.indexOf(String(record._id)) === -1);
            removed += list.length - kept.length;
            this.stores[kind] = kept;
          });
          return { returnValue: true, count: removed };
        }
        const requete = this.requete(params.query);
        if (typeof requete === 'string') return this.schema(requete);
        const query = requete as { from: string; where?: Array<{ prop: string; op: string; val: unknown }> };
        const list = this.stores[query.from] || [];
        const kept = list.filter((record) => !matches(record, query.where || []));
        this.stores[query.from] = kept;
        return { returnValue: true, count: list.length - kept.length };
      }
      default:
        return { returnValue: false, error: { errorCode: 'unknown-action' } };
    }
  };

  /**
   * Valide une `query` selon le schéma du service (`from` obligatoire, `where` en **tableau** de
   * `{prop, op, val}`). Rend la requête, ou le motif d'échec.
   */
  private requete(brute: unknown): { from: string; where?: Array<{ prop: string; op: string; val: unknown }>; limit?: number } | string {
    if (!brute || typeof brute !== 'object') return 'query requise';
    const query = brute as Record<string, unknown>;
    const inconnu = this.inconnues(query, [
      'select',
      'from',
      'where',
      'filter',
      'aggregate',
      'orderBy',
      'distinct',
      'desc',
      'incDel',
      'limit',
      'immediateReturn',
      'page'
    ]);
    if (inconnu) return 'query: cle inattendue ' + inconnu;
    if (typeof query.from !== 'string' || query.from.length === 0) return 'query.from requis';
    let clauses: Array<{ prop: string; op: string; val: unknown }> = [];
    if (query.where !== undefined) {
      if (!Array.isArray(query.where)) return 'query.where doit etre un tableau';
      const invalide = query.where.find(
        (clause) =>
          !clause ||
          typeof clause !== 'object' ||
          typeof (clause as { prop?: unknown }).prop !== 'string' ||
          typeof (clause as { op?: unknown }).op !== 'string'
      );
      if (invalide) return 'clause where invalide (prop/op/val)';
      clauses = query.where as Array<{ prop: string; op: string; val: unknown }>;
      const operateur = clauses.find((clause) => clause.op !== '=');
      if (operateur) return 'operateur non gere par le faux bus : ' + operateur.op;
    }
    return { from: query.from, where: clauses, limit: query.limit as number | undefined };
  }

  /** Contenu brut, pour les assertions de test (jamais exposé par le service). */
  dump(): Record<string, Array<Record<string, unknown>>> {
    return this.stores;
  }
}

/** Correspondance d'un enregistrement avec les clauses `{prop, op: '=', val}` d'une requête DB8. */
function matches(record: Record<string, unknown>, clauses: Array<{ prop: string; op: string; val: unknown }>): boolean {
  return clauses.every((clause) => {
    const expected = clause.val;
    const actual = record[clause.prop];
    if (Array.isArray(expected)) {
      return Array.isArray(actual) ? expected.every((value) => actual.indexOf(value) !== -1) : false;
    }
    return actual === expected;
  });
}
