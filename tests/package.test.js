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
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var vm = require('vm');
var outilDist = require('../tools/make-dist');
var outilSimulateur = require('../tools/stage-simulator');
var formatLib = require('../src/app/format');
var mainLib = require(path.join(
  __dirname,
  '..',
  'service',
  'com.ouagkamel.app.iptvplayer.service',
  'lib',
  'service',
  'main'
));

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
    assert.equal(resultat.journal.commands.length, 12, 'douze commandes');
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
    assert.equal(resultat.journal.commands.length, 12, 'douze commandes enregistrees');
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
    // et le manifeste reste un JSON valide, avec ses douze commandes non publiques
    var info = manifeste();
    assert.equal(info.services.length, 1, 'un service declare');
    assert.equal(info.services[0].commands.length, 12, 'douze commandes');
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
  // La page de diagnostic a demenage en `diagnostic.html` quand l'interface Enact est devenue
  // l'entree de l'application (`index.html`) : c'est elle qui porte le pont LS2 et le formulaire.
  var html = fs.readFileSync(path.join(APP_DIR, 'diagnostic.html'), 'utf8');

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

/**
 * Le **simulateur** n'installe pas de `.ipk` : il lance l'application depuis un dossier et n'accepte
 * un service que s'il est ajouté explicitement (menu *File > Add Service*). Le pack simulateur doit
 * donc présenter deux racines sélectionnables — et le mode d'emploi avec, sinon le symptôme observé
 * (« Service does not exist » alors que l'application tourne) se reproduit.
 */
harness.describe('Pack simulateur : racines sélectionnables et mode d emploi', function () {
  /** Création d'arborescence portable (`mkdirSync` récursif date de Node 10.12 : hors cible). */
  function dossiers(dir) {
    var parent = path.dirname(dir);
    if (parent !== dir && !fs.existsSync(parent)) dossiers(parent);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  }

  function ecrire(racine, relatif, contenu) {
    var cible = path.join(racine, relatif);
    dossiers(path.dirname(cible));
    fs.writeFileSync(cible, contenu);
  }

  harness.it('app/ et service/<id>/ sont produits a partir du contenu empaquete', function () {
    var racine = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-simu-'));
    var inspection = path.join(racine, 'package');
    var cible = path.join(racine, 'simulator');
    ecrire(inspection, 'appinfo.json', '{"id":"com.exemple.app","main":"index.html","version":"9.9.9"}');
    ecrire(inspection, 'index.html', '<script src="webos-bridge.js"></script><script src="diagnostic.js"></script>');
    ecrire(inspection, 'webos-bridge.js', '// pont');
    ecrire(inspection, 'diagnostic.js', '// page');
    ecrire(inspection, 'assets/icone.png', 'png');
    ecrire(inspection, 'service/com.exemple.app.service/package.json', '{"name":"com.exemple.app.service","main":"index.js"}');
    ecrire(inspection, 'service/com.exemple.app.service/services.json', '{"services":[{"name":"com.exemple.app.service"}]}');
    ecrire(inspection, 'service/com.exemple.app.service/index.js', "require('./lib/service/main');");
    ecrire(inspection, 'service/com.exemple.app.service/lib/service/main.js', 'exports.bootstrap = function () {};');

    outilSimulateur.preparerPackSimulateur(inspection, cible);

    // racine d'application : appinfo.json et le fichier `main` qu'il designe, cote a cote
    var appRoot = path.join(cible, 'app');
    assert.equal(fs.existsSync(path.join(appRoot, 'appinfo.json')), true, 'appinfo.json a la racine de app/');
    var appinfo = JSON.parse(fs.readFileSync(path.join(appRoot, 'appinfo.json'), 'utf8'));
    assert.equal(fs.existsSync(path.join(appRoot, appinfo.main)), true, 'fichier main present a cote d appinfo.json');
    assert.equal(fs.existsSync(path.join(appRoot, 'webos-bridge.js')), true, 'pont embarque livre');
    assert.equal(fs.existsSync(path.join(appRoot, 'assets')), true, 'visuels livres');
    assert.equal(fs.existsSync(path.join(appRoot, 'service')), false, 'le service n est pas dans app/');

    // racine de service : package.json + services.json + main
    var serviceRoot = path.join(cible, 'service', 'com.exemple.app.service');
    var paquet = JSON.parse(fs.readFileSync(path.join(serviceRoot, 'package.json'), 'utf8'));
    assert.equal(fs.existsSync(path.join(serviceRoot, paquet.main)), true, 'main du service present');
    var manifesteSimu = JSON.parse(fs.readFileSync(path.join(serviceRoot, 'services.json'), 'utf8'));
    assert.equal(manifesteSimu.services[0].name, paquet.name, 'services.json et package.json decrivent le meme service');

    // mode d'emploi : les deux menus du simulateur, et l'avertissement qui manquait
    var lisezMoi = fs.readFileSync(path.join(cible, 'LISEZ-MOI-SIMULATEUR.txt'), 'utf8');
    assert.ok(lisezMoi.indexOf('Add Service') !== -1, 'menu Add Service cite');
    assert.ok(lisezMoi.indexOf('Launch App') !== -1, 'menu Launch App cite');
    assert.ok(lisezMoi.indexOf('Service does not exist') !== -1, 'symptome explique');
    assert.ok(lisezMoi.indexOf('package.json') !== -1, 'racine du service decrite');

    banc.removeTree(racine);
  });

  harness.it('un empaquetage absent est refuse clairement', function () {
    var racine = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-simu-vide-'));
    var refus = null;
    try {
      outilSimulateur.preparerPackSimulateur(path.join(racine, 'rien'), path.join(racine, 'simulator'));
    } catch (erreur) {
      refus = erreur;
    }
    assert.ok(refus, 'erreur levee');
    void refus;
    banc.removeTree(racine);
  });
});

