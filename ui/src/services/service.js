'use strict';

/**
 * Accès au service de l'application (§15.4) — **module pur**, sans React, testable sous Node.
 *
 * Chaque fonction rend `{ ok, data, error, indexVersion, brut }` :
 *   - `ok`      : `returnValue === true` **et** verdict métier conforme quand il y en a un ;
 *   - `data`    : la charge utile, ou `null` ;
 *   - `error`   : `{code, message, retryable, hint}` normalisé (enveloppe du service ou erreur du
 *                 bus), prêt à afficher — jamais « [object Object] » ;
 *   - `brut`    : la réponse LS2 d'origine (diagnostic et journal).
 *
 * Les écrans n'appellent jamais `webOS.service.request` directement : ils passent par ici, ce qui
 * garantit que les mêmes règles (paramètres exacts, verdict métier, erreurs normalisées) valent pour
 * tous les écrans, et qu'un test peut les vérifier sans TV.
 */

let ls2 = require('./ls2');
let format = require('../../../src/app/format.js');

/** Source préconfigurée → identifiants de session (jamais journalisés). */
function secretsDe(source) {
  let champs = format.champsDepuisSource(source || {});
  return { username: champs.username, password: champs.password };
}

/** Normalise une réponse LS2 en résultat exploitable par un écran. */
function analyser(reponse) {
  reponse = reponse || {};
  let data = reponse.data === undefined ? null : reponse.data;
  let verdict = data && typeof data.ok === 'boolean' ? data.ok : null;
  let ok = reponse.returnValue === true && verdict !== false;
  return {
    ok: ok,
    data: data,
    error: ok ? null : erreurDe(reponse),
    indexVersion: reponse.indexVersion,
    brut: reponse
  };
}

/** Erreur normalisée, quelle que soit sa forme (enveloppe du service ou erreur du bus). */
function erreurDe(reponse) {
  reponse = reponse || {};
  if (reponse.error && typeof reponse.error === 'object') {
    return {
      code: String(reponse.error.code || 'internal/unexpected'),
      message: String(reponse.error.message || 'erreur sans message'),
      retryable: reponse.error.retryable === true,
      hint: reponse.error.hint ? String(reponse.error.hint) : ''
    };
  }
  if (reponse.errorText) {
    return {
      code: 'bridge/' + String(reponse.errorCode === undefined ? 'erreur' : reponse.errorCode),
      message: String(reponse.errorText),
      retryable: false,
      hint: ''
    };
  }
  return { code: 'internal/unexpected', message: format.texteErreur(reponse), retryable: false, hint: '' };
}

/** Message affichable d'un résultat en échec, indication comprise. */
function messageDe(resultat) {
  if (!resultat || !resultat.error) return '';
  let erreur = resultat.error;
  return erreur.code + ' — ' + erreur.message + (erreur.hint ? ' (' + erreur.hint + ')' : '');
}

/* ----------------------------------------------------------------- commandes */

/** `testProfile` : verdict de connexion, sans persistance d'identifiants. */
function testProfile(demande) {
  return ls2
    .commande('testProfile', {
      profileId: demande.profileId,
      kind: demande.kind || 'xtream',
      baseUrl: demande.baseUrl,
      username: demande.username,
      password: demande.password,
      lanAllowed: demande.lanAllowed === true,
      consent: { insecureHttp: demande.insecureHttp === true }
    })
    .then(analyser);
}

/** `importPlaylist` : première réponse (`{jobId}`), puis progression par abonnement. */
function importerPlaylist(demande, aChaqueReponse) {
  let flux = ls2.abonnement(
    'importPlaylist',
    {
      profileId: demande.profileId,
      kind: demande.kind || 'xtream',
      contentType: demande.contentType || 'live',
      source: { url: demande.baseUrl, credentials: { username: demande.username, password: demande.password } },
      consent: { persistSecrets: demande.persistSecrets === true, insecureHttp: demande.insecureHttp === true }
    },
    function (reponse) {
      if (aChaqueReponse) aChaqueReponse(analyser(reponse));
    }
  );
  return {
    depart: flux.fait.then(analyser),
    annuler: flux.annuler
  };
}

/** `getCategories` : liste du panneau des catégories (ordre fournisseur, comptes indexés). */
function getCategories(profileId, contentType) {
  return ls2.commande('getCategories', { profileId: profileId, contentType: contentType }).then(analyser);
}

/** `getPage` : page de catalogue à curseur versionné. */
function getPage(demande) {
  let params = {
    profileId: demande.profileId,
    contentType: demande.contentType,
    order: demande.order || 'source'
  };
  if (demande.categoryId) params.categoryId = demande.categoryId;
  if (demande.cursor) params.cursor = demande.cursor;
  return ls2.commande('getPage', params).then(analyser);
}

/** `getBuckets` : tranches alphabétiques issues des données. */
function getBuckets(profileId, contentType) {
  return ls2.commande('getBuckets', { profileId: profileId, contentType: contentType }).then(analyser);
}

/** `search` : recherche indexée (titres), paginée par le service. */
function search(demande) {
  let params = { profileId: demande.profileId, contentType: demande.contentType, query: demande.query };
  if (demande.cursor) params.cursor = demande.cursor;
  return ls2.commande('search', params).then(analyser);
}

/** `getDetails` : fiche complète (détail lourd), sans URL de flux. */
function getDetails(profileId, contentType, ref) {
  return ls2.commande('getDetails', { profileId: profileId, contentType: contentType, ref: ref }).then(analyser);
}

/** `resolveStream` : résolution juste avant lecture. Seule commande qui transporte une URL. */
function resolveStream(demande) {
  return ls2
    .commande('resolveStream', {
      profileId: demande.profileId,
      ref: demande.ref,
      requestedFormat: demande.requestedFormat || 'auto'
    })
    .then(analyser);
}

/** `getImportJob` : état d'un import, y compris après redémarrage du service. */
function getImportJob(jobId) {
  return ls2.commande('getImportJob', { jobId: jobId }).then(analyser);
}

/** `cancelOperation` : annulation coopérative. */
function cancelOperation(jobId) {
  return ls2.commande('cancelOperation', { jobId: jobId }).then(analyser);
}

/** `deleteProfile` : effacement complet (DB8, index, fichiers temporaires). */
function deleteProfile(profileId) {
  return ls2.commande('deleteProfile', { profileId: profileId }).then(analyser);
}

/** `diagnostics` : état local du service (sans secret ni URL). */
function diagnostics() {
  return ls2.commande('diagnostics', {}).then(analyser);
}

module.exports = {
  analyser: analyser,
  erreurDe: erreurDe,
  messageDe: messageDe,
  secretsDe: secretsDe,
  testProfile: testProfile,
  importerPlaylist: importerPlaylist,
  getCategories: getCategories,
  getPage: getPage,
  getBuckets: getBuckets,
  search: search,
  getDetails: getDetails,
  resolveStream: resolveStream,
  getImportJob: getImportJob,
  cancelOperation: cancelOperation,
  deleteProfile: deleteProfile,
  diagnostics: diagnostics
};
