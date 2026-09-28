'use strict';

/**
 * Contrôle de compatibilité Node 8.12 (§2.3, §11.1).
 *
 * Le service tourne sur le Node 8.12 embarqué de webOS 6 : une API apparue plus tard compile
 * parfaitement et échoue **sur la TV**. Ce contrôle échoue donc le build lorsqu'une API interdite
 * apparaît — dans la source TypeScript comme dans l'artefact compilé, y compris via une dépendance.
 *
 * Cible : `crypto.createHmac`, `fs` synchrone/asynchrone (sans `fs.promises`), `Buffer`,
 * `JSON`, `Date`, `Math`, `Promise`, `async/await`, `class`, `Map/Set`.
 * Interdits : `fs.promises`, `for await`, `stream.pipeline`, Brotli, `worker_threads`,
 * `Promise.allSettled`, `Object.fromEntries`, `Array.prototype.flat/flatMap`, `String.matchAll`,
 * `String.replaceAll`, `Array.prototype.at`, `globalThis`, `structuredClone`, `AbortController`,
 * et `TextEncoder` global (disponible seulement via `util` en Node 8).
 */

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var SCAN_DIRS = ['src/service', 'src/core', 'src/contracts'];
var BUILD_DIR = path.join(ROOT, 'service', 'com.ouagkamel.app.iptvplayer.service', 'lib');

