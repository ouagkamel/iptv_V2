'use strict';

/* eslint-disable no-var -- fichier ES5 volontaire : charge tel quel par la page de diagnostic, sans transpilation */
/* global self -- `self` est la racine de navigation du navigateur et du worker (jamais `window` seul) */

/**
 * Mise en texte des réponses et des erreurs LS2 pour la page de diagnostic.
 *
 * Pourquoi ce fichier existe : la page affichait `[object Object]` dès qu'une commande échouait. Deux
 * formes d'erreur coexistent en effet sur le bus :
 *   - une erreur **du bus** : `{ returnValue: false, errorCode: -1, errorText: "Service does not exist …" }` ;
 *   - une erreur **du service** : `{ returnValue: false, error: { code, message, retryable, hint? } }`
 *     (l'enveloppe du §15.4) ;
 * et une exception JavaScript côté page (`Error`). Le texte utile doit sortir dans les trois cas, avec
 * le code et l'indication de reprise — jamais « [object Object] ».
 *
 * Le module est utilisable tel quel dans la page (`window.iptvFormat`) et sous Node pour les tests
 * (`module.exports`), sans dépendance : c'est ce qui permet de le couvrir par un test.
 */

(function (racine) {
  function estObjet(valeur) {
    return valeur !== null && typeof valeur === 'object';
  }

  /** Texte lisible d'une erreur LS2, quelle que soit sa forme. Jamais « [object Object] ». */
  function texteErreur(valeur) {
    if (valeur === undefined || valeur === null) return 'erreur inconnue (reponse vide)';
    if (typeof valeur === 'string') return valeur;
    if (valeur instanceof Error) return valeur.message || String(valeur);
    if (!estObjet(valeur)) return String(valeur);

    // 1) enveloppe du service (§15.4) : { returnValue:false, error:{ code, message, retryable, hint } }
    if (estObjet(valeur.error)) {
      var detail = valeur.error;
      var texte = (detail.code ? detail.code + ' — ' : '') + (detail.message || 'erreur sans message');
      if (detail.hint) texte += ' (' + detail.hint + ')';
      if (detail.retryable === true) texte += ' [reessayable]';
      return texte;
    }
    // 2) erreur du bus LS2 : { errorCode, errorText }
    if (valeur.errorText) {
      return valeur.errorCode !== undefined && valeur.errorCode !== 0 ? valeur.errorText + ' (code ' + valeur.errorCode + ')' : String(valeur.errorText);
    }
    // 3) forme inattendue : on montre le contenu plutôt que l'objet
    try {
      return JSON.stringify(valeur);
    } catch (_erreur) {
      return 'erreur illisible';
    }
  }

  /** Résumé d'une réponse du service : statut, `indexVersion`, puis charge utile en JSON. */
  function texteReponse(reponse) {
    if (!estObjet(reponse)) return String(reponse);
    var lignes = [];
    lignes.push('returnValue : ' + (reponse.returnValue === true ? 'true' : 'false'));
    if (reponse.indexVersion !== undefined) lignes.push('indexVersion : ' + reponse.indexVersion);
    if (reponse.returnValue === false) {
      lignes.push('erreur : ' + texteErreur(reponse));
    }
    if (reponse.data !== undefined) {
      lignes.push('data :');
      lignes.push(JSON.stringify(reponse.data, null, 2));
    }
    return lignes.join('\n');
  }

  /**
   * Une réponse (verdict de `testProfile` ou erreur de commande) demande-t-elle l'autorisation
   * « HTTP clair » ? Renvoie l'hôte à confirmer, ou `null`.
   *
   * Le service répond `security/insecureScheme` avec `hint: 'hote:<hôte>'` — c'est ce `hint` qui
   * permet à la page de proposer la confirmation en un clic au lieu d'afficher un code obscur
   * (l'utilisateur voyait `security/insecurescheme` sans savoir quoi en faire, en phase 0A).
   */
  function hoteACOnfirmer(reponse) {
    var listes = [];
    if (estObjet(reponse)) {
      if (estObjet(reponse.error)) listes.push(reponse.error);
      if (estObjet(reponse.data) && Array.isArray(reponse.data.errors)) listes = listes.concat(reponse.data.errors);
    }
    for (var index = 0; index < listes.length; index += 1) {
      var entree = listes[index];
      if (!entree || String(entree.code || '').toLowerCase() !== 'security/insecurescheme') continue;
      var correspondance = /hote:([^\s]+)/i.exec(String(entree.hint || ''));
      if (correspondance) return correspondance[1];
      var dansMessage = /hote:([^\s]+)/i.exec(String(entree.message || ''));
      if (dansMessage) return dansMessage[1];
      return '';
    }
    return null;
  }

  /**
   * Champs de formulaire correspondant à une **source préconfigurée** (`profils.js`).
   *
   * Fonction pure, testable sous Node : c'est elle qui décide ce que la page remplit quand
   * l'utilisateur choisit une source dans la liste (et si l'autorisation « HTTP clair » doit être
   * pré-cochée parce que l'adresse est en `http://`).
   */
  function champsDepuisSource(source) {
    if (!estObjet(source)) return null;
    var url = String(source.url || '');
    var nom = String(source.nom || url || 'source');
    var suffixe = ' — ' + nom;
    return {
      profileId: String(source.id || ''),
      url: url,
      username: String(source.username || ''),
      password: String(source.password || ''),
      autoriserHttp: url.indexOf('http://') === 0,
      nom: nom,
      // libellé de chaque champ, pour que la provenance soit lisible à l'écran
      etiquettes: {
        profil: 'Identifiant de profil' + suffixe,
        url: 'Adresse du portail' + suffixe,
        utilisateur: "Nom d'utilisateur" + suffixe,
        motdepasse: 'Mot de passe' + suffixe
      }
    };
  }

  var api = {
    texteErreur: texteErreur,
    texteReponse: texteReponse,
    hoteACOnfirmer: hoteACOnfirmer,
    champsDepuisSource: champsDepuisSource
  };

  if (racine) {
    racine.iptvFormat = api;
    if (typeof racine.window !== 'undefined') racine.window.iptvFormat = api;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : this);
