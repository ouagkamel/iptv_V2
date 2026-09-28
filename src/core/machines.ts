/**
 * Machines d'état exactes (§15.5) — lecteur et import.
 *
 * Ces deux machines sont **pures** : elles ne touchent ni au DOM, ni au réseau, ni au disque.
 * L'interface et le service ne font qu'appliquer leurs transitions, ce qui permet de tester les
 * cas de bord (coalescence 400 ms, timeout 20 s sans première image, reprise d'import après mort
 * du service) sans téléviseur.
 */

import { AppError } from '../contracts/errors';
import type { ImportJob, ImportPhase } from '../contracts/types';

/* ------------------------------------------------------------------- lecteur */

export type PlayerState = 'IDLE' | 'PREPARING' | 'BUFFERING' | 'PLAYING' | 'PAUSED' | 'ERROR' | 'STOPPING';

export type PlayerEvent =
  | { type: 'play'; refKey: string }
  | { type: 'sourceAssigned' }
  | { type: 'playing' }
  | { type: 'pause' }
  | { type: 'waiting'; elapsedMs: number }
  | { type: 'mediaError'; detail?: string }
  | { type: 'noFirstFrameTimeout' }
  | { type: 'resolveFailed'; detail?: string }
  | { type: 'stop' }
  | { type: 'emptied' }
  | { type: 'stopTimeout' }
  | { type: 'retry' };

export interface PlayerEffect {
  type:
    | 'resolve'
    | 'assignSource'
    | 'load'
    | 'play'
    | 'pause'
    | 'clearSource'
    | 'showMessage'
    | 'hideOverlay'
    | 'startNoFirstFrameTimer'
    | 'clearTimers'
    | 'report';
  detail?: string;
}

/** Seuils normatifs (§15.5) — la coalescence et les temporisations vivent ici, pas dans la vue. */
export const ZAP_COALESCE_MS = 400;
export const NO_FIRST_FRAME_TIMEOUT_MS = 20000;
export const STALL_WARNING_MS = 12000;
export const STOP_TIMEOUT_MS = 2000;

export interface PlayerContext {
  /** identifiant logique de la cible en cours (jamais une URL) */
  refKey?: string;
  /** dernière cible demandée pendant la fenêtre de coalescence */
  pendingRefKey?: string;
  pausedWhileBuffering?: boolean;
  /** vrai si l'erreur a déjà déclenché la re-résolution automatique unique (§15.5) */
  autoResolvedOnce?: boolean;
  /** dernière erreur observée, exposée au message utilisateur */
  lastError?: string;
}

export interface PlayerTransition {
  state: PlayerState;
  context: PlayerContext;
  effects: PlayerEffect[];
}

/** Coalescence : une rafale de touches ne produit qu'une seule demande de flux (§4.6). */
export class ZapCoalescer {
  private timer: unknown = null;
  private pending: string | null = null;

  constructor(
    private readonly schedule: (fn: () => void, ms: number) => unknown,
    private readonly cancel: (handle: unknown) => void,
    private readonly windowMs: number = ZAP_COALESCE_MS
  ) {}

  /** Enregistre une nouvelle demande : les précédentes non expirées sont remplacées. */
  request(refKey: string, onFire: (refKey: string) => void): void {
    this.pending = refKey;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = this.schedule(() => {
      const target = this.pending;
      this.timer = null;
      this.pending = null;
      if (target !== null) onFire(target);
    }, this.windowMs);
  }

  get pendingRefKey(): string | null {
    return this.pending;
  }

  dispose(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.pending = null;
  }
}

export function initialPlayerState(): PlayerTransition {
  return { state: 'IDLE', context: {}, effects: [] };
}

