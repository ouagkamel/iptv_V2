/**
 * Import Xtream reprenable (§2.4, §15.5).
 *
 * Séquence : `downloading → parsing → writing → validating → swapping → done`, avec un
 * **checkpoint persisté à chaque lot** (le handler LS2 écrit l'`ImportJob` en DB8). `swapping` est
 * la seule transition qui change la version élue, et elle est atomique (`rename` + manifeste).
 *
 * Reprise après mort du service : le staging est conservé (il n'est supprimé que sur annulation
 * explicite) ; `CatalogIndexWriter.reopen()` reconstruit l'état interne **en relisant les secteurs
 * déjà écrits**, puis la source est relue depuis son début en ignorant les éléments déjà indexés.
 *
 * Pourquoi relire plutôt que reprendre à un offset d'octet : une réponse Xtream est un **tableau
 * JSON**, où un offset d'octet ne correspond pas à une frontière d'enregistrement. Le
 * `resumeHint.byteOffset` du contrat §15.1 vise les sources **ligne par ligne** (M3U, XMLTV), où
 * l'offset est une frontière sûre — c'est l'import M3U de V1-D. Ici, l'analyse est déterministe :
 * ignorer les N premiers éléments relus reproduit exactement l'index déjà écrit.
 */

import { AppError } from '../../contracts/errors';
import { refHashFor } from '../store/identity';
import { markHost } from '../../core/hostSafety';
import { analyzeCredential } from '../../core/urltools';
import type { ImportJob } from '../../contracts/types';
import { checkpointImport, createImportJob, transitionImport } from '../../core/machines';
import { CatalogIndexWriter, type IndexEntryInput } from '../store/writer';
import type { IndexManifest } from '../store/manifest';
import { XtreamProvider } from '../providers/xtream';
import type { XtreamContentType, XtreamStreamRecord } from '../providers/xtreamSchema';

export interface XtreamImportPlan {
  profileId: string;
  contentType: XtreamContentType;
  indexVersion: number;
  masterKey: Buffer;
  /** indexVersion de reprise : staging conservé après une mort du service */
  job: ImportJob;
  baseDir: string;
  /** nombre d'entrées déjà indexées à ignorer lors de la relecture de la source */
  resumeFromEntry?: number;
  /** identifiants retenus (consentement) : décide du mode `storedSecret` ou `derived` */
  persistSecrets: boolean;
  preferredLiveFormat?: 'auto' | 'hls' | 'ts';
  lanAllowed?: boolean;
  groups?: string[];
}

export interface XtreamImportHooks {
  /** persiste le job (DB8) et publie la progression à l'abonné LS2 */
  onCheckpoint: (job: ImportJob) => Promise<void> | void;
  shouldAbort: () => boolean;
  /** cadence des checkpoints */
  checkpointEveryEntries?: number;
  checkpointEveryBytes?: number;
}

export interface XtreamImportOutcome {
  outcome: 'done' | 'cancelled' | 'interrupted' | 'failed';
  job: ImportJob;
  manifest?: IndexManifest;
  entries: number;
  skipped: number;
  bytesRead: number;
  warnings: string[];
  /** forme sérialisée (`AppErrorShape`) : code, message, réessayable et indication éventuelle */
  error?: { code: string; message: string; retryable: boolean; hint?: string };
}

const DEFAULT_CHECKPOINT_ENTRIES = 2000;
const DEFAULT_CHECKPOINT_BYTES = 4 * 1024 * 1024;

export function indexVersionFor(contentType: XtreamContentType, previous?: number): number {
  return (previous === undefined ? 0 : previous) + 1;
}

/** Empreinte d'identité stockée dans le secteur (jamais l'URL, jamais l'identifiant en clair). */
export function xtreamRefHash(contentType: XtreamContentType, providerId: string): string {
  return refHashFor(contentType, providerId);
}

