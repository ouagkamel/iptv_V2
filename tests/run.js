'use strict';

/**
 * Exécute toute la suite de tests. Le service compilé (`service/.../lib`) est la cible testée :
 * les tests ne testent pas la source TypeScript mais l'artefact réellement empaqueté.
 */

var fs = require('fs');
var path = require('path');
var harness = require('./harness');

var libDir = path.join(__dirname, '..', 'service', 'com.ouagkamel.app.iptvplayer.service', 'lib');
if (!fs.existsSync(libDir)) {
  console.error('Service non compile. Executer : npm run build:service');
  process.exit(1);
}

var files = fs.readdirSync(__dirname).filter(function (name) {
  return /\.test\.js$/.test(name);
}).sort();

files.forEach(function (name) {
  require(path.join(__dirname, name));
});

var outcome = harness.run();
if (outcome && typeof outcome.then === 'function') {
  // les tests asynchrones impriment le bilan eux-memes ; on absorbe un rejet eventuel
  outcome.then(function () {}, function (err) {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}
