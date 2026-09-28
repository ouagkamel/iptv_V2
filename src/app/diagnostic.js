'use strict';

/**
 * Coquille de diagnostic de la phase 0A — **page de test**, pas l'interface du produit.
 *
 * Elle n'utilise que les API webOS présentes sur la TV (`webOS.service.request`, `webOS.deviceInfo`)
 * et les onze commandes du service. Son but : prouver sur un téléviseur réel que le service est
 * joignable en LS2, que ses commandes non publiques répondent, que DB8 est accessible avec les
 * bonnes permissions et que le répertoire privé du service est inscriptible.
 *
 * Ce qu'elle ne fait pas : aucune URL de flux persistée, aucun identifiant journalisé, aucun appel
 * direct au réseau (tout passe par le service). L'interface Enact de V1-A remplacera cette page.
 */

var SERVICE = 'luna://com.ouagkamel.app.iptvplayer.service';
var derniereJobId = null;

function el(id) {
  return document.getElementById(id);
}

function journal(message, nature) {
  var ligne = document.createElement('div');
  ligne.className = 'ligne' + (nature ? ' ' + nature : '');
  var heure = new Date().toISOString().slice(11, 19);
  ligne.textContent = heure + '  ' + message;
  var zone = el('journal');
  zone.appendChild(ligne);
  zone.scrollTop = zone.scrollHeight;
}

