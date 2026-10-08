'use strict';

/**
 * Contrôle des dépendances (§2.3, §11.1).
 *
 * Discipline du projet : **zéro dépendance d'exécution**. Le service est empaqueté sans
 * `node_modules` et tourne sur le Node 8.12 embarqué ; une dépendance transitive qui utilise une
 * API postérieure (Brotli, `fs.promises`, `for await`…) casserait la TV sans casser la CI locale.
 * Les `devDependencies` — et donc leur arbre de dépendances — ne sont jamais empaquetées : elles
 * restent autorisées (`typescript`, `jsdom` pour le banc d'essai de l'interface).
 */

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var problems = [];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

var rootPkg = readJson(path.join(ROOT, 'package.json'));
var runtimeDeps = Object.keys(rootPkg.dependencies || {});
if (runtimeDeps.length > 0) {
  problems.push('package.json : dépendances d\'exécution déclarées (' + runtimeDeps.join(', ') + ')');
}

var servicePkgPath = path.join(ROOT, 'service', 'com.ouagkamel.app.iptvplayer.service', 'package.json');
if (fs.existsSync(servicePkgPath)) {
  var servicePkg = readJson(servicePkgPath);
  var serviceDeps = Object.keys(servicePkg.dependencies || {});
  if (serviceDeps.length > 0) {
    problems.push('service/package.json : dépendances déclarées (' + serviceDeps.join(', ') + ')');
  }
}

// Le lockfile est la référence : npm le marque « dev » pour tout ce qui vient des devDependencies.
// Une seule entrée non marquée « dev » (hors racine) serait une dépendance d'exécution — donc une
// brique qui serait empaquetée vers la TV et devrait tenir sur Node 8.12.
var lockPath = path.join(ROOT, 'package-lock.json');
var packages = {};
if (fs.existsSync(lockPath)) {
  packages = readJson(lockPath).packages || {};
  Object.keys(packages).forEach(function (key) {
    if (!key || key === '') return;
    var entry = packages[key];
    if (entry.dev === true || entry.devOptional === true) return;
    problems.push('lockfile : ' + key + ' est une dépendance d\'exécution (' + Object.keys(entry.dependencies || {}).length + ' dépendance(s) déclarée(s))');
  });
}

// `node_modules` : chaque brique présente doit venir du lockfile et y être marquée « dev ». Le
// contrôle porte sur le lockfile, pas sur le préfixe du nom — l'arbre des devDependencies (par
// exemple `jsdom` pour le banc d'essai de l'interface) est légitime et n'est jamais empaqueté.
var nmDir = path.join(ROOT, 'node_modules');
if (fs.existsSync(nmDir)) {
  var top = fs.readdirSync(nmDir).filter(function (name) {
    return name.charAt(0) !== '.';
  });
  var noms = [];
  top.forEach(function (name) {
    if (name.charAt(0) === '@') {
      // portée : chaque paquet est listé sous `node_modules/@portee/paquet`
      fs.readdirSync(path.join(nmDir, name)).forEach(function (paquet) {
        noms.push(name + '/' + paquet);
      });
      return;
    }
    noms.push(name);
  });
  noms.forEach(function (name) {
    var entry = packages['node_modules/' + name];
    if (!entry) {
      problems.push('node_modules : paquet absent du lockfile (' + name + ')');
      return;
    }
    if (entry.dev !== true && entry.devOptional !== true) {
      problems.push('node_modules : paquet d\'exécution installé (' + name + ')');
    }
  });
  if (Object.keys(packages).length === 0) {
    problems.push('node_modules présent sans lockfile : impossible de distinguer exécution et outillage');
  }
}

if (problems.length > 0) {
  console.error('Controle des dependances : ' + problems.length + ' probleme(s)');
  problems.forEach(function (problem) {
    console.error('  - ' + problem);
  });
  process.exit(1);
}
console.log('Controle des dependances : OK (zero dependance d\'execution)');