/**
 * Hors téléviseur (simulateur, poste de développement), `/media/internal` n'existe pas : le service
 * doit se rabattre sur un répertoire utilisable **sans** renoncer à s'enregistrer — un service non
 * enregistré est précisément le défaut « Service does not exist ».
 */
harness.describe('Répertoire de travail du service : repli hors téléviseur', function () {
  harness.it('un repertoire inscriptible est utilise tel quel', function () {
    var racine = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-stock-'));
    var choisi = mainLib.resolveStorageRoot(path.join(racine, 'donnees'));
    assert.equal(choisi.repli, false, 'pas de repli quand le chemin est creable');
    assert.equal(fs.existsSync(choisi.storageRoot), true, 'repertoire cree');
    banc.removeTree(racine);
  });

  harness.it('un chemin non creable declenche le repli, sans exception', function () {
    var choisi = mainLib.resolveStorageRoot('/proc/iptv-interdit/donnees');
    assert.equal(choisi.repli, true, 'repli signale');
    assert.equal(choisi.storageRoot.indexOf('iptv-webos-') !== -1, true, 'repli sous le repertoire temporaire : ' + choisi.storageRoot);
    assert.equal(fs.existsSync(choisi.storageRoot), true, 'repertoire de repli utilisable');
  });
});

/**
 * Régression (simulateur, 0.1.4) : dès qu'une commande échouait, la page affichait
 * `[object Object]` — l'enveloppe du service (`{returnValue:false, error:{code,message}}`) n'était
 * pas reconnue, seulement les erreurs du bus (`errorText`). Les deux formes doivent donner un texte
 * exploitable, sous peine de rendre tout diagnostic à distance impossible.
 */
