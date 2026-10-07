#!/usr/bin/env node
'use strict';

/**
 * Livraison **d'essai** : l'application avec la source préconfigurée de `secrets.local/profils.js`
 * (hors dépôt). Destinée au banc d'essai (TV réelle, simulateur) — **jamais publiée**.
 *
 * Ce que le script fait, dans l'ordre :
 *  1. l'interface est reconstruite (`npm run build:ui`) puis l'application empaquetée
 *     (`tools/make-package.js`), ce qui intègre `secrets.local/profils.js` en remplacement de
 *     `src/app/profils.js` ;
 *  2. le pack simulateur est assemblé (`tools/stage-simulator.js`) ;
 *  3. les deux artefacts sont recopiés dans `release/local/` — dossier **hors publication**.
 *
 * `release/` est ignoré par git et `tools/publish-release.js` refuse toute archive qui embarque une
 * source : un paquet d'essai ne peut donc pas partir par erreur sur GitHub. Le rappel est répété en
 * fin d'exécution.
 *
 * Résultat :
 *   release/local/<id>_<version>_all.ipk        (paquet à installer sur la TV)
 *   release/local/<version>-simulateur-source.zip
 */

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var RELEASE = path.join(ROOT, 'release');
var LOCAL = path.join(RELEASE, 'local');
var SECRETS = path.join(ROOT, 'secrets.local', 'profils.js');

function creerDossiers(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
}

function executer(script) {
  var resultat = childProcess.spawnSync(process.execPath, [path.join(__dirname, script)], {
    stdio: 'inherit',
    cwd: ROOT,
    env: process.env
  });
  if (resultat.status !== 0) {
    console.error('[local] ' + script + ' a echoue (code ' + resultat.status + ')');
    process.exit(1);
  }
}

function main() {
  if (process.env.IPTV_SANS_SOURCES === '1') {
    console.error('[local] IPTV_SANS_SOURCES=1 : cette cible sert justement a embarquer la source');
    process.exit(1);
  }
  if (!fs.existsSync(SECRETS)) {
    console.error(
      '[local] secrets.local/profils.js absent : rien a embarquer.\n' +
        '  Ce fichier (hors depot) declare window.iptvProfils = {sources: [{id, nom, url, username, password}]}.\n' +
        '  Voir docs/PHASE-0.md, « Source preconfiguree ».'
    );
    process.exit(1);
  }

  executer('build-ui.js');
  executer('make-package.js');
  executer('stage-simulator.js');

  var appinfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'appinfo.json'), 'utf8'));
  var version = appinfo.version;
  var ipk = fs
    .readdirSync(RELEASE)
    .filter(function (nom) {
      return /\.ipk$/.test(nom) && nom.indexOf('_' + version + '_') !== -1;
    })
    .sort()[0];
  if (!ipk) {
    console.error('[local] paquet ' + version + ' introuvable dans release/');
    process.exit(1);
  }

  creerDossiers(LOCAL);
  var cibleIpk = path.join(LOCAL, ipk);
  fs.copyFileSync(path.join(RELEASE, ipk), cibleIpk);

  var zip = path.join(LOCAL, version + '-simulateur-source.zip');
  if (fs.existsSync(zip)) fs.unlinkSync(zip);
  var archive = childProcess.spawnSync('zip', ['-qr', zip, '.'], {
    cwd: path.join(RELEASE, 'simulator'),
    stdio: 'inherit'
  });
  if (archive.status !== 0 || !fs.existsSync(zip)) {
    console.error('[local] zip du simulateur impossible (outil `zip` absent ?)');
    process.exit(1);
  }

  var octets = function (fichier) {
    return fs.statSync(fichier).size + ' octets';
  };
  console.log('[local] paquet d essai : ' + path.relative(ROOT, cibleIpk) + ' (' + octets(cibleIpk) + ')');
  console.log('[local] simulateur     : ' + path.relative(ROOT, zip) + ' (' + octets(zip) + ')');
  console.log('[local] installation   : ares-install --device tv ' + path.relative(ROOT, cibleIpk));
  console.log('[local] rappel : ces fichiers portent la source d essai — ne pas publier');
}

main();
