'use strict';

/**
 * Chargement **à la demande** de `vendor/hls.min.js` (repli MSE du lecteur).
 *
 * Pourquoi pas un `import` : la spécification (§422) demande de **ne pas mettre HLS.js sur le
 * chemin par défaut** — la V1 lit avec le pipeline média natif, et une bibliothèque MSE a un coût
 * (segmentation et mémoire gérées en JavaScript). Un `import` statique l'embarquerait dans
 * `ui/main.js` et la ferait charger *à chaque démarrage*, même sur une TV qui n'en a jamais besoin.
 * Ici, le fichier est **livré dans le paquet** (donc aucune dépendance réseau, §2.3) mais son script
 * n'est injecté qu'au moment où le lecteur constate que ni HLS ni MPEG-TS natifs ne passent.
 *
 * Contrat :
 *  - `chargerHls()` rend une promesse résolue avec le constructeur `Hls` ;
 *  - l'injection n'a lieu **qu'une fois** par session (`window.Hls` déjà présent = pas de requête) ;
 *  - un échec de chargement est rendu, jamais avalé : le lecteur doit pouvoir dire ce qui a échoué.
 */

/** Chemin du fichier dans l'application empaquetée (racine de `index.html`). */
const CHEMIN = 'vendor/hls.min.js';

/** Injection en cours : deux appels concurrents ne doivent pas créer deux balises. */
let enCours = null;

/** Charge le constructeur `Hls`, une seule fois par session. */
function chargerHls() {
  if (typeof window !== 'undefined' && window.Hls) return Promise.resolve(window.Hls);
  if (enCours) return enCours;
  enCours = new Promise(function (resolve, reject) {
    if (typeof document === 'undefined') {
      reject(new Error('aucun document : repli MSE indisponible'));
      return;
    }
    const balise = document.createElement('script');
    balise.src = CHEMIN;
    balise.async = true;
    balise.onload = function () {
      if (window.Hls) {
        resolve(window.Hls);
        return;
      }
      enCours = null;
      reject(new Error('hls.js charge mais absent (window.Hls introuvable)'));
    };
    balise.onerror = function () {
      enCours = null;
      reject(new Error('hls.js introuvable dans le paquet (' + CHEMIN + ')'));
    };
    document.head.appendChild(balise);
  });
  return enCours;
}

/** Réinitialise l'état de chargement — réservé aux tests (le fichier n'est jamais retiré du DOM). */
function oublierLeChargement() {
  enCours = null;
}

module.exports = {
  CHEMIN: CHEMIN,
  chargerHls: chargerHls,
  oublierLeChargement: oublierLeChargement
};
