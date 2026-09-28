'use strict';

/**
 * Contrôle des dépendances (§2.3, §11.1).
 *
 * Discipline du projet : **zéro dépendance d'exécution**. Le service est empaqueté sans
 * `node_modules` et tourne sur le Node 8.12 embarqué ; une dépendance transitive qui utilise une
 * API postérieure (Brotli, `fs.promises`, `for await`…) casserait la TV sans casser la CI locale.
 * Les `devDependencies` ne sont jamais empaquetées et restent autorisées.
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

var lockPath = path.join(ROOT, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  var lock = readJson(lockPath);
  var packages = lock.packages || {};
  Object.keys(packages).forEach(function (key) {
    if (!key || key === '') return;
    var entry = packages[key];
    var isRoot = key === '';
    if (isRoot) return;
    var isDev = entry.dev === true || entry.devOptional === true;
    if (!isDev && Object.keys(entry.dependencies || {}).length > 0) {
      problems.push('lockfile : ' + key + ' est une dépendance d\'exécution');
    }
  });
}

var nmDir = path.join(ROOT, 'node_modules');
if (fs.existsSync(nmDir)) {
  var top = fs.readdirSync(nmDir).filter(function (name) {
    return name.charAt(0) !== '.';
  });
  var devDeps = Object.keys(rootPkg.devDependencies || {}).map(function (name) {
    return name.replace(/^@/, '').replace(/[/].*$/, '');
  });
  top.forEach(function (name) {
    var base = name.replace(/^@/, '');
    var allowed = devDeps.some(function (devDep) {
      return name === devDep || base.indexOf(devDep) === 0 || devDep.indexOf(base) === 0;
    });
    if (!allowed) {
      problems.push('node_modules : paquet non devDependency (' + name + ')');
    }
  });
}

if (problems.length > 0) {
  console.error('Controle des dependances : ' + problems.length + ' probleme(s)');
  problems.forEach(function (problem) {
    console.error('  - ' + problem);
  });
  process.exit(1);
}
console.log('Controle des dependances : OK (zero dependance d\'execution)');
