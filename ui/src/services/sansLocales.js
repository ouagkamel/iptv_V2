'use strict';

/**
 * Aucune donnée de langue n'est chargée par l'interface — et c'est **volontaire**.
 *
 * Les textes de cette application sont écrits en français dans le code ; il n'y a ni traduction, ni
 * date localisée, ni format de nombre à charger. Or Enact charge des données de langue dès le premier
 * appel de `$L()` fait par un composant Sandstone (`Header`, `useScroll`, `MediaPlayer`…), et il le
 * fait **de façon synchrone** :
 *
 *   $L(...) → toIString() → createResBundle({sync:true}) → new ilib.ResBundle
 *           → IString.loadPlurals() → Utils.loadData({sync:true})
 *           → EnyoLoader.loadFiles(paths, sync=true) → loadManifestsSync()
 *           → XMLHttpRequest **synchrone** sur « <base>/locale/ilibmanifest.json »
 *
 * Dans un navigateur, sur `file://`, un XHR synchrone vers un fichier **absent** échoue en levant
 * une exception (`Failed to execute 'send' on 'XMLHttpRequest'`). L'exception remonte au milieu d'un
 * rendu React : l'arbre est démonté et l'écran reste **noir**. C'est exactement ce que faisait le
 * paquet 0.1.8, dont l'interface n'embarquait aucune donnée iLib (D-35).
 *
 * Deux garde-fous sont donc posés ici, avant tout rendu :
 *
 *  1. **un chargeur inerte** : toute demande de données de langue reçoit « rien » au lieu de partir
 *     en requête. Aucun fichier n'est cherché, aucun XHR n'est émis — donc aucun échec possible,
 *     ni en synchrone ni en asynchrone ;
 *  2. **un paquet de chaînes vide** : `$L()` renvoie la chaîne source telle quelle, comportement
 *     attendu par Enact quand une traduction n'existe pas (`missing: 'source'`). Il n'y a donc plus
 *     de construction de `ResBundle`, c'est-à-dire plus d'appel au chargeur.
 *
 * Conséquence assumée : les libellés internes de Sandstone (accessibilité, lecteur média) restent en
 * anglais — ceux de l'application, écrits en français, ne changent pas. Rien de ce qui est visible
 * dans les quatre écrans V1-A n'en dépend.
 */

import ilib from 'ilib/lib/ilib';
import IString from 'ilib/lib/IString';
import {setResBundle} from '@enact/i18n/src/resBundle';

/** Chargeur inerte : il répond « donnée absente » sans jamais toucher au réseau. */
const chargeurInerte = {
  /** `ilib` attend un tableau de la même longueur que `paths`, avec `undefined` là où il n'y a rien. */
  loadFiles: function (paths, sync, params, callback) {
    const vide = (paths || []).map(() => undefined);
    if (typeof callback === 'function') callback(vide);
    return vide;
  },
  loadManifests: function () {
    return Promise.resolve();
  },
  loadManifestsSync: function () {
    return undefined;
  },
  isAvailable: function () {
    return false;
  },
  _validateCache: function () {
    return undefined;
  }
};

/** Paquet de chaînes vide : `$L('Voir')` → `« Voir »`. */
const paquetVide = {
  getString: function (valeur) {
    return new IString(String(valeur));
  }
};

/**
 * À appeler **avant** le premier rendu : remplace le chargeur installé par `@enact/i18n` et fixe le
 * paquet de chaînes. Idempotent — le rappeler ne change rien.
 */
function installerLangueSansDonnees() {
  ilib.setLoaderCallback(chargeurInerte);
  setResBundle(paquetVide);
}

export default installerLangueSansDonnees;