export function createXtreamImportJob(input: {
  profileId: string;
  contentType: XtreamContentType;
  indexVersion: number;
  usesEmbeddedCredentials: boolean;
  resumable: boolean;
  now?: number;
}): ImportJob {
  const stamp = input.now === undefined ? Date.now() : input.now;
  return createImportJob({
    jobId: 'xtream:' + input.profileId + ':' + input.contentType + ':' + stamp,
    profileId: input.profileId,
    sourceType: 'xtream',
    tempIndexVersion: input.indexVersion,
    usesEmbeddedCredentials: input.usesEmbeddedCredentials,
    now: stamp
  });
}

/**
 * Exécute l'import d'un type de contenu. Ne lève jamais pour une erreur prévue : le résultat porte
 * l'issue (`done`, `cancelled`, `interrupted`, `failed`) afin que l'appelant persiste l'état exact.
 */
export async function runXtreamImport(
  provider: XtreamProvider,
  plan: XtreamImportPlan,
  hooks: XtreamImportHooks
): Promise<XtreamImportOutcome> {
  let job = plan.job;
  const warnings: string[] = [];
  let writer: CatalogIndexWriter | null = null;
  /** enregistrements vus chez le fournisseur (base de reprise : position dans le flux) */
  let entries = 0;
  let bytesRead = 0;
  /** enregistrements volontairement non indexés : relecture après reprise + filtres de groupes */
  let skippedResumed = 0;
  let skippedFiltered = 0;
  let lastCheckpointEntries = 0;
  let lastCheckpointBytes = 0;
  const checkpointEveryEntries = hooks.checkpointEveryEntries || DEFAULT_CHECKPOINT_ENTRIES;
  const checkpointEveryBytes = hooks.checkpointEveryBytes || DEFAULT_CHECKPOINT_BYTES;
  const resumeFromEntry = plan.resumeFromEntry || 0;

  /**
   * Points de reprise pendant le téléchargement (§15.5 : l'état est écrit **à chaque lot**, pas
   * seulement en fin d'import). Les rappels du fournisseur sont synchrones : les écritures DB8 sont
   * donc mises en file et sérialisées, sans jamais bloquer la lecture du flux.
   */
  let checkpointChain: Promise<void> = Promise.resolve();
  const scheduleCheckpoint = (currentCategory?: string): void => {
    if (job.phase !== 'downloading') return;
    job = checkpointImport(job, {
      bytesRead: bytesRead,
      // `entriesRead` = position dans le flux fournisseur : c'est ce qui rend la reprise exacte,
      // y compris quand un filtre de groupes écarte des enregistrements
      entriesRead: entries,
      currentCategory: currentCategory
    });
    const snapshot = job;
    checkpointChain = checkpointChain
      .then(() => hooks.onCheckpoint(snapshot))
      .catch((error) => {
        // un échec d'écriture de progression ne doit pas tuer un import en cours ; il sera visible
        // au prochain point de reprise et dans les avertissements du job.
        warnings.push('point de reprise non enregistre : ' + (error instanceof Error ? error.message : 'erreur inconnue'));
      });
  };

  const persist = async (patch: Partial<ImportJob> & { phase: ImportJob['phase'] }): Promise<void> => {
    await checkpointChain;
    const transition = transitionImport(job, patch);
    if (!transition.accepted) {
      // une séquence invalide est un bug de code, jamais un état à ignorer en silence (§15.5)
      throw new AppError('internal/unexpected', 'transition d import refusee : ' + job.phase + ' -> ' + patch.phase);
    }
    job = transition.job;
    await hooks.onCheckpoint(job);
  };

  try {
    // Un import interrompu **redémarre à sa source** avec un staging neuf : reprendre l'écriture d'un
    // index partiel demanderait d'aligner chaque enregistrement sur les blocs chiffrés (sinon le
    // couple (clé, nonce) serait réutilisé), ce que le format n'autorise pas (§15.3). Le staging
    // conservé par l'échec précédent est donc remplacé — l'exclusion mutuelle « une seule opération
    // lourde par profil » est tenue par l'appelant (`catalog/busy`, §15.4) ; ce qu'il contenait reste
    // consultable avant par `inspectStaging()` (diagnostic local).
    CatalogIndexWriter.discardStaging(writerOptions(plan));
    writer = new CatalogIndexWriter(writerOptions(plan));
    // Le job est déjà créé en phase `downloading` (§15.5) : l'ouverture du staging n'est pas une
    // transition, c'est un point de reprise — on persiste donc un instantané, pas une phase.
    job = checkpointImport(job, {
      bytesRead: 0,
      entriesRead: resumeFromEntry,
      resumeHint: { byteOffset: 0 }
    });
    await hooks.onCheckpoint(job);

    const credentialsPresent = provider.credentials() !== null;
    if (!credentialsPresent) {
      throw new AppError('auth/invalidCredentials', 'identifiants indisponibles pour importer ce portail', 'ressaisir les identifiants du profil');
    }

    const result = await provider.streamContentType(plan.contentType, {
      shouldAbort: hooks.shouldAbort,
      onProgress: (progress) => {
        bytesRead = progress.bytesRead;
        if (bytesRead - lastCheckpointBytes >= checkpointEveryBytes) {
          lastCheckpointBytes = bytesRead;
          lastCheckpointEntries = writer ? writer.entryCount : lastCheckpointEntries;
          scheduleCheckpoint(progress.currentCategory);
        }
      },
      onEntry: (record: XtreamStreamRecord) => {
        entries += 1;
        if (entries <= resumeFromEntry) {
          skippedResumed += 1;
          return;
        }
        if (plan.groups && plan.groups.length > 0 && record.categoryId && plan.groups.indexOf(record.categoryId) === -1) {
          skippedFiltered += 1;
          return;
        }
        writer?.append(toIndexEntry(record, plan, provider, warnings));
        const indexed = writer ? writer.entryCount : 0;
        if (indexed - lastCheckpointEntries >= checkpointEveryEntries) {
          lastCheckpointEntries = indexed;
          lastCheckpointBytes = Math.max(lastCheckpointBytes, bytesRead);
          scheduleCheckpoint(record.categoryId);
        }
      }
    });

    bytesRead = Math.max(bytesRead, result.bytesRead);
    result.warnings.forEach((warning) => {
      if (warnings.indexOf(warning) === -1) warnings.push(warning);
    });
    await persist({
      phase: 'parsing',
      bytesRead: bytesRead,
      entriesRead: entries,
      currentCategory: undefined,
      warnings: warnings.slice(0, 20)
    });
    await persist({ phase: 'writing', entriesRead: entries });

    if (hooks.shouldAbort()) throw new AppError('internal/cancelled', 'import annule');

    // Validation : le compte doit correspondre, sinon l'index n'est pas publié (§2.4).
    const skipped = skippedResumed + skippedFiltered;
    const expected = entries - skipped;
    if (writer.entryCount !== expected) {
      throw new AppError('catalog/corrupt', 'compteur d entree incoherent avant bascule');
    }
    await persist({ phase: 'validating', entriesRead: entries });

    const written = writer.finish();
    const manifest: IndexManifest = written.manifest;
    await persist({ phase: 'swapping', currentCategory: undefined });
    writer.commit(manifest);
    await persist({ phase: 'done', entriesRead: entries, resumable: false });
    return {
      outcome: 'done',
      job: job,
      manifest,
      entries: manifest.entryCount,
      skipped,
      bytesRead,
      warnings
    };
  } catch (error) {
    const appError = error instanceof Error && (error as { name?: string }).name === 'AppError' ? (error as AppError) : null;
    const code = appError ? appError.code : 'internal/unexpected';
    const cancelled = code === 'internal/cancelled';
    if (writer) {
      if (cancelled) writer.abort(); // choix explicite : rien à reprendre
      else writer.abortStagingKeep(); // échec : staging conservé pour une reprise sans repartir de zéro
    }
    const phase: ImportJob['phase'] = cancelled ? 'cancelled' : 'failed';
    const transition = transitionImport(job, { phase, warnings: mergeWarnings(warnings, appError) });
    job = transition.accepted ? transition.job : job;
    await hooks.onCheckpoint(job);
    return {
      outcome: cancelled ? 'cancelled' : 'failed',
      job,
      entries,
      skipped: skippedResumed + skippedFiltered,
      bytesRead,
      warnings,
      error: appError
        ? appError.toShape()
        : { code: 'internal/unexpected', message: 'echec inattendu pendant l import', retryable: true }
    };
  }
}

