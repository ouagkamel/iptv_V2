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
// Sortie du `.ipk` : `release/` (livraison publiable) ou `IPTV_SORTIE=release/local` pour un pack
// d'essai. Le pack d'essai ne doit **jamais** ecraser le paquet publiable : la publication prend ses
// pieces dans `dist/`, et un `release/` melange a deja fait partir un paquet avec identifiants.
var SORTIE = process.env.IPTV_SORTIE ? path.resolve(ROOT, process.env.IPTV_SORTIE) : RELEASE;

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

/**
 * Copie recursive. Par defaut les dossiers `node_modules` sont **ignores** : une dependance ne doit
 * jamais se retrouver dans un paquet. Exception explicite (`autoriserNodeModules`) reservee aux
 * ressources du theme, dont le CSS a besoin (polices de Sandstone, rangees sous
 * `node_modules/@enact/sandstone/fonts/` par le build Enact).
 */
function copyTree(from, to, options) {
  var nodeModulesAutorises = !!(options && options.autoriserNodeModules);
  creerDossiers(to);
  fs.readdirSync(from).forEach(function (name) {
    if (name === '.git') return;
    if (name === 'node_modules' && !nodeModulesAutorises) return;
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

/** Taille cumulee d'un arbre de fichiers (octets). */
function tailleArbre(dossier) {
  var total = 0;
  (function parcourir(chemin) {
    fs.readdirSync(chemin).forEach(function (nom) {
      var complet = path.join(chemin, nom);
      if (fs.statSync(complet).isDirectory()) parcourir(complet);
      else total += fs.statSync(complet).size;
    });
  })(dossier);
  return total;
}

/** Nombre de fichiers d'un arbre. */
function compterFichiers(dossier) {
  var total = 0;
  (function parcourir(chemin) {
    fs.readdirSync(chemin).forEach(function (nom) {
      var complet = path.join(chemin, nom);
      if (fs.statSync(complet).isDirectory()) parcourir(complet);
      else total += 1;
    });
  })(dossier);
  return total;
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

  // 3ter) interface Enact (V1-A) : `ui/dist` est produit par `npm run build:ui` (Enact + Sandstone).
  // Le bundle embarque le pont LS2 et les écrans ; `index.html` ne charge que `profils.js` et lui.
  var uiDist = path.join(ROOT, 'ui', 'dist');
  if (!fs.existsSync(path.join(uiDist, 'main.js'))) {
    fail('interface Enact non construite (ui/dist/main.js absent) — executer `npm run build:ui`');
  }
  var uiApp = path.join(appDir, 'ui');
  creerDossiers(uiApp);
  ['main.js', 'main.css'].forEach(function (nom) {
    if (!fs.existsSync(path.join(uiDist, nom))) fail('interface Enact incomplete : ui/dist/' + nom + ' absent');
    fs.copyFileSync(path.join(uiDist, nom), path.join(uiApp, nom));
  });

  // 3ter) **ressources du theme** : `main.css` reference les polices de Sandstone en
  // `url(node_modules/@enact/sandstone/fonts/...)`, relatives a lui. Sans ce dossier a cote de
  // `main.css` dans le paquet, le navigateur ne trouve ni le texte (MuseoSans / Miso) ni les
  // **icones** (`Sandstone_Icons`), qui n'ont aucun repli local : les tuiles s'affichent sans
  // pictogramme. Le dossier vient du build Enact (`ui/dist/node_modules`), il ne contient que les
  // polices reellement referencees (environ 1,3 Mo).
  var uiRessources = path.join(uiDist, 'node_modules');
  if (!fs.existsSync(uiRessources)) {
    fail('interface Enact incomplete : ui/dist/node_modules absent (polices du theme) — relancer `npm run build:ui`');
  }
  var uiAppRessources = path.join(uiApp, 'node_modules');
  if (fs.existsSync(uiAppRessources)) removeTree(uiAppRessources);
  copyTree(uiRessources, uiAppRessources, {autoriserNodeModules: true});
  var policeIcones = path.join(uiAppRessources, '@enact', 'sandstone', 'fonts', 'Sandstone_Icons.ttf');
  if (!fs.existsSync(policeIcones)) {
    fail('polices du theme incompletes : ' + path.relative(ROOT, policeIcones) + ' absent');
  }
  console.log(
    '[pack] interface Enact : ui/main.js (' +
      fs.statSync(path.join(uiApp, 'main.js')).size +
      ' octets) + ui/main.css (' +
      fs.statSync(path.join(uiApp, 'main.css')).size +
      ' octets)'
  );

  // 3bis) sources préconfigurées : le fichier **local** (hors dépôt) remplace celui du dépôt dans
  // l'application empaquetée. `IPTV_SANS_SOURCES=1` construit une livraison publiable, sans secret.
  var sourceLocales = path.join(ROOT, 'secrets.local', 'profils.js');
  if (process.env.IPTV_SANS_SOURCES === '1') {
    console.log('[pack] sources preconfigurees : ignorees (IPTV_SANS_SOURCES=1)');
  } else if (fs.existsSync(sourceLocales)) {
    fs.copyFileSync(sourceLocales, path.join(appDir, 'profils.js'));
    console.log('[pack] sources preconfigurees : secrets.local/profils.js integre (hors depot)');
  }

  creerDossiers(SORTIE);
  var commande = aresPackageCommand();
  var argumentsOutils = [appDir, SERVICE_DIR, '-o', SORTIE, '--no-minify'];
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
    .readdirSync(SORTIE)
    .filter(function (name) {
      return /\.ipk$/.test(name);
    })
    .map(function (name) {
      return path.join(SORTIE, name);
    })
    .sort(function (a, b) {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    })[0];
  if (!ipk) fail('aucun .ipk produit dans ' + SORTIE);

  // 4) copie lisible du contenu du paquet (inspection sans dépaqueter l'ipk)
  var inspection = path.join(RELEASE, 'package');
  if (fs.existsSync(inspection)) removeTree(inspection);
  copyTree(appDir, inspection);
  // les ressources du theme (polices) suivent : sans elles, la copie d'inspection — dont le pack
  // simulateur et `dist/` sont tires — n'afficherait ni texte ni icones.
  copyTree(uiAppRessources, path.join(inspection, 'ui', 'node_modules'), {autoriserNodeModules: true});
  copyTree(SERVICE_DIR, path.join(inspection, 'service', serviceName));

  console.log(
    '[pack] ressources du theme : ui/node_modules (' +
      tailleArbre(uiAppRessources) +
      ' octets de polices, ' +
      compterFichiers(uiAppRessources) +
      ' fichier(s))'
  );
  console.log('[pack] paquet : ' + path.relative(ROOT, ipk) + ' (' + fs.statSync(ipk).size + ' octets)');
  if (SORTIE !== RELEASE) {
    console.log('[pack] paquet d essai : hors de release/ — ne pas publier (voir release/local/LISEZ-MOI-ESSAI.txt)');
  }
  console.log('[pack] contenu : ' + path.relative(ROOT, inspection));
  console.log('[pack] installation : ares-install --device <nom> ' + path.relative(ROOT, ipk));
  removeTree(staging);
}

main();
