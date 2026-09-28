'use strict';

/**
 * Pont LS2 de l'application — **implémentation propre, sans dépendance et sans fichier externe**.
 *
 * Pourquoi ce fichier existe : la page chargeait `webOSTV.js`, la bibliothèque fournie par le SDK LG.
 * Ce fichier n'était pas empaqueté, la console de la TV répondait
 * `Failed to load resource: net::ERR_FILE_NOT_FOUND webOSTV.js` et `window.webOS` restait absent —
 * donc plus aucun appel LS2 possible depuis l'application. Plutôt que de dépendre d'un fichier à
 * copier depuis le SDK, le dépôt fournit ici le sous-ensemble réellement utilisé, construit sur le
 * pont bas niveau `PalmServiceBridge` que la plateforme webOS fournit à toute application web.
 *
 * Ce que ce fichier expose (mêmes signatures que la bibliothèque LG, sous-ensemble documenté) :
 *   - `webOS.service.request(uri, options)` → renvoie un objet avec `cancel()` ;
 *     `options` : `method`, `parameters`, `subscribe`, `onSuccess`, `onFailure`, `onComplete` ;
 *   - `webOS.deviceInfo(callback)` → informations d'appareil (lues par LS2, sinon vides) ;
 *   - `webOS.platformBack()` → touche retour de la télécommande ;
 *   - `webOS.__pont` → diagnostic : quel chemin est utilisé (`webos-service`, `PalmServiceBridge`
 *     ou `aucun`). Une page de test s'en sert pour afficher l'état réel sur la TV.
 *
 * Si la plateforme fournit déjà `webOS.service.request` (TV récentes ou `webOSTV.js` chargée par
 * ailleurs), **rien n'est écrasé** : le fichier se contente de compléter ce qui manque.
 */

(function (global) {
  var racine = global || (typeof self !== 'undefined' ? self : this);
  var webOS = racine.webOS || (racine.webOS = {});
  var service = webOS.service || (webOS.service = {});
  var pontBasNiveau = typeof racine.PalmServiceBridge === 'function' ? racine.PalmServiceBridge : null;
  var dejaFourni = typeof service.request === 'function';
  var chemin = dejaFourni ? 'webos-service' : pontBasNiveau ? 'PalmServiceBridge' : 'aucun';

  function erreur(texte, code) {
    var e = new Error(texte);
    e.code = code || 'bridge/unavailable';
    return e;
  }

  /** Enveloppe d'un appel : `uri` = `luna://service`, `method` = commande. */
  function cible(uri, method) {
    if (!method) return uri;
    return uri.charAt(uri.length - 1) === '/' ? uri + method : uri + '/' + method;
  }

  function enveloppe(parameters, subscribe) {
    var charge = {};
    var source = parameters || {};
    Object.keys(source).forEach(function (cle) {
      charge[cle] = source[cle];
    });
    if (subscribe) charge.subscribe = true;
    return JSON.stringify(charge);
  }

  if (!dejaFourni) {
    service.request = function (uri, options) {
      options = options || {};
      if (!pontBasNiveau) {
        var indisponible = erreur(
          'aucun pont LS2 disponible : cette page doit s’exécuter sur la TV (ou le simulateur LG)',
          'bridge/unavailable'
        );
        if (options.onFailure) {
          setTimeout(function () {
            options.onFailure({ returnValue: false, errorCode: -1, errorText: indisponible.message });
            if (options.onComplete) options.onComplete({ returnValue: false, errorText: indisponible.message });
          }, 0);
        } else {
          throw indisponible;
        }
        return { cancel: function () {} };
      }
      var pont = new pontBasNiveau();
      var termine = false;
      var souscription = options.subscribe === true;
      pont.onservicecallback = function (texte) {
        var reponse;
        try {
          reponse = JSON.parse(texte);
        } catch (illisible) {
          if (options.onFailure) options.onFailure({ returnValue: false, errorText: 'réponse LS2 illisible' });
          return;
        }
        if (!souscription) termine = true;
        try {
          if (reponse && reponse.returnValue === false) {
            if (options.onFailure) options.onFailure(reponse);
          } else if (options.onSuccess) {
            options.onSuccess(reponse);
          }
        } finally {
          if (options.onComplete) options.onComplete(reponse);
        }
      };
      pont.call(cible(uri, options.method), enveloppe(options.parameters, souscription));
      return {
        cancel: function () {
          termine = true;
          if (typeof pont.cancel === 'function') pont.cancel();
        },
        get termine() {
          return termine;
        }
      };
    };
  }

  if (typeof service.deviceInfo !== 'function') {
    service.deviceInfo = function (callback) {
      var renseigner = typeof callback === 'function' ? callback : function () {};
      if (pontBasNiveau || typeof service.request === 'function') {
        service.request('luna://com.webos.service.tv.systemproperty', {
          method: 'getSystemInfo',
          parameters: { keys: ['modelName', 'sdkVersion', 'firmwareVersion', 'boardType', 'UHD'] },
          onSuccess: function (reponse) {
            renseigner(reponse || {});
          },
          onFailure: function () {
            renseigner({});
          }
        });
        return;
      }
      renseigner({});
    };
  }

  if (typeof webOS.platformBack !== 'function') {
    webOS.platformBack = function () {
      if (racine.PalmSystem && typeof racine.PalmSystem.platformBack === 'function') {
        racine.PalmSystem.platformBack();
      }
    };
  }

  webOS.__pont = {
    chemin: chemin,
    palmServiceBridge: Boolean(pontBasNiveau),
    palmSystem: Boolean(racine.PalmSystem),
    fourniParLaPlateforme: dejaFourni
  };
})(typeof window !== 'undefined' ? window : this);