harness.describe('Affichage des erreurs LS2 : jamais [object Object]', function () {
  harness.it('enveloppe du service : code, message et indication', function () {
    var reponse = {
      returnValue: false,
      error: { code: 'profile/invalid', message: 'profil inconnu', retryable: false, hint: 'creer le profil' }
    };
    var texte = formatLib.texteErreur(reponse);
    assert.equal(texte, 'profile/invalid — profil inconnu (creer le profil)', 'code, message et indication');
    assert.equal(texte.indexOf('[object'), -1, 'aucune forme objet apparente');
  });

  harness.it('erreur du bus : message brut conserve avec son code', function () {
    var texte = formatLib.texteErreur({
      returnValue: false,
      errorCode: -1,
      errorText: 'Service does not exist: com.ouagkamel.app.iptvplayer.service.'
    });
    assert.equal(
      texte,
      'Service does not exist: com.ouagkamel.app.iptvplayer.service. (code -1)',
      'message du bus et code'
    );
  });

  harness.it('erreur reessayable, chaine, Error et objet inattendu', function () {
    assert.equal(
      formatLib.texteErreur({ returnValue: false, error: { code: 'catalog/busy', message: 'operation en cours', retryable: true } }),
      'catalog/busy — operation en cours [reessayable]',
      'mention de reprise'
    );
    assert.equal(formatLib.texteErreur('echec brut'), 'echec brut', 'chaine telle quelle');
    assert.equal(formatLib.texteErreur(new Error('boum')), 'boum', 'Error JavaScript');
    assert.equal(formatLib.texteErreur(null), 'erreur inconnue (reponse vide)', 'valeur absente');
    assert.equal(formatLib.texteErreur({ inattendu: 1 }), '{"inattendu":1}', 'forme inattendue montree, pas masquee');
  });

  harness.it('une reponse valide est presentee avec statut, version et donnees', function () {
    var texte = formatLib.texteReponse({ returnValue: true, indexVersion: 3, data: { jobId: 'xtream:p1:live:1' } });
    assert.ok(texte.indexOf('returnValue : true') !== -1, 'statut');
    assert.ok(texte.indexOf('indexVersion : 3') !== -1, 'version d index');
    assert.ok(texte.indexOf('"jobId": "xtream:p1:live:1"') !== -1, 'charge utile en JSON');
    var echec = formatLib.texteReponse({ returnValue: false, error: { code: 'auth/invalidCredentials', message: 'identifiants refuses' } });
    assert.ok(echec.indexOf('auth/invalidCredentials — identifiants refuses') !== -1, 'erreur mise en texte');
  });
});

/**
 * Le portail de contrôle est en HTTP clair : la page doit **transmettre l'autorisation** et savoir
 * reconnaître la demande du service. Sans cela, l'utilisateur voyait `security/insecurescheme` sans
 * aucune action possible (constaté en phase 0A), puis un échec d'import sans rapport apparent.
 */
harness.describe('Autorisation HTTP clair : detection et envoi depuis la page', function () {
  harness.it('l hote a confirmer est extrait du verdict comme de l erreur de commande', function () {
    var verdict = {
      returnValue: true,
      data: { ok: false, errors: [{ code: 'security/insecureScheme', message: 'portail en HTTP clair', retryable: false, hint: 'hote:kdfgh.com' }] }
    };
    assert.equal(formatLib.hoteACOnfirmer(verdict), 'kdfgh.com', 'depuis le verdict');
    var erreur = {
      returnValue: false,
      error: { code: 'security/insecureScheme', message: 'source en HTTP clair', retryable: false, hint: 'hote:kdfgh.com' }
    };
    assert.equal(formatLib.hoteACOnfirmer(erreur), 'kdfgh.com', 'depuis l erreur de commande');
    assert.equal(formatLib.hoteACOnfirmer({ returnValue: true, data: { ok: true, errors: [] } }), null, 'aucune demande');
    assert.equal(
      formatLib.hoteACOnfirmer({ returnValue: false, error: { code: 'SECURITY/InsecureScheme', message: 'x', hint: 'hote:A.Example' } }),
      'A.Example',
      'code insensible a la casse'
    );
  });

  harness.it('la page porte la case d autorisation et l envoie au service', function () {
    var html = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'diagnostic.html'), 'utf8');
    assert.ok(html.indexOf('id="httpclair"') !== -1, 'case d autorisation HTTP clair presente');
    assert.ok(html.indexOf('id="httpclair"') < html.indexOf('</form>') || html.indexOf('id="httpclair"') < html.indexOf('<script'), 'case dans le formulaire');

    var page = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'diagnostic.js'), 'utf8');
    assert.ok(page.indexOf('insecureHttp') !== -1, 'consentement insecureHttp transmis');
    assert.ok(page.indexOf('hoteACOnfirmer') !== -1, 'reconnaissance de la demande du service');
    assert.ok(page.indexOf('cleHote') !== -1, 'choix memorise par hote');
    assert.ok(page.indexOf("testProfile") !== -1 && page.indexOf('consent: consentementDuFormulaire()') !== -1, 'testProfile porte le consentement');
  });

  harness.it('le service refuse un import non confirme, avec l hote', function () {
    var source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'service', 'ls2', 'service.ts'),
      'utf8'
    );
    assert.ok(
      source.indexOf("'security/insecureScheme',\n        'source en HTTP clair") !== -1 ||
        source.indexOf('security/insecureScheme') !== -1,
      'controle prealable du schema dans le service'
    );
    // La réponse d'échec doit transporter la cause réelle : `outcome.error` est une **forme
    // sérialisée** (pas une instance), donc elle est reconstituée en AppError — et le message
    // générique ne sert que de repli.
    assert.ok(
      source.indexOf('outcome.error as { code?: string') !== -1,
      'la forme d erreur du job est relue, pas ignoree'
    );
    assert.ok(
      source.indexOf('new AppError(brut.code as ErrorCode') !== -1,
      'cause reelle reconstituee pour la reponse finale'
    );
  });
});

