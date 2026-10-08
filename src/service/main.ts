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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
 *
 * **Enveloppe** : le callback reçoit un objet `Message`, dont la réponse est dans `payload`
 * (`webos-service` : `Message.prototype.payload = JSON.parse(message.payload())`, et le service
 * appelé répond par `message.respond(payload)`). Lire `message.returnValue` — la forme « plate » —
 * rendait la réponse **vide** : les identifiants d'écriture disparaissaient, les lectures passaient
 * pour vides (« clé maître absente », D-40) et un `putKind` réussi passait pour refusé (D-41).
 * Les deux formes sont acceptées : l'une comme l'autre est vérifiée par les tests.
 */
export function createLs2Caller(service: WebosServiceLike): Ls2Caller {
  return (uri: string, params: Record<string, unknown>) =>
    new Promise<{ returnValue?: boolean } & Record<string, unknown>>((resolve, reject) => {
      service.call(uri, params, (message) => {
        const enveloppe = (message || {}) as Record<string, unknown>;
        const charge =
          enveloppe.payload && typeof enveloppe.payload === 'object'
            ? (enveloppe.payload as Record<string, unknown>)
            : enveloppe;
        if (!message || charge.returnValue === false) {
          const code = charge.errorCode !== undefined ? String(charge.errorCode) : 'inconnu';
          // Le message brut du bus est conservé : sans lui, un échec de base (DB8 absent, ACG
          // refusée) se traduisait par un simple « appel LS2 refuse (-1) », inexploitable à distance.
          const brut = charge.errorText ? sanitize(String(charge.errorText)) : '';
          reject(
            new AppError(
              'internal/unexpected',
              'appel LS2 refuse (' + code + ')' + (brut ? ' : ' + brut : ''),
              uri.replace(/\/\/[^/]+/, '//' + hostLabel(uri))
            )
          );
          return;
        }
        resolve(charge);
      });
    });
}

/** Étiquette d'URI pour un message d'erreur : `luna://<service>/<commande>`, sans identifiant. */
function hostLabel(uri: string): string {
  const correspondance = /^luna:\/\/([^/]+)\/(.+)$/.exec(uri);
  return correspondance ? correspondance[1] + '/' + correspondance[2] : 'service';
}

/**
 * Répertoire de travail du service : `/media/internal/...` sur le téléviseur (§2.4), et un repli
 * explicite si ce chemin n'est pas inscriptible — cas du **simulateur** et du poste de développement,
 * où `/media/internal` n'existe pas. Sans ce repli, l'import et l'index échouent avec « répertoire
 * indisponible » alors que le service, lui, répond : le diagnostic doit distinguer les deux.
 */
export function resolveStorageRoot(preferred?: string): { storageRoot: string; repli: boolean } {
  const candidat = preferred && preferred !== '' ? preferred : DEFAULT_STORAGE_ROOT;
  try {
    mkdirRecursive(candidat);
    if (fs.existsSync(candidat)) return { storageRoot: candidat, repli: false };
  } catch (_error) {
    // chemin absent et non créable (simulateur, poste de développement) : repli ci-dessous
  }
  const secours = path.join(os.tmpdir(), 'iptv-webos-' + APP_ID);
  mkdirRecursive(secours);
  return { storageRoot: secours, repli: true };
}

/** Construit le service complet à partir d'une instance LS2 déjà créée (testable sans TV). */
export function createService(service: WebosServiceLike, options?: { storageRoot?: string }): IptvService {
  const call = createLs2Caller(service);
  const db = new Db8Client({ call: call, appId: APP_ID });
  const http = new HttpClient();
  return new IptvService({
    db: db,
    http: http,
    storageRoot: (options && options.storageRoot) || DEFAULT_STORAGE_ROOT,
    onLog: log
  });
}

/** Démarrage : enregistre les commandes *avant* toute autre chose, puis fait l'entretien. */
export function start(service: WebosServiceLike, options?: { storageRoot?: string }): IptvService {
  // Le répertoire est résolu **avant** l'enregistrement, mais son échec éventuel ne l'empêche jamais :
  // un service qui ne s'enregistre pas est un service que le hub ne connaît pas (« Service does not
  // exist »), alors qu'un service qui répond « répertoire indisponible » reste diagnosticable.
  const stockage = resolveStorageRoot(options && options.storageRoot);
  if (stockage.repli) {
    log('repertoire ' + DEFAULT_STORAGE_ROOT + ' indisponible : repli sur ' + stockage.storageRoot);
  }
  const iptv = createService(service, { storageRoot: stockage.storageRoot });
  iptv.register(createBusForService(service));
  log('service demarre : ' + SERVICE_NAME + ' (node ' + process.version + ')');

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

export interface BootstrapOptions {
  storageRoot?: string;
  /** injection de test : remplace `require('webos-service')` (jamais utilisé sur la TV) */
  serviceFactory?: () => WebosServiceLike;
  /** journal des lignes de démarrage (tests) */
  onLog?: (line: string) => void;
}

/**
 * Démarre le service sur une instance LS2.
 *
 * **Ce n'est pas conditionné par `require.main === module`** : la plateforme peut charger le fichier
 * `main` par `require()`, au cas où `require.main` désigne son propre chargeur et non ce module —
 * le service ne s'enregistrerait alors jamais et le hub répondrait « Service does not exist »
 * (constaté en phase 0A). L'appel se fait depuis `index.js`, point d'entrée du paquet.
 */
export function bootstrap(options?: BootstrapOptions): IptvService | null {
  const journal = options && options.onLog ? options.onLog : log;
  try {
    const factory =
      options && options.serviceFactory
        ? options.serviceFactory
        : () => {
            const Service = require('webos-service') as { new (name: string): WebosServiceLike };
            return new Service(SERVICE_NAME);
          };
    const raw = factory();

    // Une exception non rattrapée ne doit pas tuer le service : la réponse en cours a déjà reçu son
    // erreur typée par l'enveloppe LS2, et l'état utile vit dans DB8 et sur disque.
    process.on('uncaughtException', (error: Error) => {
      journal('exception non rattrapee : ' + error.message);
    });
    process.on('unhandledRejection', (reason: unknown) => {
      journal('promesse rejetee non rattrapee : ' + describe(reason));
    });
    process.on('SIGTERM', () => {
      // Arrêt demandé par la plateforme : l'état est déjà persistant, rien à sauver en urgence.
      journal('arret demande par la plateforme');
    });

    return start(raw, options);
  } catch (error) {
    journal('demarrage impossible : ' + describe(error));
    return null;
  }
}
