#!/usr/bin/env node
'use strict';

/**
 * Assemble le dossier `dist/` livrable : le `.ipk`, son contenu dépaqueté, les sommes de contrôle et
 * un `LISEZ-MOI`, puis l'archive `dist/<version>.zip` prête à être téléchargée (ou attachée à une
 * publication GitHub).
 *
 * `release/` reste le dossier de travail du paquetage ; `dist/` est la **livraison** :
 *
 *   dist/
 *     <version>/
 *       com.ouagkamel.app.iptvplayer_<version>_all.ipk
 *       app/                                   (application web empaquetée)
 *       service/<id de service>/               (service compilé + services.json)
 *       SHA256SUMS.txt
 *       LISEZ-MOI.txt
 *     <version>.zip                            (archive de ce dossier)
 *
 * Prérequis : `ares-package` (outillage LG) — voir `tools/make-package.js`.
 *
 * L'arborescence `app/` de la livraison est copiée **en entier** depuis le contenu empaqueté : une
 * liste de noms écrite à la main oublie silencieusement tout fichier ajouté ensuite (cas rencontré
 * avec `webos-bridge.js`, absent de `dist/` alors qu'il était dans l'`.ipk`).
 */

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var RELEASE = path.join(ROOT, 'release');
var DIST = path.join(ROOT, 'dist');

function fail(message) {
  console.error('[dist] ' + message);
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
    var source = path.join(from, name);
    var cible = path.join(to, name);
    if (fs.statSync(source).isDirectory()) copyTree(source, cible);
    else fs.copyFileSync(source, cible);
  });
}