function mergeWarnings(warnings: string[], appError: AppError | null): string[] {
  const merged = warnings.slice(0, 20);
  if (appError) merged.push(appError.message);
  return merged;
}

function writerOptions(plan: XtreamImportPlan) {
  return {
    baseDir: plan.baseDir,
    profileId: plan.profileId,
    contentType: plan.contentType,
    indexVersion: plan.indexVersion,
    masterKey: plan.masterKey
  };
}

/** Convertit une entrée fournisseur en enregistrement d'index (marquage d'hôte compris, §5.2). */
export function toIndexEntry(
  record: XtreamStreamRecord,
  plan: XtreamImportPlan,
  provider: XtreamProvider,
  warnings: string[]
): IndexEntryInput {
  const markingSource = record.directSource || provider.portalUrl();
  const marking = markHost(markingSource, { lanAllowed: Boolean(plan.lanAllowed) });
  marking.warnings.forEach((warning) => {
    const text = 'marquage d hote : ' + warning;
    if (warnings.indexOf(text) === -1) warnings.push(text);
  });
  let streamMode: IndexEntryInput['streamMode'] = plan.persistSecrets ? 'storedSecret' : 'derived';
  let hasCredential = true;
  let playable = marking.playable;
  if (record.directSource) {
    // URL imposée par le portail : elle vit sur un CDN tiers, sans identifiant de portail
    const analysis = analyzeCredential(record.directSource);
    hasCredential = analysis.hasCredential;
    streamMode = hasCredential ? 'storedSecret' : 'urlNoSecret';
    if (hasCredential && !plan.persistSecrets) {
      // stocker une URL à identifiants sans consentement est exclu (§3.5) : l'entrée est listée
      // mais marquée non jouable, et le motif est consigné dans le job
      playable = false;
      const text = 'source imposee avec identifiants : memoriser le profil est requis pour la lire';
      if (warnings.indexOf(text) === -1) warnings.push(text);
    }
  }
  const entry: IndexEntryInput = {
    categoryId: record.categoryId || '',
    title: record.title,
    refKey: record.providerId,
    refHash: xtreamRefHash(plan.contentType, record.providerId),
    hostSafety: marking.hostSafety,
    streamMode: streamMode,
    // une URL Xtream construite porte l'utilisateur et le mot de passe dans son chemin
    hasCredential: hasCredential,
    playable: playable,
    summary: record.summary,
    logoOrPosterUrl: record.logoOrPosterUrl,
    epgId: record.epgId,
    year: record.year,
    durationSeconds: record.durationSeconds
  };
  if (record.directSource && !(hasCredential && !plan.persistSecrets)) {
    // URL imposée : elle est conservée telle quelle, qu'elle porte des identifiants ou non
    entry.streamUrl = record.directSource;
    return entry;
  }
  if (plan.persistSecrets) {
    try {
      const built = provider.buildStreamUrl(
        {
          providerId: record.providerId,
          contentType: record.seriesId ? 'series' : plan.contentType,
          containerExtension: record.containerExtension,
          directSource: record.directSource
        },
        plan.preferredLiveFormat || 'auto'
      );
      entry.streamUrl = built.url;
    } catch (_error) {
      // sans identifiants persistés, la relecture reconstruira l'URL : mode `derived`
      entry.streamMode = 'derived';
      entry.streamForm = formOf(record, plan.contentType);
    }
  } else {
    entry.streamForm = formOf(record, plan.contentType);
  }
  return entry;
}

/** Partie non secrète de l'URL, conservée en mode `derived` (identifiant de flux + extension). */
export function formOf(record: XtreamStreamRecord, contentType: XtreamContentType): string {
  const extension = record.containerExtension || (contentType === 'live' ? 'ts' : 'mp4');
  const segment = contentType === 'live' ? 'live' : contentType === 'vod' ? 'movie' : 'series';
  return '/' + segment + '/{credentials}/' + record.providerId + '.' + extension;
}
