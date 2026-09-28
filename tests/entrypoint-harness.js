'use strict';

/**
 * Banc d'essai du **point d'entrée du paquet** : simule les deux façons dont webOS peut charger le
 * fichier `main` du service — exécuté directement (`node index.js`) et chargé par `require()` depuis
 * un chargeur — et vérifie que dans les deux cas le service s'enregistre auprès du hub LS2 avec ses
 * onze commandes.
 *
 * C'est le test de non-régression du défaut « Service does not exist » : un démarrage placé derrière
 * `require.main === module` passe le premier cas et échoue au second.
 *
 * Rien n'est emprunté au dépôt : on reconstitue une copie du service dans un dossier temporaire, avec
 * un faux module `webos-service` (celui de la plateforme) qui consigne ce qu'on lui demande.
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var childProcess = require('child_process');

var SERVICE_DIR = path.join(__dirname, '..', 'service', 'com.ouagkamel.app.iptvplayer.service');

function removeTree(target) {
  if (!fs.existsSync(target)) return;
  fs.readdirSync(target).forEach(function (name) {
    var complet = path.join(target, name);
    if (fs.statSync(complet).isDirectory()) removeTree(complet);
    else fs.unlinkSync(complet);
  });
  fs.rmdirSync(target);
}

/** Création d'arborescence portable : `fs.mkdirSync(dir, {recursive:true})` date de Node 10.12 et
 * n'existe pas sur la cible Node 8.12 (le défaut n'apparaissait que dans la CI Node 8.12 — le
 * contrôle `npm run lint:node812` couvre désormais aussi `tests/`). */
function makeDirs(dir) {
  var parent = path.dirname(dir);
  if (parent && parent !== dir && !fs.existsSync(parent)) makeDirs(parent);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
}

function copyTree(from, to) {
  makeDirs(to);
  fs.readdirSync(from).forEach(function (name) {
    var source = path.join(from, name);
    var cible = path.join(to, name);
    if (fs.statSync(source).isDirectory()) copyTree(source, cible);
    else fs.copyFileSync(source, cible);
  });
}

/** Faux `webos-service` : enregistre le nom du service et les commandes dans un journal JSON. */
var STUB = [
  "'use strict';",
  "var fs = require('fs');",
  "var path = require('path');",
  "function Service(name) {",
  "  this.name = name;",
  "  this.commands = [];",
  "  this.journal = path.join(process.env.IPTV_STUB_JOURNAL);",
  "  this.write();",
  "}",
  "Service.prototype.write = function () {",
  "  fs.writeFileSync(this.journal, JSON.stringify({ name: this.name, commands: this.commands }));",
  "};",
  "Service.prototype.register = function (command) {",
  "  this.commands.push(command);",
  "  this.write();",
  "};",
  "Service.prototype.call = function () { return null; };",
  "module.exports = Service;",
  ''
].join('\n');

/**
 * Prépare une copie du service avec un faux `webos-service` installé à côté (comme la plateforme le
 * fournit sur la TV) et renvoie le chemin du dossier.
 */
function preparePackage(name) {
  var racine = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-entry-' + name + '-'));
  copyTree(SERVICE_DIR, path.join(racine, 'service'));
  var stubDir = path.join(racine, 'service', 'node_modules', 'webos-service');
  makeDirs(stubDir);
  fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({ name: 'webos-service', main: 'index.js' }));
  fs.writeFileSync(path.join(stubDir, 'index.js'), STUB);
  return path.join(racine, 'service');
}

/** Lance une commande node sur la copie du service et renvoie le journal du faux `webos-service`. */
function runEntry(serviceCopy, mode) {
  var journal = path.join(serviceCopy, '..', 'journal-' + mode + '.json');
  var script = mode === 'direct' ? 'index.js' : '-e';
  var args = mode === 'direct' ? [path.join(serviceCopy, 'index.js')] : ["require('" + serviceCopy + "/index.js')"];
  var outcome = childProcess.spawnSync(process.execPath, script === '-e' ? ['-e', args[0]] : args, {
    cwd: serviceCopy,
    env: Object.assign({}, process.env, { IPTV_STUB_JOURNAL: journal }),
    encoding: 'utf8'
  });
  return {
    journal: fs.existsSync(journal) ? JSON.parse(fs.readFileSync(journal, 'utf8')) : null,
    sortie: (outcome.stdout || '') + (outcome.stderr || ''),
    statut: outcome.status
  };
}

module.exports = {
  SERVICE_DIR: SERVICE_DIR,
  preparePackage: preparePackage,
  runEntry: runEntry,
  removeTree: removeTree
};