var BANNED = [
  { pattern: /\bfs\.promises\b/, reason: 'fs.promises apparait en Node 10.1' },
  { pattern: /\bfor\s+await\b/, reason: 'for await apparait en Node 10.0' },
  { pattern: /\bstream\.pipeline\b/, reason: 'stream.pipeline apparait en Node 10.0' },
  { pattern: /\bstream\/promises\b/, reason: 'stream/promises n\'existe pas en Node 8' },
  { pattern: /createBrotliDecompress|createBrotliCompress/, reason: 'Brotli apparait en Node 10.16' },
  { pattern: /require\(['"]worker_threads['"]\)/, reason: 'worker_threads n\'existe pas en Node 8.12' },
  { pattern: /\bPromise\.allSettled\b/, reason: 'Promise.allSettled apparait en Node 12.9' },
  { pattern: /\bPromise\.any\b/, reason: 'Promise.any apparait en Node 15' },
  { pattern: /\bObject\.fromEntries\b/, reason: 'Object.fromEntries apparait en Node 12' },
  { pattern: /\.flatMap\(/, reason: 'Array.prototype.flatMap apparait en Node 11' },
  { pattern: /\.flat\(/, reason: 'Array.prototype.flat apparait en Node 11' },
  { pattern: /\.matchAll\(/, reason: 'String.prototype.matchAll apparait en Node 12' },
  { pattern: /\.replaceAll\(/, reason: 'String.prototype.replaceAll apparait en Node 15' },
  { pattern: /\.at\(-?\d+\)/, reason: 'Array.prototype.at apparait en Node 16,5' },
  { pattern: /\bglobalThis\b/, reason: 'globalThis apparait en Node 12' },
  { pattern: /\bstructuredClone\b/, reason: 'structuredClone apparait en Node 17' },
  { pattern: /\bAbortController\b/, reason: 'AbortController global apparait en Node 15' },
  { pattern: /\bnew TextEncoder\b/, reason: 'TextEncoder global apparait en Node 11 (en Node 8 : require("util").TextEncoder)' },
  { pattern: /\bnavigator\.clipboard\b/, reason: 'API navigateur absente du service' },
  { pattern: /crypto\.hkdf\b/, reason: 'crypto.hkdf apparait en Node 15 (implémentation locale requise)' },
  { pattern: /\brequire\(['"][^.'"][^'"]*['"]\)/, reason: 'dépendance externe : le service doit rester sans dépendance d\'exécution' }
];

/** Modules Node autorisés dans l'artefact (tous présents en 8.12). */
var ALLOWED_MODULES = [
  'crypto', 'fs', 'path', 'url', 'http', 'https', 'zlib', 'os', 'util', 'events', 'stream',
  'net', 'tls', 'querystring', 'string_decoder', 'assert', 'buffer', 'child_process'
];

/**
 * Retire commentaires de bloc et de ligne avant l'analyse : une explication citant une API
 * interdite (« `crypto.hkdf` n'existe qu'a partir de Node 15 ») n'est pas un usage.
 * Implémentation volontairement simple (pas de lookbehind : Node 8 ne le supporte pas).
 */
function stripComments(source) {
  var out = '';
  var inBlock = false;
  var inLine = false;
  var quote = null;
  for (var i = 0; i < source.length; i++) {
    var ch = source[i];
    var next = source[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      } else out += ' ';
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        out += '  ';
        i += 1;
      } else out += ch === '\n' ? ch : ' ';
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next === undefined ? '' : next;
        i += 1;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      out += '  ';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      out += '  ';
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

var SUPPRESS = 'node812-compat-disable-next-line';

function listFiles(dir, extensions) {
  var out = [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir).forEach(function (name) {
    var full = path.join(dir, name);
    var stat = fs.statSync(full);
    if (stat.isDirectory()) out = out.concat(listFiles(full, extensions));
    else if (!extensions || extensions.indexOf(path.extname(name)) !== -1) out.push(full);
  });
  return out;
}

var problems = [];

SCAN_DIRS.forEach(function (dir) {
  listFiles(path.join(ROOT, dir), ['.ts', '.js']).forEach(function (file) {
    var rawLines = fs.readFileSync(file, 'utf8').split('\n');
    var source = stripComments(rawLines.join('\n'));
    var relative = path.relative(ROOT, file);
    var lines = source.split('\n');
    BANNED.forEach(function (rule) {
      lines.forEach(function (line, index) {
        if (rule.pattern.test(line) && (rawLines[index] || '').indexOf(SUPPRESS) === -1 && (rawLines[index - 1] || '').indexOf(SUPPRESS) === -1) {
          problems.push(relative + ':' + (index + 1) + ' — ' + rule.reason + ' : ' + (rawLines[index] || '').trim().slice(0, 120));
        }
      });
    });
  });
});

/* L'artefact empaqueté est contrôlé séparément : c'est lui qui s'exécute sur la TV. */
if (fs.existsSync(BUILD_DIR)) {
  listFiles(BUILD_DIR, ['.js']).forEach(function (file) {
    var source = stripComments(fs.readFileSync(file, 'utf8'));
    var relative = path.relative(ROOT, file);
    BANNED.forEach(function (rule) {
      if (rule.reason.indexOf('dépendance externe') !== -1) return; // traité ci-dessous
      source.split('\n').forEach(function (line, index) {
        if (rule.pattern.test(line)) {
          problems.push(relative + ':' + (index + 1) + ' — ' + rule.reason + ' : ' + line.trim().slice(0, 120));
        }
      });
    });
    var requireRe = /require\(["']([^"']+)["']\)/g;
    var match;
    while ((match = requireRe.exec(source)) !== null) {
      var moduleName = match[1];
      if (moduleName.charAt(0) === '.') continue;
      var base = moduleName.split('/')[0];
      if (ALLOWED_MODULES.indexOf(base) === -1) {
        problems.push(relative + ' — module externe ' + moduleName + ' interdit dans le service (zéro dépendance d\'exécution, §2.3)');
      }
    }
  });
} else {
  console.log('[info] artefact non compilé : executer `npm run build:service` pour le controle du bundle');
}

if (problems.length > 0) {
  console.error('Controle Node 8.12 : ' + problems.length + ' probleme(s)');
  problems.forEach(function (problem) {
    console.error('  - ' + problem);
  });
  process.exit(1);
}
console.log('Controle Node 8.12 : OK (source + artefact compile)');