function sha256(file) {
  var crypto = require('crypto');
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function newestIpk() {
  if (!fs.existsSync(RELEASE)) return null;
  var candidats = fs
    .readdirSync(RELEASE)
    .filter(function (name) {
      return /\.ipk$/.test(name);
    })
    .map(function (name) {
      return path.join(RELEASE, name);
    });
  if (candidats.length === 0) return null;
  return candidats.sort(function (a, b) {
    return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
  })[0];
}

function lireRecu(file) {
  return fs.readFileSync(file, 'utf8');
}

/**
 * Copie le contenu empaqueté dans le dossier livrable : **tous** les fichiers de l'application (le
 * dossier `service/` mis à part, qui va dans `service/`) puis le service compilé. Aucune liste de
 * noms : tout fichier ajouté à l'application se retrouve dans `dist/` sans intervention.
 */
function copierArborescence(inspection, dossier) {
  var dossierApp = path.join(dossier, 'app');
  creerDossiers(dossierApp);
  fs.readdirSync(inspection).forEach(function (nom) {
    var source = path.join(inspection, nom);
    if (nom === 'service') return;
    if (fs.statSync(source).isDirectory()) copyTree(source, path.join(dossierApp, nom));
    else fs.copyFileSync(source, path.join(dossierApp, nom));
  });
  var service = path.join(inspection, 'service');
  if (fs.existsSync(service)) copyTree(service, path.join(dossier, 'service'));
}

function main() {
  var appinfo = JSON.parse(lireRecu(path.join(ROOT, 'appinfo.json')));
  var version = appinfo.version;

  // 1) le paquet d'abord : `make-package.js` compile le service si besoin et appelle ares-package
  var paquetage = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'make-package.js')], { stdio: 'inherit' });
  if (paquetage.status !== 0) fail('empaquetage impossible (voir les messages ci-dessus)');

  var ipk = newestIpk();
  if (!ipk) fail('aucun .ipk dans ' + RELEASE);

  // 2) arborescence livrable
  var dossier = path.join(DIST, version);
  if (fs.existsSync(dossier)) removeTree(dossier);
  creerDossiers(dossier);
  fs.copyFileSync(ipk, path.join(dossier, path.basename(ipk)));

  var inspection = path.join(RELEASE, 'package');
  if (fs.existsSync(inspection)) copierArborescence(inspection, dossier);

  var lignes = [
    '# Paquet de diagnostic — phase 0A',
    '',
    'Ce dossier est la livraison du depot `iptv_V2` pour la version ' + version + ' :',
    'le **service webOS complet** (protocole LS2, reseau, DB8, import reprenable) et une page de',
    'diagnostic telecommandable, sans interface Enact (elle arrive a l etape 3).',
    '',
    '## Contenu',
    '',
    '- `' + path.basename(ipk) + '` : le paquet installable sur la TV ;',
    '- `app/` : l application web telle qu elle est empaquetee (appinfo.json, page, visuels) ;',
    '- `service/` : le service compile (services.json, package.json, lib/, assets/roots.pem) ;',
    '- `SHA256SUMS.txt` : empreintes des fichiers de ce dossier.',
    '',
    '## Installation (TV en mode developpeur)',
    '',
    '    npm i -g @webosose/ares-cli',
    '    ares-setup-device --add tv --info "host=<IP de la TV>" --passphrase',
    '    ares-install --device tv ' + path.basename(ipk),
    '    ares-launch  --device tv ' + appinfo.id,
    '',
    '## Ce qui se verifie ensuite',
    '',
    'Dans la page : Diagnostic du service (Node 8.12, OpenSSL du firmware, racines), test de source,',
    'import live (phases jusqu a `done`), page/tranches/detail, resolution de flux, suppression de',
    'profil. La sequence complete avec la preuve attendue a chaque etape est dans',
    '`docs/PHASE-0.md` §0A. Le lecteur `<video>` et les ecrans de l interface ne sont pas encore',
    'livres : ils relevent des etapes 3 et de la phase 0B.',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(dossier, 'LISEZ-MOI.txt'), lignes, 'utf8');

  var fichiers = [];
  (function parcourir(depot) {
    fs.readdirSync(depot).forEach(function (nom) {
      var complet = path.join(depot, nom);
      if (fs.statSync(complet).isDirectory()) parcourir(complet);
      else fichiers.push(path.relative(dossier, complet).split(path.sep).join('/'));
    });
  })(dossier);
  var sommes = fichiers
    .sort()
    .map(function (relatif) {
      return sha256(path.join(dossier, relatif)) + '  ' + relatif;
    })
    .join('\n');
  fs.writeFileSync(path.join(dossier, 'SHA256SUMS.txt'), sommes + '\n', 'utf8');

  // 3) archive livrable : zip si disponible, sinon tar.gz
  var archive;
  var nomBase = path.join(DIST, version);
  if (fs.existsSync(path.join(dossier, 'SHA256SUMS.txt'))) {
    /* les sommes sont ecrites avant l archive : elles ne se contiennent pas elles-memes */
  }
  var zip = childProcess.spawnSync('zip', ['-qr', nomBase + '.zip', version], { cwd: DIST, stdio: 'inherit' });
  if (zip.status === 0 && fs.existsSync(nomBase + '.zip')) {
    archive = nomBase + '.zip';
  } else {
    var tar = childProcess.spawnSync('tar', ['-czf', nomBase + '.tar.gz', version], { cwd: DIST, stdio: 'inherit' });
    if (tar.status !== 0) fail('ni zip ni tar disponibles pour archiver dist/' + version);
    archive = nomBase + '.tar.gz';
  }

  console.log('[dist] dossier  : ' + path.relative(ROOT, dossier));
  console.log('[dist] paquet   : ' + path.relative(ROOT, ipk) + ' (' + fs.statSync(ipk).size + ' octets)');
  console.log('[dist] sha256   : ' + sha256(ipk));
  console.log('[dist] archive  : ' + path.relative(ROOT, archive) + ' (' + fs.statSync(archive).size + ' octets)');
}

/* Exécution directe seulement : `require()` depuis les tests ne doit rien construire. */
if (require.main === module) main();

module.exports = { copierArborescence: copierArborescence };
