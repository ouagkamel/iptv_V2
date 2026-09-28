'use strict';

/**
 * Conformité du **paquet** (pas seulement du code) : le service s'enregistre auprès du hub LS2 quel
 * que soit le mode de chargement du fichier `main`, les commandes déclarées dans `services.json`
 * correspondent à celles réellement enregistrées, et le paquet porte le nom que l'application
 * appelle.
 *
 * Le cas « chargé par `require()` » est le test de non-régression du défaut « Service does not
 * exist » rencontré en phase 0A.
 */

var assert = require('./assert');
var harness = require('./harness');
var banc = require('./entrypoint-harness');
var fs = require('fs');
var path = require('path');

var SERVICE_DIR = banc.SERVICE_DIR;

/** Retire commentaires de bloc et de ligne : on contrôle le code, pas la documentation. */
function sansCommentaires(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (ligne) {
    return ligne.trim().indexOf('//') !== 0;
  }).join('\n');
}

function manifeste() {
  return JSON.parse(fs.readFileSync(path.join(SERVICE_DIR, 'services.json'), 'utf8'));
}

harness.describe('Paquet du service : enregistrement et manifeste (§2.6, §15.4)', function () {
  harness.it('le service s enregistre quand la plateforme execute le fichier main', function () {
    var copie = banc.preparePackage('direct');
    var resultat = banc.runEntry(copie, 'direct');
    assert.ok(resultat.journal, 'le service s est enregistre (journal du faux webos-service present)');
    assert.equal(resultat.journal.name, 'com.ouagkamel.app.iptvplayer.service', 'nom du service declare au hub');
    var declarees = manifeste().services[0].commands.map(function (command) {
      return command.name;
    });
    assert.deepEqual(resultat.journal.commands.slice().sort(), declarees.slice().sort(), 'commandes enregistrees = commandes declarees');
    assert.equal(resultat.journal.commands.length, 11, 'onze commandes');
    banc.removeTree(path.join(copie, '..'));
  });

  harness.it('le service s enregistre aussi quand la plateforme le charge par require()', function () {
    var copie = banc.preparePackage('require');
    var resultat = banc.runEntry(copie, 'require');
    assert.ok(
      resultat.journal,
      'le service doit s enregistrer meme charge par require() : ' + resultat.sortie.trim().slice(0, 200)
    );
    assert.equal(resultat.journal.name, 'com.ouagkamel.app.iptvplayer.service', 'nom du service declare au hub');
    assert.equal(resultat.journal.commands.length, 11, 'onze commandes enregistrees');
    banc.removeTree(path.join(copie, '..'));
  });

  harness.it('le manifeste du paquet est coherent : nom, dossier et prefixe de l application', function () {
    var info = manifeste();
    var service = info.services[0];
    var dossier = path.basename(SERVICE_DIR);
    assert.equal(service.name, dossier, 'le nom du service est celui de son dossier');
    assert.equal(info.id, service.name, 'l identifiant du manifeste est le nom du service');
    assert.ok(service.name.indexOf('com.ouagkamel.app.iptvplayer') === 0, 'prefixed par l identifiant de l application');
    assert.equal(service.commands.every(function (command) {
      return command.public === false;
    }), true, 'aucune commande publique');
    var appinfo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'appinfo.json'), 'utf8'));
    assert.ok(service.name.indexOf(appinfo.id + '.') === 0, 'le service appartient bien a l application empaquetee');
  });

  harness.it('le point d entree du paquet est en JavaScript brut et sans dependance installee', function () {
    var paquet = JSON.parse(fs.readFileSync(path.join(SERVICE_DIR, 'package.json'), 'utf8'));
    assert.equal(paquet.main, 'index.js', 'main = index.js');
    var entree = sansCommentaires(fs.readFileSync(path.join(SERVICE_DIR, paquet.main), 'utf8'));
    assert.ok(entree.indexOf('bootstrap') !== -1, 'l entree appelle le demarrage du service compile');
    assert.equal(entree.indexOf('require.main'), -1, 'aucun demarrage conditionne par require.main');
    assert.equal(/require\((['"])[^./]/.test(entree), false, 'aucune dependance installee dans l entree');
    assert.equal(paquet.dependencies && Object.keys(paquet.dependencies).length, 0, 'aucune dependance declaree');
    assert.deepEqual(Object.keys(paquet).sort(), ['description', 'dependencies', 'main', 'name', 'private', 'version'].sort(), 'champs du package.json du service');
  });
});