/** Masque les secrets avant affichage : la page ne montre jamais une URL complète par défaut. */
function assainir(valeur) {
  var texte = typeof valeur === 'string' ? valeur : JSON.stringify(valeur, null, 2);
  if (el('afficherurl').checked) return texte;
  return texte
    .replace(/(https?:\/\/)[^\s"']*:[^\s"']*@/g, '$1***:***@')
    .replace(/([?&](?:username|password|token|user|pass)=)[^&\s"']*/gi, '$1***');
}

function afficher(titre, charge) {
  var texte = assainir(charge);
  el('sortie').textContent = '// ' + titre + '\n' + texte;
  journal(titre, charge && charge.returnValue === false ? 'ko' : 'ok');
}

function afficherErreur(titre, erreur) {
  var detail = erreur && (erreur.errorText || erreur.message) ? erreur.errorText || erreur.message : String(erreur);
  el('sortie').textContent = '// ' + titre + '\n' + detail;
  journal(titre + ' : ' + detail, 'ko');
}

/**
 * Appel LS2. Deux chemins : `webOS.service.request` (fourni par `webOSTV.js`, la voie normale) et
 * `PalmServiceBridge` (le pont bas niveau, toujours présent sur la TV) — si la bibliothèque
 * `webOSTV.js` n'est pas injectée par la plateforme, la page reste utilisable.
 */
function appeler(commande, parametres, options) {
  options = options || {};
  var charge = parametres || {};
  return new Promise(function (resolve, reject) {
    var api = window.webOS && window.webOS.service ? window.webOS.service : null;
    if (api && api.request) {
      var requete = {
        method: commande,
        parameters: charge,
        onSuccess: function (reponse) {
          if (options.abonnement && options.aChaqueReponse) options.aChaqueReponse(reponse);
          resolve(reponse);
        },
        onFailure: function (erreur) {
          reject(erreur);
        }
      };
      if (options.abonnement) requete.subscribe = true;
      api.request(SERVICE, requete);
      return;
    }
    if (typeof window.PalmServiceBridge === 'function') {
      var pont = new window.PalmServiceBridge();
      pont.onservicecallback = function (texte) {
        var reponse;
        try {
          reponse = JSON.parse(texte);
        } catch (erreur) {
          reject(new Error('reponse LS2 illisible'));
          return;
        }
        if (options.abonnement && options.aChaqueReponse) options.aChaqueReponse(reponse);
        resolve(reponse);
      };
      var enveloppe = { };
      Object.keys(charge).forEach(function (cle) {
        enveloppe[cle] = charge[cle];
      });
      if (options.abonnement) enveloppe.subscribe = true;
      pont.call(SERVICE + '/' + commande, JSON.stringify(enveloppe));
      return;
    }
    reject(new Error('aucun pont LS2 disponible : cette page doit tourner sur la TV (ou le simulateur LG)'));
  });
}

function identifiants() {
  return {
    username: el('utilisateur').value,
    password: el('motdepasse').value
  };
}

function profilDepuisFormulaire() {
  return {
    profileId: el('profil').value || 'p1',
    baseUrl: el('url').value
  };
}

document.addEventListener('DOMContentLoaded', function () {
  var info = {};
  try {
    info = (window.webOS && window.webOS.deviceInfo) ? window.webOS.deviceInfo() : {};
  } catch (erreur) {
    info = { erreur: String(erreur) };
  }
  el('appareil').textContent =
    'modèle ' + (info.modelName || '?') + ' · webOS ' + (info.version || '?') +
    ' · SDK ' + (info.sdkVersion || '?') + ' · ' + (info.screenWidth || '?') + 'x' + (info.screenHeight || '?');

  el('btn-test').onclick = function () {
    var profil = profilDepuisFormulaire();
    var secrets = identifiants();
    journal('testProfile ' + profil.baseUrl);
    appeler('testProfile', {
      kind: 'xtream',
      baseUrl: profil.baseUrl,
      username: secrets.username,
      password: secrets.password,
      lanAllowed: false
    })
      .then(function (reponse) { afficher('testProfile', reponse); })
      .catch(function (erreur) { afficherErreur('testProfile', erreur); });
  };

  el('btn-import').onclick = function () {
    var profil = profilDepuisFormulaire();
    var secrets = identifiants();
    journal('importPlaylist ' + profil.profileId);
    appeler('importPlaylist', {
      profileId: profil.profileId,
      kind: 'xtream',
      contentType: el('contenu').value,
      source: { url: profil.baseUrl, credentials: secrets },
      consent: { persistSecrets: el('memoriser').checked }
    }, {
      abonnement: true,
      aChaqueReponse: function (reponse) {
        if (reponse && reponse.data && reponse.data.jobId) derniereJobId = reponse.data.jobId;
        afficher('importPlaylist (progression)', reponse);
      }
    })
      .then(function (reponse) {
        if (reponse && reponse.data && reponse.data.jobId) derniereJobId = reponse.data.jobId;
        afficher('importPlaylist (demarrage)', reponse);
      })
      .catch(function (erreur) { afficherErreur('importPlaylist', erreur); });
  };

  el('btn-annuler').onclick = function () {
    if (!derniereJobId) { journal('aucun job en cours connu', 'ko'); return; }
    appeler('cancelOperation', { jobId: derniereJobId })
      .then(function (reponse) { afficher('cancelOperation', reponse); })
      .catch(function (erreur) { afficherErreur('cancelOperation', erreur); });
  };

  el('btn-job').onclick = function () {
    if (!derniereJobId) { journal('aucun job connu : lancez un import', 'ko'); return; }
    appeler('getImportJob', { jobId: derniereJobId })
      .then(function (reponse) { afficher('getImportJob', reponse); })
      .catch(function (erreur) { afficherErreur('getImportJob', erreur); });
  };

  el('btn-page').onclick = function () {
    var profil = profilDepuisFormulaire();
    appeler('getPage', { profileId: profil.profileId, contentType: el('contenu').value, order: 'source' })
      .then(function (reponse) { afficher('getPage', reponse); })
      .catch(function (erreur) { afficherErreur('getPage', erreur); });
  };

  el('btn-tranches').onclick = function () {
    var profil = profilDepuisFormulaire();
    appeler('getBuckets', { profileId: profil.profileId, contentType: el('contenu').value })
      .then(function (reponse) { afficher('getBuckets', reponse); })
      .catch(function (erreur) { afficherErreur('getBuckets', erreur); });
  };

  el('btn-recherche').onclick = function () {
    var profil = profilDepuisFormulaire();
    var requete = window.prompt('Préfixe recherché :', 'chaine');
    if (!requete) return;
    appeler('search', { profileId: profil.profileId, contentType: el('contenu').value, query: requete })
      .then(function (reponse) { afficher('search « ' + requete + ' »', reponse); })
      .catch(function (erreur) { afficherErreur('search', erreur); });
  };

  el('btn-detail').onclick = function () {
    var profil = profilDepuisFormulaire();
    appeler('getDetails', {
      profileId: profil.profileId,
      contentType: el('contenu').value,
      ref: { contentType: el('contenu').value, providerId: el('flux').value }
    })
      .then(function (reponse) { afficher('getDetails', reponse); })
      .catch(function (erreur) { afficherErreur('getDetails', erreur); });
  };

  el('btn-resoudre').onclick = function () {
    var profil = profilDepuisFormulaire();
    journal('resolveStream ' + el('flux').value);
    appeler('resolveStream', {
      profileId: profil.profileId,
      ref: { contentType: el('contenu').value, providerId: el('flux').value },
      requestedFormat: 'auto'
    })
      .then(function (reponse) {
        var url = reponse && reponse.data ? reponse.data.url : undefined;
        afficher('resolveStream' + (url ? ' (hôte : ' + hoteSeul(url) + ')' : ''), reponse);
      })
      .catch(function (erreur) { afficherErreur('resolveStream', erreur); });
  };

  el('btn-diagnostic').onclick = function () {
    appeler('diagnostics', { scope: 'local' })
      .then(function (reponse) { afficher('diagnostics', reponse); })
      .catch(function (erreur) { afficherErreur('diagnostics', erreur); });
  };

  el('btn-supprimer').onclick = function () {
    var profil = profilDepuisFormulaire();
    if (!window.confirm('Supprimer le profil ' + profil.profileId + ' et son index ?')) return;
    appeler('deleteProfile', { profileId: profil.profileId })
      .then(function (reponse) { afficher('deleteProfile', reponse); })
      .catch(function (erreur) { afficherErreur('deleteProfile', erreur); });
  };

  journal('page prête — service ' + SERVICE);
  journal('connectez la TV en mode développeur (clé + ares-install) avant les appels');
});

function hoteSeul(url) {
  var correspondance = /^https?:\/\/([^/?#]+)/i.exec(url || '');
  return correspondance ? correspondance[1].replace(/^[^@]*@/, '') : '?';
}
