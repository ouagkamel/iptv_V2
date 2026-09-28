#!/usr/bin/env node
'use strict';

/**
 * Assemble et empaquette l'application webOS : `release/<id>_<version>_all.ipk`.
 *
 * Le paquet contient **deux morceaux** :
 *  1. l'application web (`appinfo.json`, `index.html`, la page de diagnostic, les visuels) ;
 *  2. le service JS (`service/<id>/` avec `package.json`, `services.json`, `lib/` compilé).
 *
 * Le service est empaqueté par `ares-package` (outillage LG) : c'est lui qui connaît la structure
 * exacte d'un `.ipk` webOS et qui vérifie `appinfo.json` / `services.json`. Le script ne réinvente
 * pas le format : il prépare l'arborescence, appelle l'outil, puis recopie le résultat dans
 * `release/` (les dossiers `dist/` et `build/` ne sont pas conservés par l'espace de travail).
 *
 * Prérequis : `npm i -g @webosose/ares-cli` (ou renseigner `ARES_PACKAGE`).
 */

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var SERVICE_DIR = path.join(ROOT, 'service', 'com.ouagkamel.app.iptvplayer.service');
var APP_SRC = path.join(ROOT, 'src', 'app');
var RELEASE = path.join(ROOT, 'release');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function fail(message) {
  console.error('[pack] ' + message);
  process.exit(1);
}

/** Suppression récursive sans dépendre de `fs.rm` (absent des Node anciens). */
function removeTree(target) {
  if (!fs.existsSync(target)) return;
  fs.readdirSync(target).forEach(function (name) {
    var complet = path.join(target, name);
    if (fs.statSync(complet).isDirectory()) removeTree(complet);
    else fs.unlinkSync(complet);
  });
  fs.rmdirSync(target);
}

/** Création d'arborescence portable : `mkdirSync(dir, {recursive:true})` date de Node 10.12. */
function creerDossiers(dir) {
  var parent = path.dirname(dir);
  if (parent !== dir && !fs.existsSync(parent)) creerDossiers(parent);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
}

function copyTree(from, to) {
  creerDossiers(to);
  fs.readdirSync(from).forEach(function (name) {
    if (name === 'node_modules' || name === '.git') return;
    var source = path.join(from, name);
    var cible = path.join(to, name);
    if (fs.statSync(source).isDirectory()) copyTree(source, cible);
    else fs.copyFileSync(source, cible);
  });
}

function aresPackageCommand() {
  if (process.env.ARES_PACKAGE) return process.env.ARES_PACKAGE;
  var local = path.join(process.env.HOME || '', '.local', 'ares', 'node_modules', '.bin', 'ares-package');
  if (fs.existsSync(local)) return local;
  return 'ares-package';
}

function main() {
  var appinfo = JSON.parse(read(path.join(ROOT, 'appinfo.json')));
  var serviceInfo = JSON.parse(read(path.join(SERVICE_DIR, 'services.json')));
  var serviceName = serviceInfo.services && serviceInfo.services[0] ? serviceInfo.services[0].name : serviceInfo.id;

  // 1) le service doit être compilé : le paquet embarque `lib/`, pas la source TypeScript
  var libMain = path.join(SERVICE_DIR, 'package.json');
  var main = JSON.parse(read(libMain)).main;
  if (!fs.existsSync(path.join(SERVICE_DIR, main))) {
    fail('service non compile (' + main + ' absent) — executer `npm run build:service`');
  }

  // 2) la page de diagnostic doit exister : sans elle, un paquet « service seul » n'est pas lançable
  if (!fs.existsSync(path.join(APP_SRC, 'index.html'))) {
    fail('page d application absente (src/app/index.html)');
  }

  // 3) arborescence d'empaquetage dans un dossier temporaire
  var staging = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-pack-'));
  var appDir = path.join(staging, 'app');
  creerDossiers(appDir);
  fs.copyFileSync(path.join(ROOT, 'appinfo.json'), path.join(appDir, 'appinfo.json'));
  copyTree(APP_SRC, appDir);
  if (fs.existsSync(path.join(APP_SRC, 'assets'))) copyTree(path.join(APP_SRC, 'assets'), path.join(appDir, 'assets'));

  creerDossiers(RELEASE);
  var commande = aresPackageCommand();
  var argumentsOutils = [appDir, SERVICE_DIR, '-o', RELEASE, '--no-minify'];
  console.log('[pack] ' + commande + ' ' + argumentsOutils.join(' '));

  var resultat = childProcess.spawnSync(commande, argumentsOutils, { stdio: 'inherit', cwd: ROOT });
  if (resultat.error) {
    fail(
      'ares-package introuvable (' + resultat.error.message + ').\n' +
        '  Installer l outillage LG : npm i -g @webosose/ares-cli\n' +
        '  ou renseigner ARES_PACKAGE=/chemin/vers/ares-package'
    );
  }
  if (resultat.status !== 0) fail('ares-package a echoue (code ' + resultat.status + ')');

  var ipk = fs
    .readdirSync(RELEASE)
    .filter(function (name) {
      return /\.ipk$/.test(name);
    })
    .map(function (name) {
      return path.join(RELEASE, name);
    })
    .sort(function (a, b) {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    })[0];
  if (!ipk) fail('aucun .ipk produit dans ' + RELEASE);

  // 4) copie lisible du contenu du paquet (inspection sans dépaqueter l'ipk)
  var inspection = path.join(RELEASE, 'package');
  if (fs.existsSync(inspection)) removeTree(inspection);
  copyTree(appDir, inspection);
  copyTree(SERVICE_DIR, path.join(inspection, 'service', serviceName));

  console.log('[pack] paquet : ' + path.relative(ROOT, ipk) + ' (' + fs.statSync(ipk).size + ' octets)');
  console.log('[pack] contenu : ' + path.relative(ROOT, inspection));
  console.log('[pack] installation : ares-install --device <nom> ' + path.relative(ROOT, ipk));
  removeTree(staging);
}

main();
