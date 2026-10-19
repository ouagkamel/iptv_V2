'use strict';

/**
 * Sources préconfigurées de l'application (§3.5) — **module pur**, testable sous Node.
 *
 * Même mécanisme que la page de diagnostic : `window.iptvProfils` est fourni par `profils.js`.
 * En 0.1.18, le profil de test est le choix par défaut; les essais locaux peuvent le remplacer par
 * `secrets.local/profils.js`. Les paquets publiables doivent être construits avec
 * `IPTV_SANS_SOURCES=1`, et la publication refuse toute archive qui déclare une source.
 */

let format = require('../../../src/app/format.js');

/** Liste des sources disponibles, vide si aucune (livraison publiable). */
function sources(racine) {
  let fenetre = racine || (typeof window !== 'undefined' ? window : null);
  let paquet = fenetre && fenetre.iptvProfils;
  return paquet && paquet.sources && paquet.sources.length ? paquet.sources : [];
}

/**
 * État initial du formulaire de profil : la première source préconfigurée remplit tout, sinon des
 * champs vides avec un identifiant de profil par défaut.
 */
function etatInitial(racine) {
  let liste = sources(racine);
  if (liste.length === 0) {
    return {
      choix: -1,
      sources: [],
      profilId: 'p1',
      nom: '',
      url: '',
      username: '',
      password: '',
      insecureHttp: false
    };
  }
  return depuis(liste, 0, liste);
}

/** État de formulaire correspondant à une source de la liste. */
function depuis(liste, index, touteLaListe) {
  let source = liste[Number(index)] || {};
  let champs = format.champsDepuisSource(source);
  return {
    choix: Number(index),
    sources: touteLaListe || liste,
    profilId: champs.profileId || 'p1',
    nom: champs.nom,
    url: champs.url,
    username: champs.username,
    password: champs.password,
    insecureHttp: champs.autoriserHttp,
    etiquettes: champs.etiquettes
  };
}

module.exports = {
  sources: sources,
  etatInitial: etatInitial,
  depuis: depuis
};
