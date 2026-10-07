/**
 * Commandes LS2 du service (§15.4) — implémentation des onze commandes de `services.json`.
 *
 * Règles transverses appliquées ici :
 *  - **une seule opération lourde par profil à la fois** (`catalog/busy`) ;
 *  - toute réponse indique l'`indexVersion` utilisée ;
 *  - aucun appel LS2 ne transporte une URL de flux ou un secret vers l'interface, sauf
 *    `resolveStream` (donnée de session, §6.1) ;
 *  - identifiants reçus **en paramètre de session uniquement** dans `testProfile` ; jamais relus du
 *    disque à cette occasion ;
 *  - plafonds objets/octets vérifiés avant envoi, y compris `getDetails` (≤ 32 Kio).
 */

import * as crypto from 'crypto';
import { AppError, type ErrorCode } from '../../contracts/errors';
import type {
  CatalogDetailRecord,
  ContentType,
  Cursor,
  ImportJob,
  Profile,
  ProfileInput,
  StreamResolution,
  TestResult
} from '../../contracts/types';
import { deleteProfileFiles, pruneOrphans, readManifest } from '../store/manifest';
import { CatalogIndexReader } from '../store/reader';
import { Db8Client } from '../db8/client';
import {
  createConsentRepository,
  createFavoriteRepository,
  createImportJobRepository,
  createMasterKeyRepository,
  createPlaybackRepository,
  createProfileRepository,
  deleteProfileData,
  redactProfile,
  type ConsentRepository,
  type FavoriteRepository,
  type ImportJobRepository,
  type MasterKeyRepository,
  type PlaybackRepository,
  type ProfileRepository
} from '../db8/repositories';
import { HttpClient } from '../http/httpClient';
import { buildTlsReport, describeRuntime, probeTls, type TlsProbeResult } from '../http/tlsProbe';
import { rootsDiagnostics } from '../http/rootsBundle';
import { XtreamProvider, type XtreamSession } from '../providers/xtream';
import type { XtreamContentType } from '../providers/xtreamSchema';
import { runXtreamImport, createXtreamImportJob } from '../import/xtreamImport';
import { shouldOfferCleanup } from '../../core/machines';
import { hostOf } from '../../core/urltools';
import {
  MAX_DETAIL_BYTES,
  assertObjectCap,
  assertReplySafe,
  ls2Fail,
  ls2Ok,
  replyBytes,
  type ReplyLimits
} from './envelope';
import type { BusRespond, BusHandler, ServiceBus } from './bus';

export const SERVICE_NAME = 'com.ouagkamel.app.iptvplayer.service';
export const DEFAULT_STORAGE_ROOT = '/media/internal/com.ouagkamel.app.iptvplayer';

const CONTENT_TYPES: ContentType[] = ['live', 'vod', 'series', 'episode'];

export interface ServiceDependencies {
  db: Db8Client;
  http: HttpClient;
  /** répertoire privé du service : index chiffrés et fichiers temporaires (§2.6, §8.1) */
  storageRoot?: string;
  now?: () => number;
  onLog?: (line: string) => void;
  /** sonde TLS injectable (tests) */
  tlsProbe?: typeof probeTls;
}

interface SessionSecrets {
  username?: string;
  password?: string;
  acceptedHosts: string[];
}

interface RunningJob {
  jobId: string;
  profileId: string;
  cancel: () => void;
  /** version d'index de la clé : invalide les lecteurs en cache après bascule */
  indexVersion: number;
  contentType: XtreamContentType;
}

export interface Subscriber {
  profileId: string;
  respond: BusRespond;
  startedAt: number;
}

export class IptvService {
  private readonly db: Db8Client;
  private readonly http: HttpClient;
  private readonly storageRoot: string;
  private readonly now: () => number;
  private readonly onLog: (line: string) => void;
  private readonly tlsProbe: typeof probeTls;

  readonly profiles: ProfileRepository;
  readonly importJobs: ImportJobRepository;
  readonly masterKeys: MasterKeyRepository;
  readonly consents: ConsentRepository;
  readonly favorites: FavoriteRepository;
  readonly playbacks: PlaybackRepository;

  private readonly sessionSecrets: Record<string, SessionSecrets> = {};
  /**
   * Hôtes en HTTP clair acceptés pendant cette session de service (§8.2 : « avertissement à
   * confirmer une fois par profil et par hôte »). Vidé à la mort du service : le consentement
   * durable, lui, vit dans DB8.
   */
  private readonly sessionAcceptedHosts: string[] = [];
  private readonly runningJobs: Record<string, RunningJob> = {};
  private readonly subscribers: Record<string, Subscriber> = {};
  private readonly readers: Record<string, { reader: CatalogIndexReader; indexVersion: number }> = {};
  private readonly tlsObservations: TlsProbeResult[] = [];
  /** Une commande lourde à la fois par profil (§15.4) ; les lectures restent permises. */
  private readonly busyProfiles: Record<string, string> = {};
  /** Annulations demandées pendant un import : lues par `shouldAbort`, remises à zéro en fin d'import. */
  private readonly cancelFlags: Record<string, boolean> = {};

