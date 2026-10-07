#!/usr/bin/env node
'use strict';

/**
 * Construit l'interface Enact (`ui/`) avec l'outillage officiel, dans les conditions de la cible.
 *
 * Trois pièges sont traités ici, une fois pour toutes :
 *
 *  1. **OpenSSL 3** — la chaîne Enact 3.x s'appuie sur webpack 4, qui calcule des empreintes `md4`.
 *     Les Node ≥ 17 refusent `md4` par défaut : `enact pack` échoue alors en
 *     `error:0308010C:digital envelope routines::unsupported`. On rouvre donc la fourniture
 *     historique (`--openssl-legacy-provider`) **sans l'imposer** aux Node antérieurs, qui ne
 *     connaissent pas cette option.
 *
 *  2. **Données iLib** — le plugin iLib copie par défaut les 82 Mio de locales dans `dist/` : un
 *     `.ipk` de cette taille n'a aucun sens sur une TV. L'interface n'affiche que du texte français
 *     en dur et n'utilise aucune API de localisation : `ILIB_ASSET_EMIT=false` produit un bundle de
 *     ~1 Mo qui déclare `ILIB_NO_ASSETS` (aucune requête de locale au démarrage).
 *
 *  3. **Dépendances** — l'interface a son propre `package.json`/`package-lock.json` : le message
 *     d'erreur dit exactement quoi exécuter, plutôt que de laisser webpack signaler un module absent.
 *
 * Résultat : `ui/dist/main.js` + `ui/dist/main.css`, copiés dans l'application par
 * `tools/make-package.js` sous `ui/`.
 */

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var UI = path.join(ROOT, 'ui');
var DIST = path.join(UI, 'dist');

function fail(message) {
  console.error('[ui] ' + message);
  process.exit(1);
}

/** Version majeure de Node en cours — décide de la fourniture OpenSSL. */
function majeureNode() {
  return Number(String(process.versions.node).split('.')[0]);
}

function environnementsDeBuild() {
  var env = Object.assign({}, process.env);
  if (majeureNode() >= 17) {
    env.NODE_OPTIONS = (env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : '') + '--openssl-legacy-provider';
  }
  env.ILIB_ASSET_EMIT = 'false';
  return env;
}

function commandeEnact() {
  var local = path.join(UI, 'node_modules', '.bin', 'enact');
  if (fs.existsSync(local)) return local;
  return 'enact';
}

function main() {
  if (!fs.existsSync(path.join(UI, 'node_modules', '@enact', 'cli'))) {
    fail(
      'dependances de l interface absentes — executer :\n' +
        '    npm --prefix ui ci        (ou `npm --prefix ui install`)'
    );
  }

  var commande = commandeEnact();
  var parametres = ['pack', '-p'];
  console.log(
    '[ui] ' + commande + ' ' + parametres.join(' ') + '  (Node ' + process.versions.node +
      ', OpenSSL ' + (majeureNode() >= 17 ? 'compatibilite md4 activee' : 'natif') + ')'
  );

  var resultat = childProcess.spawnSync(commande, parametres, {
    cwd: UI,
    env: environnementsDeBuild(),
    stdio: 'inherit'
  });

  if (resultat.error) {
    fail('enact introuvable (' + resultat.error.message + ') — npm --prefix ui ci');
  }
  if (resultat.status !== 0) {
    fail(
      'la construction de l interface a echoue (code ' + resultat.status + ').\n' +
        '  Si le journal contient `error:0308010C`, la fourniture OpenSSL n a pas ete acceptee :\n' +
        '  verifier la version de Node (>= 17) et relancer ce script plutot que `enact pack` a la main.'
    );
  }

  ['main.js', 'main.css'].forEach(function (nom) {
    if (!fs.existsSync(path.join(DIST, nom))) fail('fichier attendu absent apres construction : ui/dist/' + nom);
  });

  ['main.js', 'main.css'].forEach(function (nom) {
    console.log('[ui] ui/dist/' + nom + ' (' + fs.statSync(path.join(DIST, nom)).size + ' octets)');
  });
}

if (require.main === module) main();

module.exports = { environnementsDeBuild: environnementsDeBuild, majeureNode: majeureNode };
