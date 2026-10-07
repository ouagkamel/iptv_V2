'use strict';

/**
 * Client LS2 de l'interface (V1-A) — **module pur**, sans React, testable sous Node.
 *
 * Il enveloppe le pont de la plateforme (`webOS.service.request`, fourni par `webos-bridge.js` sur
 * la TV) en promesses, car les écrans Enact travaillent avec `await`. Les mêmes règles que la page
 * de diagnostic s'appliquent : jamais de « [object Object] », toujours le code d'erreur du service
 * (§15.4) ou le message brut du bus.
 *
 *   request('luna://com.ouagkamel.app.iptvplayer.service', 'getCategories', {...})
 *     → Promise<réponse LS2>
 *   abonnement(uri, 'importPlaylist', {...}) → { fait: Promise, annuler() }
 */

let SERVICE = 'com.ouagkamel.app.iptvplayer.service';
let URI = 'luna://' + SERVICE;

/** Vrai si un pont LS2 utilisable est présent (TV ou simulateur). */
function disponible() {
  return Boolean(
    typeof window !== 'undefined' &&
      window.webOS &&
      window.webOS.service &&
      typeof window.webOS.service.request === 'function'
  );
}

/** Chemin réellement utilisé par le pont — affiché par le diagnostic local (§0A). */
function chemin() {
  if (typeof window === 'undefined') return 'aucun';
  let pont = window.webOS && window.webOS.__pont;
  return (pont && pont.chemin) || (disponible() ? 'webos-service' : 'aucun');
}

/**
 * Un appel. La réponse du service est rendue **telle quelle** : c'est l'enveloppe du §15.4, et les
 * écrans lisent `returnValue`, `data` et `error` eux-mêmes — un client qui « simplifie » masquerait
 * la cause d'un échec.
 */
function request(uri, method, parametres, options) {
  options = options || {};
  return new Promise(function (resolve, reject) {
    if (!disponible()) {
      reject(erreurPont());
      return;
    }
    window.webOS.service.request(uri, {
      method: method,
      parameters: parametres || {},
      subscribe: options.subscribe === true,
      onSuccess: function (reponse) {
        resolve(reponse || {});
      },
      onFailure: function (reponse) {
        // le bus répond `{returnValue:false, errorCode, errorText}` : on le rend au lieu de lever
        resolve(reponse || { returnValue: false, errorText: 'echec sans reponse du bus' });
      },
      onComplete: options.onComplete
    });
  });
}

/** Appel d'une commande du service de l'application. */
function commande(method, parametres, options) {
  return request(URI, method, parametres, options);
}

/**
 * Abonnement à une commande qui publie plusieurs réponses (`importPlaylist`, §15.4).
 * Renvoie `{ fait, annuler }` : `fait` se résout dès la **première** réponse et les suivantes
 * arrivent par `aChaqueReponse`. La souscription est annulée sur demande ou à la réponse finale.
 */
function abonnement(method, parametres, aChaqueReponse) {
  let annuler = null;
  let termine = false;
  let fait = new Promise(function (resolve, reject) {
    if (!disponible()) {
      reject(erreurPont());
      return;
    }
    annuler = window.webOS.service.request(URI, {
      method: method,
      parameters: parametres || {},
      subscribe: true,
      onSuccess: function (reponse) {
        reponse = reponse || {};
        if (aChaqueReponse) {
          try {
            aChaqueReponse(reponse);
          } catch (_erreur) {
            /* un écran qui se trompe ne doit pas casser le flux de réponses */
          }
        }
        if (!termine) {
          termine = true;
          resolve(reponse);
        }
      },
      onFailure: function (reponse) {
        if (!termine) {
          termine = true;
          resolve(reponse || { returnValue: false, errorText: 'echec sans reponse du bus' });
        }
      }
    });
  });
  return {
    fait: fait,
    annuler: function () {
      termine = true;
      if (annuler && typeof annuler.cancel === 'function') annuler.cancel();
    }
  };
}

function erreurPont() {
  let e = new Error(
    'aucun pont LS2 : cette application doit s’exécuter sur la TV ou le simulateur (le service ' +
      '« ' +
      SERVICE +
      ' » doit y être ajouté puis démarré)'
  );
  e.code = 'bridge/unavailable';
  return e;
}

module.exports = {
  SERVICE: SERVICE,
  URI: URI,
  disponible: disponible,
  chemin: chemin,
  request: request,
  commande: commande,
  abonnement: abonnement
};