  constructor(deps: ServiceDependencies) {
    this.db = deps.db;
    this.http = deps.http;
    this.storageRoot = deps.storageRoot || DEFAULT_STORAGE_ROOT;
    this.now = deps.now || Date.now;
    this.onLog = deps.onLog || (() => undefined);
    this.tlsProbe = deps.tlsProbe || probeTls;
    this.profiles = createProfileRepository(deps.db);
    this.importJobs = createImportJobRepository(deps.db);
    this.masterKeys = createMasterKeyRepository(deps.db);
    this.consents = createConsentRepository(deps.db);
    this.favorites = createFavoriteRepository(deps.db);
    this.playbacks = createPlaybackRepository(deps.db);
  }

  /** Enregistre les onze commandes sur le bus (toutes non publiques, §2.6). */
  register(bus: ServiceBus): void {
    const commands = this.commands();
    Object.keys(commands).forEach((name) => {
      bus.register(name, commands[name]);
    });
  }

  /** Table des commandes, exposée pour les tests et pour un éventuel hôte alternatif. */
  commands(): Record<string, BusHandler> {
    return {
      testProfile: this.handle('testProfile'),
      importPlaylist: this.handle('importPlaylist'),
      getImportJob: this.handle('getImportJob'),
      cancelOperation: this.handle('cancelOperation'),
      getPage: this.handle('getPage'),
      search: this.handle('search'),
      getBuckets: this.handle('getBuckets'),
      getCategories: this.handle('getCategories'),
      getDetails: this.handle('getDetails'),
      resolveStream: this.handle('resolveStream'),
      deleteProfile: this.handle('deleteProfile'),
      diagnostics: this.handle('diagnostics')
    };
  }

  /** Enveloppe commune : aucune exception ne remonte au bus, aucune réponse ne part sans contrôle. */
  private handle(command: string): BusHandler {
    return (payload, respond, context) => {
      const limits = command === 'resolveStream' ? { allowStreamUrl: true, maxBytes: 8 * 1024 } : {};
      return Promise.resolve()
        .then(() => this.dispatch(command, payload, respond, context.subscribed))
        .then((reply) => {
          if (reply !== undefined) respond(this.safeReply(reply, limits, command));
        })
        .catch((error) => {
          respond(this.safeReply(ls2Fail(error), limits, command));
        });
    };
  }

  private safeReply(reply: unknown, limits: ReplyLimits, command: string): unknown {
    try {
      assertReplySafe(reply, limits);
      return reply;
    } catch (error) {
      this.onLog('reponse refusee par le controle de surete (' + command + ')');
      return ls2Fail(new AppError('internal/unexpected', 'reponse refusee par le controle de surete'));
    }
  }

  private async dispatch(
    command: string,
    payload: Record<string, unknown>,
    respond: BusRespond,
    subscribed: boolean
  ): Promise<unknown> {
    switch (command) {
      case 'testProfile':
        return this.testProfile(payload);
      case 'importPlaylist':
        return this.importPlaylist(payload, respond, subscribed);
      case 'getImportJob':
        return this.getImportJob(payload);
      case 'cancelOperation':
        return this.cancelOperation(payload);
      case 'getPage':
        return this.getPage(payload);
      case 'search':
        return this.search(payload);
      case 'getBuckets':
        return this.getBuckets(payload);
      case 'getCategories':
        return this.getCategories(payload);
      case 'getDetails':
        return this.getDetails(payload);
      case 'resolveStream':
        return this.resolveStream(payload);
      case 'deleteProfile':
        return this.deleteProfile(payload);
      case 'diagnostics':
        return this.diagnostics(payload);
      default:
        throw new AppError('internal/unexpected', 'commande inconnue');
    }
  }

  /* ------------------------------------------------------------ testProfile */

  private async testProfile(payload: Record<string, unknown>): Promise<unknown> {
    const kind = payload.kind === 'm3u' ? 'm3u' : payload.kind === 'xtream' ? 'xtream' : null;
    if (!kind) throw new AppError('profile/invalid', 'type de source manquant (xtream ou m3u)');
    const input: ProfileInput = {
      kind: kind,
      baseUrl: asString(payload.baseUrl),
      playlistUrl: asString(payload.playlistUrl),
      username: asString(payload.username),
      password: asString(payload.password),
      epgUrl: asString(payload.epgUrl),
      lanAllowed: payload.lanAllowed === true
    };
    if (kind === 'm3u') {
      // M3U est un second moteur de données, livré en V1-D (§1.4) : la commande existe et le dit.
      return ls2Ok<TestResult>({
        ok: false,
        warnings: ['M3U est prevu en V1-D : second moteur de donnees (identite logicalKey/variantKey, import reprenable)'],
        errors: [{ code: 'provider/unsupported', message: 'source M3U non encore supportee par cette version', retryable: false }]
      });
    }
    if (!input.baseUrl) throw new AppError('profile/invalid', 'adresse de portail manquante');
    const testConsent = (payload.consent || {}) as Record<string, unknown>;
    if (testConsent.insecureHttp === true) {
      // l'utilisateur a confirmé l'avertissement « HTTP clair » pour cet hôte
      await this.acceptInsecureHost(hostOf(input.baseUrl), asString(payload.profileId));
    }
    const provider = this.providerFor(
      {
        id: 'session',
        baseUrl: input.baseUrl,
        lanAllowed: input.lanAllowed,
        userAgent: asString(payload.userAgent)
      },
      {
      username: input.username,
      password: input.password,
      acceptedHosts: await this.acceptedHostsFor('session')
    });
    const result = await provider.testConnection();
    // Les identifiants de session ne sont pas mémorisés ici : `testProfile` ne persiste rien.
    return ls2Ok<TestResult>(result);
  }

