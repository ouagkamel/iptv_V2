/**
 * Bus LS2 du service (§15.4) — la seule dépendance côté plateforme, isolée derrière une interface.
 *
 * Le module `webos-service` n'existe que **sur la TV** : il est chargé paresseusement, et tout le
 * reste du service (commandes, index, réseau) reste exécutable et testable sans lui. Le faux bus
 * `createFakeBus()` reproduit la sémantique des abonnements (réponses multiples, dernier message
 * marqué `final`) pour permettre les tests des notifications de progression d'import.
 */

import { AppError } from '../../contracts/errors';

export interface SubscribeHandle {
  /** identifiant de la souscription, pour la remplacer (une seule par profil, §15.4) */
  id: string;
  profileId?: string;
}

export interface BusContext {
  /** vrai si l'appelant s'est abonné : la réponse peut être envoyée plusieurs fois */
  subscribed: boolean;
  index: number;
  /** annulation par l'appelant (l'application se ferme, change d'écran) */
  cancelled: () => boolean;
}

export type BusRespond = (reply: unknown) => void;
export type BusHandler = (
  payload: Record<string, unknown>,
  respond: BusRespond,
  context: BusContext
) => void | Promise<void>;

export interface ServiceBus {
  register(command: string, handler: BusHandler): void;
}

/** Sous-ensemble de `webos-service` réellement utilisé : la dépendance plateforme est minimale. */
export interface WebosMessageLike {
  payload?: unknown;
  isSubscription?: boolean;
  respond: (reply: unknown) => void;
}

/**
 * Réponse d'un `service.call` : `webos-service` remet un **objet `Message`**, dont la charge utile
 * est dans `payload` (référence LG : `message.respond(payload)` pour le service appelé, exemple
 * `message.payload.name` pour l'appelant). Les champs de la réponse (`returnValue`, `errorCode`,
 * `errorText`, `results`…) ne sont **pas** au premier niveau.
 */
export type WebosCallReponse = { payload?: Record<string, unknown> } & Record<string, unknown>;

export interface WebosServiceLike {
  register(command: string, handler: (message: WebosMessageLike) => void): void;
  call(uri: string, params: Record<string, unknown>, callback: (message: WebosCallReponse) => void): unknown;
}

/** Adapte une instance `webos-service` existante (le service n'en crée qu'une). */
export function createBusForService(service: WebosServiceLike): ServiceBus {
  return {
    register(command: string, handler: BusHandler): void {
      service.register(command, (message: WebosMessageLike) => {
        const payload = (message.payload || {}) as Record<string, unknown>;
        let replies = 0;
        const respond: BusRespond = (reply) => {
          replies += 1;
          message.respond(reply);
        };
        try {
          const outcome = handler(payload, respond, {
            subscribed: message.isSubscription === true,
            index: replies,
            cancelled: () => message.isSubscription === true && (message as unknown as { cancelled?: boolean }).cancelled === true
          });
          if (outcome && typeof outcome.then === 'function') {
            outcome.then(undefined, (error: unknown) => {
              const text = error instanceof Error ? error.message : 'erreur interne du service';
              respond({ returnValue: false, error: { code: 'internal/unexpected', retryable: true, message: text } });
            });
          }
        } catch (error) {
          const text = error instanceof Error ? error.message : 'erreur interne du service';
          respond({ returnValue: false, error: { code: 'internal/unexpected', retryable: true, message: text } });
        }
      });
    }
  };
}

/**
 * Bus réel : `webos-service`. Le nom du service commence par l'ID de l'application (§2.6) ; aucune
 * commande n'est publique, aucune socket n'est ouverte, aucun keep-alive n'est installé.
 */
export function createWebosServiceBus(serviceName: string): ServiceBus {
  const Service = require('webos-service') as { new (name: string): WebosServiceLike };
  return createBusForService(new Service(serviceName));
}

export interface FakeBus extends ServiceBus {
  handlers: Record<string, BusHandler>;
  /** Toutes les réponses reçues, dans l'ordre, y compris celles d'un abonnement. */
  readonly log: Array<{ command: string; reply: unknown }>;
  /** Invocation en attente : la promesse est résolue quand le gestionnaire a fini de répondre. */
  invoke(command: string, payload: Record<string, unknown>, options?: { subscribed?: boolean }): Promise<unknown[]>;
  /** Attente d'une condition observée sur les réponses (progression d'abonnement). */
  waitUntil(predicate: (log: Array<{ command: string; reply: unknown }>) => boolean, timeoutMs?: number): Promise<void>;
}

/** Faux bus en mémoire : abonnements (réponses multiples) et annulation compris. */
export function createFakeBus(): FakeBus {
  const handlers: Record<string, BusHandler> = {};
  const log: Array<{ command: string; reply: unknown }> = [];
  const bus: FakeBus = {
    handlers: handlers,
    log: log,
    register(command, handler) {
      handlers[command] = handler;
    },
    async invoke(command, payload, options) {
      const handler = handlers[command];
      if (!handler) throw new AppError('internal/unexpected', 'commande non enregistree : ' + command);
      const replies: unknown[] = [];
      let cancelled = false;
      const outcome = handler(payload, (reply) => {
        replies.push(reply);
        log.push({ command: command, reply: reply });
      }, {
        subscribed: Boolean(options && options.subscribed),
        index: replies.length,
        cancelled: () => cancelled
      });
      if (outcome && typeof outcome.then === 'function') await outcome;
      return replies;
    },
    waitUntil(predicate, timeoutMs) {
      const deadline = Date.now() + (timeoutMs === undefined ? 4000 : timeoutMs);
      return new Promise<void>((resolve, reject) => {
        const tick = (): void => {
          if (predicate(log)) {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            reject(new AppError('internal/unexpected', 'condition non atteinte dans le delai du test'));
            return;
          }
          setTimeout(tick, 2);
        };
        tick();
      });
    }
  };
  return bus;
}
