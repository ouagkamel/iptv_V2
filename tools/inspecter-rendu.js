'use strict';

/**
 * Contrôle **visuel** d'un paquet ou d'une livraison (V1-A) : la seule vérification qui montre ce que
 * l'utilisateur voit vraiment.
 *
 * `tools/render-app.js` exécute le paquet dans un DOM sans moteur de rendu : il prouve que
 * l'application démarre, se rend, n'émet aucune requête et que ses ressources sont présentes. Il ne
 * peut pas prouver qu'un texte est **lisible** — c'est exactement ainsi qu'un écran noir est passé
 * inaperçu alors qu'il n'y avait plus aucune erreur : le thème n'était pas appliqué, le texte
 * s'affichait en noir sur fond noir (D-38).
 *
 * Ce contrôle-ci charge la même arborescence dans un **vrai Chromium** (Playwright), puis :
 *
 *  - mesure les styles calculés (police, couleur de texte, fond) et le **contraste** titre/fond ;
 *  - relève les ressources en échec (polices manquantes) et les erreurs de page ;
 *  - écrit une **capture d'écran** — pièce jointe utile dans un rapport d'essai.
 *
 * Playwright est une dépendance d'outillage **non requise** : absent, le contrôle le dit et se
 * termine sans échec (il n'est pas exécuté en CI, qui n'a pas de navigateur).
 *
 *   node tools/inspecter-rendu.js <racine> [capture.png]
 */

var path = require('path');

/** Playwright, installé à côté (devDependency facultative) ou dans un dossier d'outils local. */
function chargerPlaywright() {
  var candidats = [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    '/home/user/.local/pw/node_modules/playwright'
  ];
  for (var i = 0; i < candidats.length; i++) {
    if (!candidats[i]) continue;
    try {
      return require(candidats[i]);
    } catch (erreur) {
      // candidat suivant
    }
  }
  return null;
}

/** Contraste WCAG entre deux couleurs `rgb(...)`. */
function contraste(a, b) {
  function luminance(couleur) {
    var parts = /rgba?\(([^)]+)\)/.exec(couleur);
    if (!parts) return null;
    var composants = parts[1].split(',').slice(0, 3).map(function (valeur) {
      var canal = parseFloat(valeur) / 255;
      return canal <= 0.03928 ? canal / 12.92 : Math.pow((canal + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * composants[0] + 0.7152 * composants[1] + 0.0722 * composants[2];
  }
  var la = luminance(a);
  var lb = luminance(b);
  if (la === null || lb === null) return null;
  var clair = Math.max(la, lb);
  var sombre = Math.min(la, lb);
  return Math.round(((clair + 0.05) / (sombre + 0.05)) * 100) / 100;
}

function executer(racine, capture) {
  var playwright = chargerPlaywright();
  if (!playwright) {
    console.log('Controle visuel : ignore (playwright absent — npm i --no-save playwright && npx playwright install chromium)');
    return Promise.resolve({verdict: 'IGNORE'});
  }

  return playwright.chromium.launch({args: ['--no-sandbox']}).then(function (navigateur) {
    return navigateur
      .newContext({viewport: {width: 1920, height: 1080}})
      .then(function (contexte) {
        return contexte.newPage().then(function (page) {
          var requetesRatees = [];
          var erreurs = [];
          page.on('pageerror', function (erreur) {
            erreurs.push(String(erreur && erreur.message ? erreur.message : erreur));
          });
          page.on('requestfailed', function (requete) {
            requetesRatees.push(requete.url() + ' — ' + ((requete.failure() || {}).errorText || ''));
          });

          return page
            .goto('file://' + path.resolve(racine) + '/index.html', {waitUntil: 'load'})
            .then(function () {
              return page.waitForTimeout(2500);
            })
            .then(function () {
              return page.evaluate(function () {
                function style(selecteur) {
                  var element = document.querySelector(selecteur);
                  if (!element) return null;
                  var calcule = getComputedStyle(element);
                  return {
                    selecteur: selecteur,
                    police: calcule.fontFamily.split(',')[0],
                    couleur: calcule.color,
                    fond: calcule.backgroundColor,
                    taille: calcule.fontSize
                  };
                }
                // Fond **effectif** : le premier ancêtre du titre qui peint une couleur opaque. Le
                // nœud du thème est transparent (le fond vient de `bg`/`Panels`) : s'arrêter à lui
                // laisserait le contrôle de contraste sans mesure, donc sans effet.
                var fondEffectif = null;
                var curseur = document.querySelector('header');
                while (curseur && !fondEffectif) {
                  var peinture = getComputedStyle(curseur).backgroundColor;
                  if (peinture && peinture !== 'rgba(0, 0, 0, 0)' && peinture !== 'transparent') fondEffectif = peinture;
                  curseur = curseur.parentElement;
                }
                if (!fondEffectif) fondEffectif = getComputedStyle(document.body).backgroundColor;
                var racine = document.querySelector('#root');
                var theme = racine ? racine.firstElementChild : null;
                return {
                  titre: style('header [class*="Marquee"]') || style('header *'),
                  carte: style('[class*="Accueil_carte"]'),
                  theme: theme ? {classes: theme.className, fond: getComputedStyle(theme).backgroundColor} : null,
                  fondEffectif: fondEffectif,
                  texteVisible: racine ? (racine.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : ''
                };
              });
            })
            .then(function (mesures) {
              return page.screenshot({path: capture || path.join(require('os').tmpdir(), 'rendu.png')}).then(function () {
                return {mesures: mesures};
              });
            })
            .then(function (resultat) {
              return navigateur.close().then(function () {
                var mesures = resultat.mesures;
                var fond = mesures.fondEffectif || (mesures.theme ? mesures.theme.fond : null);
                var fondUtile = fond;
                var rapport = {
                  verdict: 'OK',
                  racine: path.resolve(racine),
                  capture: capture || '(temporaire)',
                  police: mesures.titre ? mesures.titre.police : null,
                  couleurTexte: mesures.titre ? mesures.titre.couleur : null,
                  fond: fond,
                  contraste: mesures.titre && fondUtile ? contraste(mesures.titre.couleur, fondUtile) : null,
                  requetesRatees: requetesRatees,
                  erreurs: erreurs,
                  texteVisible: mesures.texteVisible
                };
                if (!mesures.theme) {
                  rapport.verdict = 'ECHEC';
                  rapport.motif = 'aucun noeud de theme sous #root : l application se rend sans theme (texte noir sur fond noir)';
                } else if (requetesRatees.length > 0) {
                  rapport.verdict = 'ECHEC';
                  rapport.motif = 'ressources en echec (polices du theme ?)';
                } else if (erreurs.length > 0) {
                  rapport.verdict = 'ECHEC';
                  rapport.motif = 'erreurs dans la page';
                } else if (rapport.contraste !== null && rapport.contraste < 3) {
                  rapport.verdict = 'ECHEC';
                  rapport.motif = 'contraste insuffisant (' + rapport.contraste + ' < 3) : le texte ne se detache pas du fond';
                }
                console.log(JSON.stringify(rapport, null, 2));
                return rapport;
              });
            });
        });
      });
  });
}

if (require.main === module) {
  executer(process.argv[2] || 'release/package', process.argv[3]).then(
    function (rapport) {
      process.exit(rapport.verdict === 'ECHEC' ? 1 : 0);
    },
    function (erreur) {
      console.error(String(erreur && erreur.message ? erreur.message : erreur));
      process.exit(2);
    }
  );
}

module.exports = {executer: executer, contraste: contraste};