  /* --------------------------------------------------------- importPlaylist */

  private async importPlaylist(
    payload: Record<string, unknown>,
    respond: BusRespond,
    subscribed: boolean
  ): Promise<unknown> {
    const profileId = requireString(payload.profileId, 'profileId');
    const kindValue = payload.kind;
    if (kindValue !== 'xtream' && kindValue !== 'm3u') {
      throw new AppError('profile/invalid', 'type de source invalide');
    }
    if (kindValue === 'm3u') {
      throw new AppError('provider/unsupported', 'M3U arrive en V1-D (second moteur de donnees)', 'utiliser une source Xtream pour cette version');
    }
    // Le type de contenu est validé avant les identifiants : un paramètre de commande invalide ne se
    // déguise jamais en problème de compte.
    const importContentType: XtreamContentType = requireImportContentType(payload.contentType);
    const source = (payload.source || {}) as Record<string, unknown>;
    const credentials = (source.credentials || {}) as Record<string, unknown>;
    const consent = (payload.consent || {}) as Record<string, unknown>;
    const groups = Array.isArray(payload.groups) ? (payload.groups as unknown[]).map(String) : undefined;

    const baseUrlFournie = asString(source.url);
    let profile = await this.profiles.get(profileId);
    // Aucune commande LS2 ne crée de profil : `importPlaylist` porte tout ce qu'il faut
    // (`kind`, `source.url`) et **crée donc le profil au premier import**, au lieu de le refuser.
    // Sans cela, un appareil neuf ne peut jamais importer : le premier appel répondrait
    // « profil inconnu » (constaté sur le simulateur).
    let profilCree = false;
    if (!profile) {
      if (!baseUrlFournie) {
        throw new AppError('profile/invalid', 'adresse de portail manquante', 'preciser source.url au premier import');
      }
      profile = {
        id: profileId,
        name: nameFromUrl(baseUrlFournie),
        kind: 'xtream',
        providerType: 'xtream',
        preferredLiveFormat: 'auto',
        status: 'ok',
        baseUrl: baseUrlFournie,
        lanAllowed: payload.lanAllowed === true,
        persistSecrets: false
      };
      await this.profiles.save(profile);
      profilCree = true;
    }
    const sessionSecrets = this.sessionSecrets[profileId] || { acceptedHosts: [] };
    const baseUrl = baseUrlFournie || profile.baseUrl;
    if (!baseUrl) throw new AppError('profile/invalid', 'adresse de portail manquante');

    const persistSecrets = consent.persistSecrets === true;
    const username = asString(credentials.username) || sessionSecrets.username || profile.username;
    const password = asString(credentials.password) || sessionSecrets.password || profile.password;
    if (!username || !password) {
      throw new AppError('auth/invalidCredentials', 'identifiants requis pour importer ce portail', 'ressaisir les identifiants du profil');
    }
    if (consent.insecureHttp === true) {
      await this.acceptInsecureHost(hostOf(baseUrl), profileId);
    }
    if (persistSecrets) {
      // consentement explicite « Mémoriser ce profil sur ce téléviseur » (§8.2)
      await this.consents.record({ profileId, kind: 'persistProfile', acceptedAt: this.now() });
      await this.profiles.save(Object.assign({}, profile, { username, password, persistSecrets: true }));
    } else {
      this.rememberSessionSecrets(profileId, { username, password });
    }
    const busy = this.busyProfiles[profileId];
    if (busy) throw new AppError('catalog/busy', 'une operation est deja en cours pour ce profil', 'attendre ou annuler l operation en cours');

    // Contrôle préalable du schéma : une source en HTTP clair non confirmée est refusée **tout de
    // suite**, avec l'hôte à confirmer, au lieu de lancer un job qui échouera (« import interrompu »).
    const hotesAcceptes = await this.acceptedHostsFor(profileId);
    const hoteSource = hostOf(baseUrl);
    if (baseUrl.indexOf('http://') === 0 && hoteSource && hotesAcceptes.indexOf(hoteSource) === -1) {
      throw new AppError(
        'security/insecureScheme',
        'source en HTTP clair : avertissement a confirmer pour ce profil et cet hote',
        'hote:' + hoteSource
      );
    }

    // Contrôle préalable : un compte inactif, expiré ou refusé doit être **dit** tout de suite.
    // Sans lui, chaque appel fournisseur échoue et l'erreur affichée parle de réseau, ce qui envoie
    // l'utilisateur sur une fausse piste (constaté en phase 0A avec un abonnement de test expiré).
    const provider = this.providerFor(
      {
        id: profileId,
        baseUrl,
        lanAllowed: profile.lanAllowed,
        preferredLiveFormat: profile.preferredLiveFormat,
        userAgent: profile.userAgent
      },
      { username, password, acceptedHosts: await this.acceptedHostsFor(profileId) }
    );
    const verdict = await provider.testConnection();
    const refus = (verdict.errors || []).filter(
      (erreur) => erreur.retryable === false && erreur.code.indexOf('auth/') === 0
    );
    if (refus.length > 0) {
      const code: ErrorCode = refus[0].code === 'auth/invalidCredentials' ? 'auth/invalidCredentials' : 'auth/expired';
      throw new AppError(code, refus[0].message, 'verifier l abonnement et les identifiants avant de relancer l import');
    }

    const masterKey = await this.masterKeys.ensure(profileId);
    // Un job = **une** construction d'index = **un** type de contenu : la machine d'état §15.5 fait
    // de `done` un état terminal, donc une même « rafraîchissement » ne peut pas enchaîner
    // `downloading` trois fois. L'application appelle `importPlaylist` une fois par type de contenu
    // (`live` en V1-A, puis `vod` et `series` avec leurs incréments) et suit le `jobId` retourné.
    const contentType: XtreamContentType = importContentType;
    const indexVersion = this.nextIndexVersion(profileId, contentType);
    const job = createXtreamImportJob({
      profileId,
      contentType,
      indexVersion,
      usesEmbeddedCredentials: true,
      resumable: true,
      now: this.now()
    });
    await this.importJobs.save(job);
    this.busyProfiles[profileId] = job.jobId;

    if (subscribed) {
      const previous = this.subscribers[profileId];
      if (previous) {
        // une seule souscription active par profil : la précédente est close proprement, jamais
        // laissée muette (l'application sait qu'elle doit se raccrocher au même `jobId`)
        previous.respond(ls2Ok({ replaced: true, jobId: this.busyProfiles[profileId] }));
      }
      this.subscribers[profileId] = { profileId, respond, startedAt: this.now() };
    }

    // La suite s'exécute en tâche de fond : la réponse initiale porte le `jobId`, la progression
    // passe par l'abonnement (§15.4).
    void this.runOneImport({
      profileId,
      provider,
      masterKey,
      job,
      contentType,
      indexVersion,
      groups,
      persistSecrets,
      preferredLiveFormat: profile.preferredLiveFormat
    });

    return ls2Ok(
      { jobId: job.jobId, contentType, indexVersion, subscribed: subscribed, profilCree: profilCree },
      indexVersion
    );
  }