/** Applique un événement et renvoie le nouvel état, le contexte et les effets à exécuter. */
export function applyPlayerEvent(
  state: PlayerState,
  context: PlayerContext,
  event: PlayerEvent
): PlayerTransition {
  switch (event.type) {
    case 'play': {
      if (state !== 'IDLE' && state !== 'ERROR' && state !== 'PAUSED') {
        return { state, context, effects: [] };
      }
      const next: PlayerContext = { refKey: event.refKey, autoResolvedOnce: false };
      return {
        state: 'PREPARING',
        context: next,
        effects: [{ type: 'resolve' }, { type: 'showMessage', detail: 'preparation' }, { type: 'hideOverlay' }]
      };
    }
    case 'sourceAssigned': {
      if (state !== 'PREPARING') return { state, context, effects: [] };
      return {
        state: 'BUFFERING',
        context,
        effects: [{ type: 'load' }, { type: 'play' }, { type: 'startNoFirstFrameTimer' }]
      };
    }
    case 'playing': {
      if (state !== 'BUFFERING' && state !== 'PAUSED') return { state, context, effects: [] };
      const next: PlayerContext = Object.assign({}, context, { autoResolvedOnce: false, lastError: undefined });
      if (state === 'PAUSED') return { state, context: next, effects: [{ type: 'clearTimers' }] };
      return { state: 'PLAYING', context: next, effects: [{ type: 'clearTimers' }, { type: 'report', detail: 'firstFrame' }] };
    }
    case 'pause': {
      if (state !== 'PLAYING' && state !== 'BUFFERING') return { state, context, effects: [] };
      if (state === 'BUFFERING') {
        return { state, context: Object.assign({}, context, { pausedWhileBuffering: true }), effects: [{ type: 'pause' }] };
      }
      return { state: 'PAUSED', context, effects: [{ type: 'pause' }] };
    }
    case 'waiting': {
      if (state !== 'PLAYING' && state !== 'BUFFERING') return { state, context, effects: [] };
      const effects: PlayerEffect[] = [];
      if (event.elapsedMs >= STALL_WARNING_MS) {
        effects.push({ type: 'showMessage', detail: 'flux interrompu ou tampon insuffisant' });
      }
      return { state: 'BUFFERING', context: Object.assign({}, context, { pausedWhileBuffering: false }), effects };
    }
    case 'noFirstFrameTimeout': {
      if (state !== 'BUFFERING') return { state, context, effects: [] };
      return failPlayer(context, 'player/timeout', 'aucune image apres le delai de demarrage');
    }
    case 'mediaError':
    case 'resolveFailed': {
      return failPlayer(context, event.type === 'mediaError' ? 'player/mediaError' : 'player/resolveFailed', event.detail);
    }
    case 'retry': {
      if (context.refKey === undefined) return { state: 'IDLE', context, effects: [] };
      const next: PlayerContext = Object.assign({}, context, { autoResolvedOnce: true, lastError: undefined });
      return {
        state: 'PREPARING',
        context: next,
        effects: [
          { type: 'clearTimers' },
          { type: 'clearSource' },
          { type: 'resolve' },
          { type: 'showMessage', detail: 'nouvelle tentative' }
        ]
      };
    }
    case 'stop': {
      if (state === 'IDLE') return { state, context, effects: [] };
      return {
        state: 'STOPPING',
        context,
        effects: [{ type: 'clearTimers' }, { type: 'pause' }, { type: 'clearSource' }, { type: 'load' }]
      };
    }
    case 'emptied': {
      if (state !== 'STOPPING') return { state, context, effects: [] };
      return { state: 'IDLE', context: {}, effects: [{ type: 'report', detail: 'stopped' }] };
    }
    case 'stopTimeout': {
      if (state !== 'STOPPING') return { state, context, effects: [] };
      // pas de décodeur résiduel supposé : on remonte l'anomalie au diagnostic plutôt que de mentir
      return { state: 'IDLE', context: {}, effects: [{ type: 'report', detail: 'stopTimeout' }] };
    }
  }
}

function failPlayer(context: PlayerContext, code: string, detail?: string): PlayerTransition {
  const next: PlayerContext = Object.assign({}, context, { lastError: code });
  return {
    state: 'ERROR',
    context: next,
    effects: [
      { type: 'clearTimers' },
      { type: 'showMessage', detail: detail ? detail : code }
    ]
  };
}

/**
 * Re-résolution automatique unique après `expiresAt` dépassé ou `403` : une seule tentative,
 * puis message avec Réessayer/Retour (§15.5).
 */
export function shouldAutoResolveOnce(context: PlayerContext, trigger: 'expired' | 'forbidden' | 'network'): boolean {
  if (context.autoResolvedOnce) return false;
  return trigger === 'expired' || trigger === 'forbidden' || trigger === 'network';
}

/* -------------------------------------------------------------------- import */

export const IMPORT_PHASES: ImportPhase[] = [
  'idle',
  'downloading',
  'parsing',
  'writing',
  'validating',
  'swapping',
  'done',
  'failed',
  'cancelled',
  'interrupted'
];

