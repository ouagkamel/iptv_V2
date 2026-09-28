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
var os = require('os');
var path = require('path');
var vm = require('vm');
var outilDist = require('../tools/make-dist');

var SERVICE_DIR = banc.SERVICE_DIR;
var APP_DIR = path.join(__dirname, '..', 'src', 'app');

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

  /**
   * Le hub lit `services.json` pour enregistrer le service : un fichier non ASCII est un risque
   * gratuit (un parseur qui ne suppose pas l'UTF-8 ne voit plus de JSON valide, et le service
   * devient « inconnu » du bus — exactement le symptôme « Service does not exist »).
   */
  harness.it('les manifestes du service sont en ASCII pur', function () {
    ['services.json', 'package.json'].forEach(function (nom) {
      var octets = fs.readFileSync(path.join(SERVICE_DIR, nom));
      var nonAscii = Array.prototype.filter.call(octets, function (octet) {
        return octet > 127;
      });
      assert.equal(nonAscii.length, 0, nom + ' ne contient que de l ASCII');
    });
    // et le manifeste reste un JSON valide, avec ses onze commandes non publiques
    var info = manifeste();
    assert.equal(info.services.length, 1, 'un service declare');
    assert.equal(info.services[0].commands.length, 11, 'onze commandes');
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

/**
 * Régression phase 0A : la page chargeait `webOSTV.js`, la bibliothèque du SDK LG, qui n'était pas
 * dans le paquet. La console de la TV répondait `net::ERR_FILE_NOT_FOUND webOSTV.js` et
 * `window.webOS` restait vide — plus aucun appel LS2 possible. Toute ressource référencée par la
 * page doit exister dans le paquet, et le pont LS2 embarqué doit remplacer la bibliothèque absente.
 */
harness.describe('Page du paquet : ressources présentes et pont LS2 embarqué', function () {
  var html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');

  /** Ressources locales (hors URL absolues, ancres et données en ligne) référencées par la page. */
  function ressourcesLocales() {
    var trouvees = [];
    var motif = /(?:src|href)\s*=\s*"([^"]+)"/g;
    var resultat = motif.exec(html);
    while (resultat) {
      var cible = resultat[1];
      if (!/^(?:[a-z]+:|\/\/|#|data:)/i.test(cible)) trouvees.push(cible);
      resultat = motif.exec(html);
    }
    return trouvees;
  }

  harness.it('aucune ressource referencee par la page ne manque dans le paquet', function () {
    var locales = ressourcesLocales();
    assert.ok(locales.length > 0, 'la page reference au moins un fichier local');
    locales.forEach(function (cible) {
      assert.equal(fs.existsSync(path.join(APP_DIR, cible)), true, 'fichier present dans le paquet : ' + cible);
    });
  });

  /**
   * Un fichier vidé par accident (ex. édition qui tronque) passerait tous les autres contrôles : la
   * page s'ouvrirait sur une coquille vide. Les scripts de la page doivent donc être **lisibles** et
   * **analysables**, pas seulement présents.
   */
  harness.it('les scripts de la page sont non vides et analysables', function () {
    ressourcesLocales().forEach(function (cible) {
      if (!/\.js$/.test(cible)) return;
      var source = fs.readFileSync(path.join(APP_DIR, cible), 'utf8');
      assert.ok(source.length > 500, 'script non vide : ' + cible + ' (' + source.length + ' octets)');
      new vm.Script(source, { filename: cible });
    });
  });

  harness.it('webOSTV.js n est plus referencee : le pont LS2 est embarque', function () {
    assert.equal(html.indexOf('webOSTV.js'), -1, 'aucun renvoi a la bibliotheque du SDK LG');
    assert.ok(ressourcesLocales().indexOf('webos-bridge.js') !== -1, 'webos-bridge.js charge par la page');
    assert.equal(
      html.indexOf('webos-bridge.js') < html.indexOf('diagnostic.js'),
      true,
      'le pont est charge avant la page de diagnostic'
    );
  });

  harness.it('le pont expose webOS.service.request et route les reponses du bus', function () {
    var ponts = [];
    function FauxPont() {
      ponts.push(this);
      this.appels = [];
    }
    FauxPont.prototype.call = function (uri, charge) {
      this.appels.push({ uri: uri, charge: charge });
    };
    var fenetre = {
      setTimeout: setTimeout,
      console: console,
      PalmServiceBridge: FauxPont,
      PalmSystem: {
        platformBack: function () {
          fenetre.retourRecu = true;
        }
      }
    };
    fenetre.window = fenetre;
    vm.runInContext(fs.readFileSync(path.join(APP_DIR, 'webos-bridge.js'), 'utf8'), vm.createContext(fenetre), {
      filename: 'webos-bridge.js'
    });

    assert.equal(fenetre.webOS.__pont.chemin, 'PalmServiceBridge', 'chemin retenu par le pont');
    assert.equal(typeof fenetre.webOS.service.request, 'function', 'webOS.service.request presente');

    var recues = [];
    fenetre.webOS.service.request('luna://com.example.svc', {
      method: 'ping',
      parameters: { a: 1 },
      onSuccess: function (reponse) {
        recues.push(reponse);
      }
    });
    assert.equal(ponts.length, 1, 'un appel emis vers le pont bas niveau');
    assert.equal(ponts[0].appels[0].uri, 'luna://com.example.svc/ping', 'uri et methode composees');
    assert.deepEqual(JSON.parse(ponts[0].appels[0].charge), { a: 1 }, 'parametres transmis tels quels');
    ponts[0].onservicecallback(JSON.stringify({ returnValue: true, ok: 1 }));
    assert.equal(recues.length, 1, 'onSuccess appele sur reponse valide');

    var echecs = [];
    fenetre.webOS.service.request('luna://com.example.svc', {
      method: 'ping',
      onFailure: function (erreur) {
        echecs.push(erreur);
      }
    });
    ponts[1].onservicecallback(JSON.stringify({ returnValue: false, errorCode: -1, errorText: 'Service does not exist: com.example.svc.' }));
    assert.equal(echecs.length, 1, 'onFailure appele sur returnValue false');
    assert.equal(echecs[0].errorText.indexOf('Service does not exist') === 0, true, 'message brut conserve');

    var messages = [];
    var abonnement = fenetre.webOS.service.request('luna://com.example.svc', {
      method: 'suivre',
      subscribe: true,
      onSuccess: function (reponse) {
        messages.push(reponse);
      }
    });
    assert.equal(JSON.parse(ponts[2].appels[0].charge).subscribe, true, 'abonnement transmis au bus');
    ponts[2].onservicecallback(JSON.stringify({ returnValue: true, n: 1 }));
    ponts[2].onservicecallback(JSON.stringify({ returnValue: true, n: 2 }));
    assert.equal(messages.length, 2, 'les deux messages de l abonnement sont livres');
    abonnement.cancel();

    fenetre.webOS.platformBack();
    assert.equal(fenetre.retourRecu, true, 'touche retour relayee a la plateforme');
  });

  harness.it('le pont ne remplace pas un webOS fourni par la plateforme', function () {
    var plateforme = {
      service: {
        request: function () {
          return null;
        }
      },
      marqueur: 'plateforme'
    };
    var contexte = vm.createContext({ webOS: plateforme });
    vm.runInContext(fs.readFileSync(path.join(APP_DIR, 'webos-bridge.js'), 'utf8'), contexte, {
      filename: 'webos-bridge.js'
    });
    var apres = contexte.webOS;
    assert.equal(apres.marqueur, 'plateforme', 'objet de la plateforme conserve');
    assert.equal(apres.service.request, plateforme.service.request, 'request de la plateforme non remplacee');
    assert.equal(apres.__pont.chemin, 'webos-service', 'chemin plateforme signale');
    assert.equal(apres.__pont.fourniParLaPlateforme, true, 'origine signalee');
  });
});

/**
 * Régression : `dist/app/` était constitué d'une **liste de noms** écrite à la main
 * (`appinfo.json`, `index.html`, `diagnostic.js`) — `webos-bridge.js` a donc été livré dans
 * l'`.ipk` mais **absent de l'archive `dist/`**. La copie doit être exhaustive, par construction.
 */
harness.describe('Livraison dist : copie exhaustive de l application', function () {
  function creerDossier(chemin) {
    var parent = path.dirname(chemin);
    if (parent !== chemin && !fs.existsSync(parent)) creerDossier(parent);
    if (!fs.existsSync(chemin)) fs.mkdirSync(chemin);
  }

  harness.it('un fichier inconnu du script est copie dans dist/app', function () {
    var racine = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-dist-'));
    var inspection = path.join(racine, 'package');
    var dossier = path.join(racine, '9.9.9');
    var ecritures = [
      ['appinfo.json', '{"id":"com.exemple.app"}'],
      ['index.html', '<script src="nouveau-fichier.js"></script>'],
      ['diagnostic.js', '// page'],
      ['nouveau-fichier.js', '// fichier ajoute apres coup'],
      ['assets/icone.png', 'png'],
      ['service/com.exemple.app.service/services.json', '{"services":[]}'],
      ['service/com.exemple.app.service/index.js', "require('webos-service');"]
    ];
    ecritures.forEach(function (paire) {
      var cible = path.join(inspection, paire[0]);
      creerDossier(path.dirname(cible));
      fs.writeFileSync(cible, paire[1]);
      // la cible ne doit pas exister avant la copie
      var copie = path.join(paire[0].indexOf('service/') === 0 ? dossier : path.join(dossier, 'app'), paire[0].replace(/^service\//, ''));
      assert.equal(fs.existsSync(copie), false, 'non present avant copie : ' + paire[0]);
    });

    outilDist.copierArborescence(inspection, dossier);

    ecritures.forEach(function (paire) {
      var relatif = paire[0].indexOf('service/') === 0 ? paire[0] : path.join('app', paire[0]);
      var copie = path.join(dossier, relatif);
      assert.equal(fs.existsSync(copie), true, 'copie presente : ' + relatif);
      assert.equal(fs.readFileSync(copie, 'utf8'), paire[1], 'contenu identique : ' + relatif);
    });
    assert.equal(
      fs.readdirSync(path.join(dossier, 'app')).indexOf('service'),
      -1,
      'le service ne se retrouve pas dans app/'
    );

    banc.removeTree(racine);
  });

  harness.it('le script exporte la copie sans se construire au chargement', function () {
    // le chargement de `tools/make-dist.js` par ce test ne doit ni compiler, ni appeler ares-package :
    // seule la fonction de copie est exportee, le reste vit derriere `require.main === module`
    assert.equal(typeof outilDist.copierArborescence, 'function', 'fonction de copie exportee');
    assert.deepEqual(Object.keys(outilDist).sort(), ['copierArborescence'], 'aucun autre export');
  });
});