  /** Exécute un import (un type de contenu, un index) et publie progression puis état final. */
  private async runOneImport(input: {
    profileId: string;
    provider: XtreamProvider;
    masterKey: Buffer;
    job: ImportJob;
    contentType: XtreamContentType;
    indexVersion: number;
    groups?: string[];
    persistSecrets: boolean;
    preferredLiveFormat?: 'auto' | 'hls' | 'ts';
  }): Promise<void> {
    let currentJob = input.job;
    try {
      const running: RunningJob = {
        jobId: currentJob.jobId,
        profileId: input.profileId,
        contentType: input.contentType,
        indexVersion: input.indexVersion,
        cancel: () => {
          this.cancelFlags[currentJob.jobId] = true;
        }
      };
      this.runningJobs[currentJob.jobId] = running;
      const outcome = await runXtreamImport(
        input.provider,
        {
          profileId: input.profileId,
          contentType: input.contentType,
          indexVersion: input.indexVersion,
          masterKey: input.masterKey,
          job: currentJob,
          baseDir: this.contentTypeDir(input.profileId, input.contentType as ContentType),
          resumeFromEntry: resumeEntryFor(currentJob, input.contentType),
          persistSecrets: input.persistSecrets,
          preferredLiveFormat: input.preferredLiveFormat,
          groups: input.groups
        },
        {
          shouldAbort: () => this.cancelFlags[currentJob.jobId] === true,
          onCheckpoint: async (job) => {
            currentJob = job;
            await this.importJobs.save(job);
            this.publish(input.profileId, ls2Ok({ job: job, jobId: job.jobId }, input.indexVersion));
          }
        }
      );
      delete this.runningJobs[currentJob.jobId];
      if (outcome.outcome === 'failed') {
        // Un échec ne touche jamais l'index élu (§2.4). La cause **réelle** est transmise telle
        // quelle : un « internal/unexpected » générique masquait le code utile (constaté en phase 0A :
        // un import refusé pour HTTP clair s'affichait comme une panne interne indiagnosticable).
        // `outcome.error` est la **forme sérialisée** de l'erreur (`toShape`), pas une instance :
        // on la reconstitue pour conserver code, message et indication.
        const brut = outcome.error as { code?: string; message?: string; hint?: string } | undefined;
        const cause =
          brut && typeof brut.code === 'string' && brut.code !== ''
            ? new AppError(brut.code as ErrorCode, brut.message || 'import interrompu avant la bascule', brut.hint)
            : new AppError('internal/unexpected', 'import interrompu avant la bascule');
        this.publish(input.profileId, ls2Fail(cause, input.indexVersion));
        return;
      }
      if (outcome.outcome !== 'done') return;
      this.invalidateReaders(input.profileId, input.contentType as ContentType);
      this.publish(input.profileId, ls2Ok({ job: currentJob, jobId: currentJob.jobId, final: true }, input.indexVersion));
    } finally {
      delete this.busyProfiles[input.profileId];
      delete this.subscribers[input.profileId];
      delete this.cancelFlags[currentJob.jobId];
    }
  }

  private publish(profileId: string, reply: unknown): void {
    const subscriber = this.subscribers[profileId];
    if (!subscriber) return;
    try {
      assertReplySafe(reply);
      subscriber.respond(reply);
    } catch (_error) {
      // l'application s'est fermée : la souscription est close, l'import continue sa route jusqu'à
      // la bascule ou l'annulation, sans dépendre d'un abonné présent (§2.4).
      delete this.subscribers[profileId];
    }
  }

  /* ------------------------------------------------------------- jobs LS2 */

