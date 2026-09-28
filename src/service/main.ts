/**
 * Point d'entrée du service JS webOS (cible Node 8.12 / ES2017) — `main` du `package.json` du
 * service.
 *
 * Ce fichier est le **seul** endroit qui parle à la plateforme :
 *  - il instancie le service LS2 (`webos-service`) ;
 *  - il construit le client DB8 (même instance LS2, un seul bus) et le client HTTPS ;
 *  - il enregistre les onze commandes non publiques (§2.6, §15.4) ;
 *  - il exécute l'entretien de démarrage (fichiers temporaires, jobs abandonnés) **sans bloquer**
 *    l'usage : un échec d'entretien n'empêche jamais de répondre.
 *
 * Ce qu'il ne fait **jamais** : ouvrir une écoute réseau, installer un minuteur de maintien en vie
 * ou un travail en arrière-plan. LG arrête un service sans activité LS2 ; toute référence utile
 * (profils, favoris, `ImportJob`) est rechargée depuis DB8 ou depuis les fichiers du répertoire
 * privé à la demande (§2.4, §15.5).
 */

import { AppError } from '../contracts/errors';
import { Db8Client, type Ls2Caller } from './db8/client';
import { HttpClient } from './http/httpClient';
import { mkdirRecursive } from './store/fsutil';
import { createBusForService, type WebosServiceLike } from './ls2/bus';
import { DEFAULT_STORAGE_ROOT, IptvService, SERVICE_NAME } from './ls2/service';

const APP_ID = 'com.ouagkamel.app.iptvplayer';

/** Journal local : jamais d'URL, jamais de secret, jamais de contenu de catalogue (§9.2). */
function log(line: string): void {
  console.log('[iptv] ' + sanitize(line));
}

const SECRET_PATTERNS: RegExp[] = [
  /\/\/[^/@\s]*:[^/@\s]*@/g,
  /([?&](?:username|password|token|token2|user|pass|api_?key|auth|key)=)[^&\s]*/gi
];

export function sanitize(line: string): string {
  let out = line;
  SECRET_PATTERNS.forEach((pattern) => {
    out = out.replace(pattern, (match, prefix) => (prefix ? prefix + '***' : '//***@'));
  });
  return out;
}

/**
 * Pont LS2 : `webos-service` utilise des callbacks. Une seule promesse par appel, rejetée si la
 * plateforme répond `returnValue: false` — la couche DB8 reçoit alors une erreur typée.
 */
export function createLs2Caller(service: WebosServiceLike): Ls2Caller {
  return (uri: string, params: Record<string, unknown>) =>
    new Promise<{ returnValue?: boolean } & Record<string, unknown>>((resolve, reject) => {
      service.call(uri, params, (message) => {
        if (!message || message.returnValue === false) {
          const code = message && message.errorCode !== undefined ? String(message.errorCode) : 'inconnu';
          reject(new AppError('internal/unexpected', 'appel LS2 refuse (' + code + ')'));
          return;
        }
        resolve(message);
      });
    });
}

/** Construit le service complet à partir d'une instance LS2 déjà créée (testable sans TV). */
export function createService(service: WebosServiceLike, options?: { storageRoot?: string }): IptvService {
  const call = createLs2Caller(service);
  const db = new Db8Client({ call: call, appId: APP_ID });
  const http = new HttpClient();
  return new IptvService({
    db: db,
    http: http,
    storageRoot: options && options.storageRoot ? options.storageRoot : DEFAULT_STORAGE_ROOT,
    onLog: log
  });
}

/** Démarrage : enregistre les commandes *avant* toute autre chose, puis fait l'entretien. */
export function start(service: WebosServiceLike, options?: { storageRoot?: string }): IptvService {
  const iptv = createService(service, options);
  iptv.register(createBusForService(service));
  log('service demarre : ' + SERVICE_NAME + ' (node ' + process.version + ')');

  try {
    mkdirRecursive(options && options.storageRoot ? options.storageRoot : DEFAULT_STORAGE_ROOT);
  } catch (error) {
    log('repertoire prive indisponible : ' + describe(error));
  }

  // Entretien best-effort : l'usage normal n'attend pas le résultat.
  iptv
    .startupMaintenance()
    .then((result) => {
      log(
        'entretien : ' +
          String(result.prunedFiles.length) +
          ' fichier(s) temporaire(s) purge(s), ' +
          String(result.staleJobs.length) +
          ' import(s) abandonne(s) a proposer a la suppression'
      );
    })
    .catch((error) => {
      log('entretien interrompu : ' + describe(error));
    });

  return iptv;
}

function describe(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (error instanceof Error) return error.message;
  return 'erreur inconnue';
}

/** Amorce réelle : hors TV (tests, outillage), ce bloc ne s'exécute pas. */
if (require.main === module) {
  try {
    const Service = require('webos-service') as { new (name: string): WebosServiceLike };
    const raw = new Service(SERVICE_NAME);

    // Une exception non rattrapée ne doit pas tuer le service : la réponse en cours a déjà reçu son
    // erreur typée par l'enveloppe LS2, et l'état utile vit dans DB8 et sur disque.
    process.on('uncaughtException', (error: Error) => {
      log('exception non rattrapee : ' + error.message);
    });
    process.on('unhandledRejection', (reason: unknown) => {
      log('promesse rejetee non rattrapee : ' + describe(reason));
    });
    process.on('SIGTERM', () => {
      // Arrêt demandé par la plateforme : l'état est déjà persistant, rien à sauver en urgence.
      log('arret demande par la plateforme');
    });

    start(raw);
  } catch (error) {
    log('demarrage impossible : ' + describe(error));
  }
}