/**
 * Sources préconfigurées : la page doit pouvoir proposer un portail sans rien ressaisir, et le dépôt
 * ne doit **jamais** contenir les identifiants (ils vivent dans `secrets.local/profils.js`, hors
 * dépôt, remplacé à l'empaquetage ; la publication refuse une livraison qui les embarque).
 */
harness.describe('Sources preconfigurees : mecanisme sans secret dans le depot', function () {
  var RACINE = path.join(__dirname, '..');

  harness.it('la page charge profils.js et remplit le formulaire depuis la liste', function () {
    var html = fs.readFileSync(path.join(RACINE, 'src', 'app', 'diagnostic.html'), 'utf8');
    assert.ok(html.indexOf('<script src="profils.js"></script>') !== -1, 'profils.js charge par la page');
    assert.ok(html.indexOf('id="source"') !== -1, 'liste des sources presente');
    assert.ok(
      html.indexOf('<script src="profils.js"></script>') < html.indexOf('<script src="diagnostic.js"></script>'),
      'profils.js charge avant diagnostic.js'
    );

    assert.ok(html.indexOf("id=\"etiquette-utilisateur\"") !== -1, 'champs porteurs d une etiquette nommable');

    var page = fs.readFileSync(path.join(RACINE, 'src', 'app', 'diagnostic.js'), 'utf8');
    assert.ok(page.indexOf('window.iptvProfils') !== -1, 'lecture de window.iptvProfils');
    assert.ok(page.indexOf("el('etiquette-' + champ)") !== -1, 'etiquettes mises a jour par la source');
    assert.ok(page.indexOf('champsDepuisSource') !== -1, 'mise en forme testable des champs');
    assert.ok(page.indexOf("el('utilisateur').value = champs.username") !== -1, 'identifiants remplis');
    assert.ok(page.indexOf("el('httpclair').checked = true") !== -1, 'portail http : autorisation pre-cochee');
  });

  harness.it('les champs sont deduits de la source, autorisation HTTP clair comprise', function () {
    var source = {
      id: 'p1',
      nom: 'Portail de test',
      url: 'http://portail.example.com:8080',
      username: 'utilisateur-test',
      password: 'motdepasse-test'
    };
    var champs = formatLib.champsDepuisSource(source);
    assert.equal(champs.profileId, 'p1', 'identifiant de profil');
    assert.equal(champs.url, 'http://portail.example.com:8080', 'adresse');
    assert.equal(champs.username, 'utilisateur-test', 'nom d utilisateur');
    assert.equal(champs.password, 'motdepasse-test', 'mot de passe');
    assert.equal(champs.autoriserHttp, true, 'portail en http : autorisation pre-cochee');
    assert.equal(champs.nom, 'Portail de test', 'libelle affiche');
    assert.equal(formatLib.champsDepuisSource({ url: 'https://portail.example.com' }).autoriserHttp, false, 'portail https');
    assert.equal(formatLib.champsDepuisSource(null), null, 'source absente');

    // chaque champ est étiqueté du nom de la source : la provenance du compte de test est lisible
    assert.equal(champs.etiquettes.utilisateur, "Nom d'utilisateur — Portail de test", 'libelle utilisateur');
    assert.equal(champs.etiquettes.url, 'Adresse du portail — Portail de test', 'libelle adresse');
    assert.equal(champs.etiquettes.profil, 'Identifiant de profil — Portail de test', 'libelle profil');
    assert.equal(champs.etiquettes.motdepasse, 'Mot de passe — Portail de test', 'libelle mot de passe');
    var sansNom = formatLib.champsDepuisSource({ url: 'http://hote:8080', username: 'u' });
    assert.equal(sansNom.etiquettes.url, 'Adresse du portail — http://hote:8080', 'repli sur l adresse');
  });

  harness.it('le fichier versionne ne contient aucune source et est valide', function () {
    var fichier = path.join(RACINE, 'src', 'app', 'profils.js');
    var contenu = fs.readFileSync(fichier, 'utf8');
    assert.ok(/window\.iptvProfils\s*=\s*window\.iptvProfils\s*\|\|\s*\{\s*sources:\s*\[\s*\]\s*\}/.test(contenu), 'liste vide dans le depot');
    assertScriptAnalysable(contenu, 'profils.js');
  });

  harness.it('un fichier local de sources est integre a l empaquetage, jamais au depot', function () {
    var local = path.join(RACINE, 'secrets.local', 'profils.js');
    var ignore = fs.readFileSync(path.join(RACINE, '.gitignore'), 'utf8');
    assert.ok(ignore.indexOf('secrets.local/') !== -1, 'secrets.local/ ignore par git');
    var outil = fs.readFileSync(path.join(RACINE, 'tools', 'make-package.js'), 'utf8');
    assert.ok(outil.indexOf("path.join(ROOT, 'secrets.local', 'profils.js')") !== -1, 'injection a l empaquetage');
    assert.ok(outil.indexOf('IPTV_SANS_SOURCES') !== -1, 'construction sans source possible');
    if (fs.existsSync(local)) {
      // des sources existent localement : le depot ne doit en contenir **aucune trace**
      var identifiants = [];
      var bloc = /sources\s*:\s*\[([\s\S]*?)\]/.exec(fs.readFileSync(local, 'utf8'));
      var champs = bloc ? bloc[1].match(/(username|password)\s*:\s*'([^']+)'/g) || [] : [];
      champs.forEach(function (champ) {
        var valeur = /'([^']+)'$/.exec(champ);
        if (valeur && valeur[1].length > 3) identifiants.push(valeur[1]);
      });
      identifiants.forEach(function (secret) {
        var suivis = (fs.existsSync(path.join(RACINE, '.git')) ? suivisGit(RACINE) : []).filter(function (fichier) {
          return !/\.(png|jpg|zip|ipk)$/i.test(fichier);
        });
        suivis.forEach(function (relatif) {
          var complet = path.join(RACINE, relatif);
          if (!fs.existsSync(complet) || fs.statSync(complet).isDirectory()) return;
          var contenu = fs.readFileSync(complet, 'utf8');
          assert.equal(
            contenu.indexOf(secret) === -1,
            true,
            'le fichier suivi ' + relatif + ' ne doit pas contenir un identifiant de secrets.local'
          );
        });
      });
    }
  });

  harness.it('la publication refuse une livraison qui embarque des sources', function () {
    var outil = fs.readFileSync(path.join(RACINE, 'tools', 'publish-release.js'), 'utf8');
    assert.ok(outil.indexOf('verifierSansSecrets') !== -1, 'controle present');
    assert.ok(outil.indexOf('Publication refusee') !== -1, 'refus explicite');
  });
});