  private async getImportJob(payload: Record<string, unknown>): Promise<unknown> {
    const jobId = requireString(payload.jobId, 'jobId');
    const job = await this.importJobs.get(jobId);
    if (!job) throw new AppError('catalog/notFound', 'aucun import ne correspond a cet identifiant');
    const offerCleanup = shouldOfferCleanup(job, this.now());
    return ls2Ok({ job, offerCleanup }, job.tempIndexVersion);
  }

  private async cancelOperation(payload: Record<string, unknown>): Promise<unknown> {
    const jobId = requireString(payload.jobId, 'jobId');
    if (this.runningJobs[jobId]) {
      this.runningJobs[jobId].cancel();
      return ls2Ok({ cancelled: true, jobId });
    }
    const job = await this.importJobs.get(jobId);
    if (!job) throw new AppError('catalog/notFound', 'aucun import ne correspond a cet identifiant');
    return ls2Ok({ cancelled: false, jobId, phase: job.phase });
  }

  /* ------------------------------------------------------------- lecture */

  private async getPage(payload: Record<string, unknown>): Promise<unknown> {
    const profileId = requireString(payload.profileId, 'profileId');
    const contentType = requireContentType(payload.contentType);
    const order = payload.order === 'title' ? 'title' : 'source';
    const cursor = (payload.cursor || undefined) as Cursor | undefined;
    const categoryId = asString(payload.categoryId);
    const reader = await this.openReader(profileId, contentType);
    const page = reader.getPage({ categoryId: categoryId, order: order, cursor: cursor });
    assertObjectCap(page.items as unknown[]);
    return ls2Ok(page, page.indexVersion);
  }

  private async search(payload: Record<string, unknown>): Promise<unknown> {
    const profileId = requireString(payload.profileId, 'profileId');
    const contentType = requireContentType(payload.contentType);
    const query = requireString(payload.query, 'query');
    const cursor = (payload.cursor || undefined) as Cursor | undefined;
    const reader = await this.openReader(profileId, contentType);
    // la requête est normalisée côté service : le module de normalisation vit ici, pas dans l'UI
    const page = reader.search({ query: query, cursor: cursor });
    assertObjectCap(page.items as unknown[]);
    return ls2Ok(page, page.indexVersion);
  }

  private async getBuckets(payload: Record<string, unknown>): Promise<unknown> {
    const profileId = requireString(payload.profileId, 'profileId');
    const contentType = requireContentType(payload.contentType);
    const reader = await this.openReader(profileId, contentType);
    return ls2Ok(reader.getBuckets(), reader.indexVersion);
  }

  /**
   * Catégories du catalogue, dans l'ordre fournisseur, avec leur nombre d'entrées (§3.2 à §3.4).
   *
   * Elles proviennent de `groups.bin`, déjà écrit à l'indexation : aucune requête fournisseur n'est
   * refaite pour afficher le panneau des catégories, et l'UI ne recalcule jamais de comptage.
   * Les plages d'ordinaux internes (`ranges`) ne sortent pas : seule la liste affichable est servie.
   */
  private async getCategories(payload: Record<string, unknown>): Promise<unknown> {
    const profileId = requireString(payload.profileId, 'profileId');
    const contentType = requireContentType(payload.contentType);
    const reader = await this.openReader(profileId, contentType);
    const groupes = reader.getGroups();
    const categories = groupes
      .slice()
      .sort((a, b) => a.sourceOrder - b.sourceOrder)
      .map((groupe) => ({ id: groupe.id, name: groupe.name, count: groupe.count, sourceOrder: groupe.sourceOrder }));
    return ls2Ok({ categories: categories, total: reader.entryCount }, reader.indexVersion);
  }

  private async getDetails(payload: Record<string, unknown>): Promise<unknown> {
    const profileId = requireString(payload.profileId, 'profileId');
    const contentType = requireContentType(payload.contentType);
    const ref = (payload.ref || {}) as Record<string, unknown>;
    const providerId = asString(ref.providerId);
    if (!providerId) throw new AppError('profile/invalid', 'reference sans identifiant fournisseur');
    const reader = await this.openReader(profileId, contentType);
    const ordinal = reader.findOrdinalByProviderId(providerId);
    if (ordinal === null) throw new AppError('catalog/notFound', 'element absent de cet index');
    const details = reader.getDetails(ordinal);
    const detail: CatalogDetailRecord = Object.assign({}, details.item, {
      // `streamRef` reste une référence opaque : aucune URL ne sort par cette commande (§15.4)
      streamRef: reader.detailRef(ordinal),
      streamMode: reader.streamMode(ordinal)
    });
    if (details.heavy.p) detail.plot = details.heavy.p;
    const bytes = replyBytes(detail);
    if (bytes > MAX_DETAIL_BYTES) {
      throw new AppError('internal/unexpected', 'detail au-dela du plafond de 32 Kio');
    }
    return ls2Ok(detail, reader.indexVersion);
  }

