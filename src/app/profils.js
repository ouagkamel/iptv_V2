'use strict';

/**
 * Sources préconfigurées de la page de diagnostic.
 *
 * **Ce fichier ne contient aucun secret** — et c'est volontaire : il est versionné, tandis que les
 * identifiants d'un compte de test vivent dans `secrets.local/profils.js`, hors dépôt (voir
 * `.gitignore`). À l'empaquetage, ce dernier **remplace** celui-ci dans l'application : la page
 * propose alors la source dans la liste, et il suffit de cliquer « Tester la source » puis
 * « Importer (live) », sans rien ressaisir.
 *
 *   secrets.local/profils.js         (local, jamais publié, jamais poussé)
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ window.iptvProfils = { sources: [ {                          │
 *   │   id: 'p1', nom: 'Portail de test', url: 'http://hote:8080', │
 *   │   username: '…', password: '…'                               │
 *   │ } ] };                                                       │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * `npm run dist` construit avec ce fichier s'il existe ; `IPTV_SANS_SOURCES=1 npm run dist` construit
 * une livraison **sans** source (c'est ce que `tools/publish-release.js` exige pour publier : les
 * dépôts et les publications GitHub sont publics).
 */

window.iptvProfils = window.iptvProfils || { sources: [] };