/** Liste des fichiers suivis par git (vide si git est absent). */
function suivisGit(racine) {
  var resultat = childProcess.spawnSync('git', ['ls-files'], { cwd: racine, encoding: 'utf8' });
  if (resultat.status !== 0 || !resultat.stdout) return [];
  return resultat.stdout.split('\n').filter(Boolean);
}

/** Le script doit être analysable : un fichier livré vide a déjà échappé à une revue (D-20). */
function assertScriptAnalysable(source, nom) {
  assert.ok(source.length > 20, nom + ' non vide');
  new vm.Script(source, { filename: nom });
}

/**
 * Interface Enact (V1-A, étape 3) : coquille de l'application, contrat des écrans et outillage de
 * construction. Ces contrôles portent sur la **source** de l'interface (le bundle `ui/dist` est
 * reconstruit par `npm run build:ui` et n'est pas versionné) : ils garantissent que la livraison
 * contient bien les écrans, le pont LS2 et le consentement HTTP clair, sans dépendre d'un build.
 */
harness.describe('Interface Enact (V1-A) : coquille, ecrans et outillage', function () {
  var RACINE = path.join(__dirname, '..');
  var UI = path.join(RACINE, 'ui');

  function lire(relatif) {
    return fs.readFileSync(path.join(RACINE, relatif), 'utf8');
  }

  harness.it('la coquille charge profils.js puis le bundle, sans fichier externe', function () {
    var html = lire(path.join('src', 'app', 'index.html'));
    assert.ok(html.indexOf('id="root"') !== -1, 'point de montage React');
    assert.ok(html.indexOf('ui/main.css') !== -1, 'feuille de style du bundle');
    assert.ok(html.indexOf('ui/main.js') !== -1, 'bundle de l interface');

    var rangProfils = html.indexOf('<script src="profils.js"></script>');
    var rangBundle = html.indexOf('<script src="ui/main.js"></script>');
    assert.ok(rangProfils !== -1, 'profils.js charge par la coquille');
    assert.ok(rangProfils < rangBundle, 'les sources preconfigurees sont disponibles avant le bundle');
    assert.equal(html.indexOf('webOSTV.js'), -1, 'aucun renvoi a la bibliotheque du SDK LG');

    var appinfo = JSON.parse(lire('appinfo.json'));
    assert.equal(appinfo.main, 'index.html', 'l entree du paquet est la coquille de l interface');
  });

  harness.it('le bundle embarque le pont LS2 et les douze commandes, sans appel direct', function () {
    var entree = lire(path.join('ui', 'src', 'index.js'));
    assert.ok(entree.indexOf('webos-bridge.js') !== -1, 'pont LS2 importe par l entree');
    assert.ok(entree.indexOf('ReactDOM.render') !== -1, 'React 17 : montage par ReactDOM.render');

    var ui = fs.readdirSync(path.join(UI, 'src', 'views')).join(' ');
    assert.ok(ui.indexOf('Live.js') !== -1 && ui.indexOf('Reglages.js') !== -1, 'ecrans livres');

    var couche = sansCommentaires(lire(path.join('ui', 'src', 'services', 'service.js')));
    assert.ok(couche.indexOf('webOS.service.request') === -1, 'la couche service ne parle pas au bus directement');
    ['testProfile', 'importerPlaylist', 'getCategories', 'getPage', 'getBuckets', 'search', 'getDetails', 'resolveStream', 'getImportJob', 'cancelOperation', 'deleteProfile', 'diagnostics'].forEach(function (commande) {
      assert.ok(couche.indexOf(commande + ':') !== -1, 'commande exposee par la couche : ' + commande);
    });
    assert.ok(couche.indexOf('indexVersion') !== -1, 'version d index remontee aux ecrans');
  });

  harness.it('quatre sections, pile de panneaux et Retour : l accueil n est pas un ecran mort', function () {
    var app = lire(path.join('ui', 'src', 'App', 'App.js'));
    ['live', 'vod', 'series', 'reglages'].forEach(function (cle) {
      assert.ok(app.indexOf("cle: '" + cle + "'") !== -1, 'section declaree : ' + cle);
    });
    assert.ok(app.indexOf('onBack={this.retour}') !== -1, 'Retour branche sur la pile de panneaux');
    assert.ok(app.indexOf("vues: ['accueil', 'contenu', 'lecteur']") !== -1, 'lecteur empile au-dessus du contenu');
    assert.ok(app.indexOf('allerAuContenu') !== -1, 'les cartes d accueil entrent dans la section');
    assert.ok(app.indexOf('TabLayout') !== -1 && app.indexOf('index={indexDe(section)}') !== -1, 'barre de navigation globale (Spotlight)');

    var accueil = lire(path.join('ui', 'src', 'views', 'Accueil.js'));
    assert.ok(accueil.indexOf("'Incrément V1-B'") === -1, 'aucun faux ecran vide pour les sections non livrees');
    assert.ok(accueil.indexOf('DESCRIPTIONS') !== -1, 'chaque carte annonce son contenu');
  });

  harness.it('Live TV : categories de l index, chaines paginees par le service', function () {
    var live = lire(path.join('ui', 'src', 'views', 'Live.js'));
    assert.ok(live.indexOf('service.getCategories(') !== -1, 'categories lues dans l index');
    assert.ok(live.indexOf("contentType: 'live'") !== -1, 'contenu live demande');
    assert.ok(live.indexOf('cursor: curseur') !== -1 && live.indexOf('page.cursor') !== -1, 'pagination par curseur');
    assert.ok(live.indexOf('onScrollStop') !== -1, 'page suivante chargee a la demande');
    assert.ok(live.indexOf('lancer({') !== -1, 'OK lance la lecture sans quitter la section');
  });

  harness.it('lecteur : un seul <video> natif alimente par resolveStream()', function () {
    var lecteur = sansCommentaires(lire(path.join('ui', 'src', 'views', 'Lecteur.js')));
    assert.equal((lecteur.match(/<video/g) || []).length, 1, 'un seul element video, jamais deux');
    assert.ok(lecteur.indexOf('service\n') !== -1 || lecteur.indexOf('resolveStream') !== -1, 'resolution avant lecture');
    assert.ok(lecteur.indexOf('requestedFormat') !== -1, 'format demande au service');
    assert.ok(lecteur.indexOf('MediaError') !== -1 || lecteur.indexOf('video.error') !== -1, 'erreur media lisible');
    assert.ok(lecteur.indexOf('461') !== -1, 'touche Retour de la telecommande prise en compte');
    assert.ok(lecteur.indexOf('Spotlight.pause') !== -1 && lecteur.indexOf('Spotlight.resume') !== -1, 'Spotlight rendu a la sortie');
  });

  harness.it('reglages : consentement HTTP clair transmis au service (§8.2)', function () {
    var reglages = lire(path.join('ui', 'src', 'views', 'Reglages.js'));
    assert.ok(reglages.indexOf('insecureHttp: profil.insecureHttp') !== -1, 'consentement porte par testProfile');
    var occurrences = reglages.split('insecureHttp: profil.insecureHttp').length - 1;
    assert.ok(occurrences >= 2, 'consentement porte aussi par l import (' + occurrences + ' occurrences)');
    assert.ok(reglages.indexOf('CheckboxItem') !== -1, 'le consentement est un choix explicite');
    assert.ok(reglages.indexOf('getImportJob') !== -1, 'progression de l import suivie jusqu a la phase finale');
    assert.ok(reglages.indexOf("'diagnostic.html'") !== -1, 'page de diagnostic toujours joignable');
  });

  harness.it('l outillage construit et embarque l interface, ou refuse de paqueter', function () {
    var build = lire(path.join('tools', 'build-ui.js'));
    assert.ok(build.indexOf('--openssl-legacy-provider') !== -1, 'fourniture OpenSSL pour webpack 4');
    assert.ok(build.indexOf("majeureNode() >= 17") !== -1, 'option reservee aux Node qui la connaissent');
    assert.ok(build.indexOf("'false'") !== -1 && build.indexOf('ILIB_ASSET_EMIT') !== -1, 'locales iLib non embarquees');

    var outilBuild = require(path.join(RACINE, 'tools', 'build-ui.js'));
    var env = outilBuild.environnementsDeBuild();
    assert.equal(env.ILIB_ASSET_EMIT, 'false', 'aucune locale iLib dans le bundle');
    if (outilBuild.majeureNode() >= 17) {
      assert.ok(String(env.NODE_OPTIONS).indexOf('--openssl-legacy-provider') !== -1, 'Node recent : fourniture md4 activee');
    }

    var paquet = lire(path.join('tools', 'make-package.js'));
    assert.ok(paquet.indexOf("'ui', 'dist'") !== -1, 'le paquet prend le bundle de l interface');
    assert.ok(paquet.indexOf('interface Enact non construite') !== -1, 'refus explicite si le bundle manque');
    assert.ok(paquet.indexOf("creerDossiers(uiApp)") !== -1, 'bundle depose sous ui/ dans le paquet');
  });
});