  /**
   * `resolveStream` : **seule** commande qui renvoie une URL de flux. Elle est appelée juste avant
   * la lecture, n'est jamais mise en cache au-delà d'`expiresAt`, et son résultat n'est ni
   * journalisé ni conservé dans un état d'écran (§6.1, §15.1).
   */
  private async resolveStream(payload: Record<string, unknown>): Promise<unknown> {
    const profileId = requireString(payload.profileId, 'profileId');
    const ref = (payload.ref || {}) as Record<string, unknown>;
    // le type de contenu vient de la référence (contrat §15.4 : `{profileId, ref, requestedFormat?}`)
    const contentType = requireContentType(ref.contentType || payload.contentType);
    const providerId = asString(ref.providerId);
    if (!providerId) throw new AppError('profile/invalid', 'reference sans identifiant fournisseur');
    const requestedFormat = payload.requestedFormat === 'hls' ? 'hls' : payload.requestedFormat === 'ts' ? 'ts' : 'auto';

    const profile = await this.profiles.get(profileId);
    if (!profile) throw new AppError('profile/invalid', 'profil inconnu');
    const reader = await this.openReader(profileId, contentType);
    const ordinal = reader.findOrdinalByProviderId(providerId);
    if (ordinal === null) throw new AppError('catalog/notFound', 'element absent de cet index');

    const details = reader.getDetails(ordinal);
    const session = this.sessionSecrets[profileId];
    const credentials = {
      username: session && session.username ? session.username : profile.username,
      password: session && session.password ? session.password : profile.password
    };
    const provider = this.providerFor(
      {
        id: profileId,
        baseUrl: profile.baseUrl,
        lanAllowed: profile.lanAllowed,
        preferredLiveFormat: profile.preferredLiveFormat,
        userAgent: profile.userAgent
      },
      { username: credentials.username, password: credentials.password, acceptedHosts: await this.acceptedHostsFor(profileId) }
    );

    const streamMode = reader.streamMode(ordinal);
    let resolution: StreamResolution;
    if ((streamMode === 'storedSecret' || streamMode === 'urlNoSecret') && details.heavy.u) {
      // mode `storedSecret` : URL conservée dans l'index chiffré au repos
      resolution = {
        url: details.heavy.u,
        kind: streamMode,
        resolvedAt: this.now()
      };
      const extension = details.heavy.u.split('?')[0].split('.').pop();
      if (extension === 'm3u8') resolution.preferredMime = 'application/vnd.apple.mpegurl';
      else if (extension === 'ts') resolution.preferredMime = 'video/mp2t';
    } else {
      if (!credentials.username || !credentials.password) {
        throw new AppError('auth/invalidCredentials', 'identifiants non memorises : ressaisir le profil pour lire ce flux', 'saisir les identifiants du profil');
      }
      const built = provider.buildStreamUrl(
        {
          providerId,
          contentType: contentType,
          containerExtension: extensionFromForm(details.heavy.f)
        },
        requestedFormat
      );
      resolution = {
        url: built.url,
        kind: built.kind,
        resolvedAt: this.now()
      };
      if (built.preferredMime) resolution.preferredMime = built.preferredMime;
    }
    // Contrôle de schéma/hôte : best-effort côté service, le pipeline média garde son propre chemin
    if (!/^https?:\/\//i.test(resolution.url)) {
      throw new AppError('provider/unsupported', 'schema d URL de lecture non supporte');
    }
    return ls2Ok(resolution, reader.indexVersion);
  }

  /* ------------------------------------------------------------- profil */

  private async deleteProfile(payload: Record<string, unknown>): Promise<unknown> {
    const profileId = requireString(payload.profileId, 'profileId');
    if (this.busyProfiles[profileId]) {
      throw new AppError('catalog/busy', 'un import est en cours pour ce profil', 'annuler l import avant de supprimer le profil');
    }
    const summary = await deleteProfileData(this.db, profileId, {
      profiles: this.profiles,
      importJobs: this.importJobs,
      masterKeys: this.masterKeys,
      consents: this.consents,
      favorites: this.favorites,
      playbacks: this.playbacks
    });
    // Fichiers : index, temporaires et résolutions en cache — la clé maître a déjà disparu, donc
    // l'ancien index est illisible même si un fichier survivait (§15.4).
    CONTENT_TYPES.forEach((contentType) => {
      delete this.readers[readerKey(profileId, contentType)];
    });
    deleteProfileFiles(this.profileRootDir(profileId));
    delete this.sessionSecrets[profileId];
    delete this.subscribers[profileId];
    return ls2Ok({ deleted: true, profileId: profileId, kindsCleared: summary.kindsCleared, masterKeyRemoved: summary.masterKeyRemoved });
  }

  /* ---------------------------------------------------------- diagnostic */