const ALLOWED_IMPORT_TRANSITIONS: Record<ImportPhase, ImportPhase[]> = {
  idle: ['downloading', 'failed', 'cancelled'],
  downloading: ['parsing', 'failed', 'cancelled', 'interrupted'],
  parsing: ['writing', 'failed', 'cancelled', 'interrupted'],
  writing: ['validating', 'failed', 'cancelled', 'interrupted'],
  validating: ['swapping', 'failed', 'cancelled', 'interrupted'],
  swapping: ['done', 'failed'],
  done: [],
  failed: ['downloading'],
  cancelled: ['downloading'],
  interrupted: ['downloading', 'cancelled']
};

export function createImportJob(input: {
  jobId: string;
  profileId: string;
  sourceType: ImportJob['sourceType'];
  tempIndexVersion: number;
  usesEmbeddedCredentials: boolean;
  now?: number;
}): ImportJob {
  const now = input.now === undefined ? Date.now() : input.now;
  return {
    jobId: input.jobId,
    profileId: input.profileId,
    sourceType: input.sourceType,
    phase: 'downloading',
    bytesRead: 0,
    entriesRead: 0,
    tempIndexVersion: input.tempIndexVersion,
    resumable: true,
    usesEmbeddedCredentials: input.usesEmbeddedCredentials,
    warnings: [],
    startedAt: now,
    updatedAt: now
  };
}

export interface ImportTransitionResult {
  job: ImportJob;
  /** vrai si la transition est acceptée ; sinon le job reste inchangé */
  accepted: boolean;
}

/**
 * Transition d'import. `swapping` est la **seule** phase qui change la version élue, et elle est
 * atomique côté écrivain (`rename` + manifeste, §2.4) : un échec avant `swapping` laisse l'index
 * validé intact.
 */
export function transitionImport(
  job: ImportJob,
  nextPoints: Partial<ImportJob> & { phase: ImportPhase },
  now: number = Date.now()
): ImportTransitionResult {
  const allowed = ALLOWED_IMPORT_TRANSITIONS[job.phase] || [];
  if (allowed.indexOf(nextPoints.phase) === -1) {
    return { job, accepted: false };
  }
  const updated: ImportJob = Object.assign({}, job, nextPoints, { updatedAt: now });
  if (nextPoints.warnings) {
    // les avertissements ne portent jamais d'URL ni de secret
    updated.warnings = nextPoints.warnings.map((w) => AppError.sanitize(w));
  }
  return { job: updated, accepted: true };
}

/** Reprise après mort du service (§15.5) : le job reste `interrupted` et repart de `resumeHint`. */
export function resumeImportJob(job: ImportJob, now: number = Date.now()): ImportTransitionResult {
  if (job.phase !== 'interrupted' && job.phase !== 'failed' && job.phase !== 'cancelled') {
    return { job, accepted: false };
  }
  if (!job.resumable) return { job, accepted: false };
  return {
    job: Object.assign({}, job, { phase: 'downloading', updatedAt: now }),
    accepted: true
  };
}

/** Un job `interrupted` depuis plus de 7 jours est proposé à la suppression au démarrage. */
export const INTERRUPTED_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function shouldOfferCleanup(job: ImportJob, now: number = Date.now()): boolean {
  if (job.phase !== 'interrupted') return false;
  return now - job.updatedAt > INTERRUPTED_JOB_TTL_MS;
}

/**
 * Progression de l'import : la phase est persistée en DB8 **à chaque lot** (§15.5), pas seulement
 * à la fin. `checkpoint` matérialise cette écriture.
 */
export function checkpointImport(
  job: ImportJob,
  progress: { bytesRead: number; entriesRead: number; currentCategory?: string; resumeHint?: ImportJob['resumeHint'] },
  now: number = Date.now()
): ImportJob {
  const updated: ImportJob = Object.assign({}, job, {
    bytesRead: Math.max(job.bytesRead, progress.bytesRead),
    entriesRead: Math.max(job.entriesRead, progress.entriesRead),
    updatedAt: now
  });
  if (progress.currentCategory !== undefined) updated.currentCategory = progress.currentCategory;
  if (progress.resumeHint !== undefined) updated.resumeHint = progress.resumeHint;
  return updated;
}