  /** Diagnostic **local** : jamais de secret, jamais d'URL, export manuel uniquement (§9.2, §11.1). */
  private async diagnostics(payload: Record<string, unknown>): Promise<unknown> {
    const runtime = describeRuntime();
    // Sonde DB8 : sur un appareil où la base n'est pas accessible (simulateur, ACG non accordées),
    // le service doit le **dire** au lieu d'échouer globalement — c'est ce que la page affiche.
    let db: Record<string, unknown> = { ok: true };
    let profiles: Profile[] = [];
    try {
      profiles = await this.profiles.list();
      db = { ok: true, profiles: profiles.length };
    } catch (error) {
      db = { ok: false, erreur: describe(error) };
    }
    const indexes: Array<Record<string, unknown>> = [];
    for (const profile of profiles) {
      for (const contentType of ['live', 'vod', 'series'] as ContentType[]) {
        const manifest = readManifest(this.contentTypeDir(profile.id, contentType));
        if (!manifest) continue;
        indexes.push({
          profileId: profile.id,
          contentType,
          indexVersion: manifest.indexVersion,
          entryCount: manifest.entryCount,
          state: manifest.state,
          searchIndexKind: manifest.searchIndexKind,
          scriptBuckets: manifest.scriptBuckets.buckets.length,
          createdAt: manifest.createdAt
        });
      }
    }
    let jobsResume: ImportJob[] = [];
    try {
      jobsResume = await this.importJobsSummary();
    } catch (error) {
      db = Object.assign({}, db, { jobs: 'indisponibles : ' + describe(error) });
    }
    const jobs = jobsResume.map((job) => ({
      jobId: job.jobId,
      profileId: job.profileId,
      sourceType: job.sourceType,
      phase: job.phase,
      entriesRead: job.entriesRead,
      bytesRead: job.bytesRead,
      updatedAt: job.updatedAt,
      warnings: job.warnings.length
    }));
    const tls = {
      runtime,
      observations: this.tlsObservations.map((observation) => ({
        host: observation.stack,
        mode: observation.mode,
        ok: observation.ok,
        protocol: observation.protocol,
        errorCode: observation.errorCode,
        chainFailure: observation.chainFailure
      })),
      report: buildTlsReport(runtime, this.tlsObservations),
      cacheByHost: this.http.tlsByHost
    };
    let roots: Record<string, unknown>;
    try {
      roots = Object.assign({}, rootsDiagnostics());
    } catch (_error) {
      roots = { error: 'bundle de racines indisponible' };
    }
    return ls2Ok({
      app: { service: SERVICE_NAME, storageRoot: this.storageRoot },
      db: db,
      runtime,
      tls,
      roots,
      indexes,
      jobs,
      profiles: profiles.map((profile) => redactProfile(profile)),
      capabilities: this.capabilities(),
      requestedBy: asString(payload.scope) || 'local'
    });
  }

  /**
   * Capacités : ce qui est **démontré** est distingué de ce qui reste « non certifié » (§2.6).
   * Rien n'est promis tant que la phase 0 n'a pas mesuré sur la TV.
   */
  private capabilities(): Record<string, string> {
    return {
      'player.nativeVideo': 'non certifie (phase 0B)',
      'player.hls': 'non certifie (phase 0B)',
      'player.mpegts': 'non certifie (phase 0B)',
      'service.ls2': 'implemente, validation TV en 0A',
      'service.db8': 'implemente, ACG a valider en 0A',
      'service.privateStorage': 'implemente, chemins a valider en 0A',
      'index.encrypted': 'implemente (tests locaux), cout a mesurer en 0D',
      'tls.embeddedRoots': 'implemente, a confronter a une racine recente en 0D',
      'm3u': 'non livre (V1-D)',
      'epg': 'non livre (V1-B)'
    };
  }

  /* --------------------------------------------------------------- outillage */

  private async importJobsSummary(): Promise<ImportJob[]> {
    const rows = await this.db.find<Record<string, unknown>>('importJobs', {});
    return rows.map((row) => row.job as ImportJob).filter(Boolean);
  }

  private providerFor(
    profile: {
      id: string;
      baseUrl?: string;
      lanAllowed?: boolean;
      preferredLiveFormat?: 'auto' | 'hls' | 'ts';
      userAgent?: string;
    },
    session: XtreamSession
  ): XtreamProvider {
    return new XtreamProvider({
      http: this.http,
      profile: {
        id: profile.id,
        baseUrl: profile.baseUrl,
        username: session.username,
        password: session.password,
        lanAllowed: profile.lanAllowed,
        preferredLiveFormat: profile.preferredLiveFormat,
        userAgent: profile.userAgent
      },
      session: session,
      onWarning: (warning) => this.onLog('fournisseur : ' + warning)
    });
  }

  private async openReader(profileId: string, contentType: ContentType): Promise<CatalogIndexReader> {
    const key = readerKey(profileId, contentType);
    const cached = this.readers[key];
    const baseDir = this.contentTypeDir(profileId, contentType);
    const manifest = readManifest(baseDir);
    if (!manifest) throw new AppError('catalog/indexMissing', 'aucun index valide pour ce profil et ce type', 'importer la source');
    if (cached && cached.indexVersion === manifest.indexVersion && manifest.contentType === contentType) return cached.reader;
    if (cached) {
      cached.reader.close();
      delete this.readers[key];
    }
    const masterKey = await this.masterKeys.get(profileId);
    if (!masterKey) throw new AppError('catalog/corrupt', 'cle maitre absente : index illisible', 'reimporter la source');
    const reader = CatalogIndexReader.open({
      baseDir: baseDir,
      profileId: profileId,
      contentType: contentType,
      masterKey: masterKey,
      expectedIndexVersion: manifest.indexVersion,
      refKind: 'providerId'
    });
    this.readers[key] = { reader: reader, indexVersion: manifest.indexVersion };
    return reader;
  }

  private invalidateReaders(profileId: string, contentType: ContentType): void {
    const key = readerKey(profileId, contentType);
    const cached = this.readers[key];
    if (!cached) return;
    cached.reader.close();
    delete this.readers[key];
  }

  /** Répertoire par profil et par type de contenu, sous le répertoire privé du service. */
  contentTypeDir(profileId: string, contentType: ContentType): string {
    return this.profileRootDir(profileId) + '/' + contentType;
  }

  /** Racine d'un profil : tout ce qui doit disparaître avec lui (§15.4 `deleteProfile`). */
  profileRootDir(profileId: string): string {
    const safeProfile = crypto.createHash('sha256').update(profileId).digest('hex').slice(0, 16);
    return this.storageRoot + '/' + safeProfile;
  }

  private nextIndexVersion(profileId: string, contentType: XtreamContentType): number {
    const manifest = readManifest(this.contentTypeDir(profileId, contentType));
    return (manifest ? manifest.indexVersion : 0) + 1;
  }

  private rememberSessionSecrets(profileId: string, secrets: { username: string; password: string }): void {
    const current = this.sessionSecrets[profileId] || { acceptedHosts: [] };
    this.sessionSecrets[profileId] = {
      username: secrets.username,
      password: secrets.password,
      acceptedHosts: current.acceptedHosts
    };
  }

  private async acceptedHostsFor(profileId: string): Promise<string[]> {
    const consents = await this.consents.list(profileId);
    const hosts = consents
      .filter((consent) => consent.kind === 'insecureHttp' && consent.insecureHost)
      .map((consent) => consent.insecureHost as string);
    const session = this.sessionSecrets[profileId];
    const sessionHosts = session ? session.acceptedHosts : [];
    // les hôtes acceptés pendant la session valent pour toute source de cette session de service
    return hosts.concat(sessionHosts, this.sessionAcceptedHosts);
  }

  /**
   * Enregistre le consentement « HTTP clair » pour un hôte (§8.2), une seule fois par profil et par
   * hôte, et retient l'hôte pour la session en cours — y compris sans profil (`testProfile` peut
   * être appelé avant tout enregistrement de profil).
   */
  private async acceptInsecureHost(host: string | null, profileId?: string): Promise<void> {
    if (!host) return;
    if (this.sessionAcceptedHosts.indexOf(host) === -1) this.sessionAcceptedHosts.push(host);
    if (!profileId) return;
    const consents = await this.consents.list(profileId);
    const already = consents.some((consent) => consent.kind === 'insecureHttp' && consent.insecureHost === host);
    if (!already) {
      await this.consents.record({ profileId, kind: 'insecureHttp', insecureHost: host, acceptedAt: this.now() });
    }
  }

  /* -------------------------------------------------------- démarrage service */

  /**
   * Travaux de démarrage (§2.4, §15.5) :
   *  - fichiers `.tmp` orphelins et versions non élues supprimés ;
   *  - jobs `interrupted` depuis plus de 7 jours proposés à la suppression, sans bloquer l'usage ;
   *  - aucun keep-alive, aucune connexion persistante, aucun work en arrière-plan.
   */
  async startupMaintenance(): Promise<{ prunedFiles: string[]; staleJobs: string[] }> {
    const prunedFiles: string[] = [];
    const staleJobs: string[] = [];
    const profiles = await this.profiles.list();
    for (const profile of profiles) {
      for (const contentType of CONTENT_TYPES) {
        const baseDir = this.contentTypeDir(profile.id, contentType);
        const manifest = readManifest(baseDir);
        const keep = manifest ? [manifest.indexVersion] : [];
        const removed = pruneOrphans(baseDir, keep);
        removed.forEach((name) => prunedFiles.push(profile.id + '/' + contentType + '/' + name));
      }
    }
    const jobs = await this.importJobsSummary();
    for (const job of jobs) {
      if (shouldOfferCleanup(job, this.now())) staleJobs.push(job.jobId);
    }
    return { prunedFiles, staleJobs };
  }
}

/* ------------------------------------------------------------------ outils */

/**
 * Base de reprise : le nombre d'entrées **déjà indexées**. Un tableau JSON n'ayant pas de frontière
 * d'octet, la reprise repart de `entriesRead` et ignore déterministiquement les N premières entrées
 * relues — `byteOffset` n'a de sens que pour les sources ligne-à-ligne (M3U/XMLTV, V1-D).
 */
function resumeEntryFor(job: ImportJob, contentType: XtreamContentType): number {
  void contentType;
  return job.entriesRead > 0 ? job.entriesRead : 0;
}

function readerKey(profileId: string, contentType: ContentType): string {
  return profileId + '|' + contentType;
}

/** Nom lisible d'un profil créé à l'import : le nom d'hôte du portail, jamais l'URL complète. */
function nameFromUrl(url: string): string {
  return hostOf(url) || 'Portail';
}

/** Message d'erreur utilisable dans une réponse LS2 : code si typé, message sinon. */
function describe(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error) return error.message;
  return 'erreur inconnue';
}

function requireString(value: unknown, field: string): string {
  const text = asString(value);
  if (!text) throw new AppError('profile/invalid', 'parametre manquant : ' + field);
  return text;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && isFinite(value)) return String(value);
  return undefined;
}

/** Type de contenu d'un import : `live`, `vod` ou `series` (les episodes viennent du detail). */
function requireImportContentType(value: unknown): XtreamContentType {
  if (value === undefined || value === null || value === '') return 'live';
  if (value === 'live' || value === 'vod' || value === 'series') return value;
  throw new AppError('profile/invalid', 'type de contenu importable invalide (live, vod ou series)');
}

function requireContentType(value: unknown): ContentType {
  if (value === 'live' || value === 'vod' || value === 'series' || value === 'episode') return value;
  throw new AppError('profile/invalid', 'type de contenu invalide');
}

function extensionFromForm(form: string | undefined): string | undefined {
  if (!form) return undefined;
  const match = /\.([A-Za-z0-9]{1,6})$/.exec(form);
  return match ? match[1].toLowerCase() : undefined;
}

