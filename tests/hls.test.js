'use strict';

/**
 * **Chargement à la demande du repli MSE** (D-45) — `ui/src/services/hls.js`.
 *
 * Ce que ces tests protègent : la spécification (§422) demande de ne **pas** mettre HLS.js sur le
 * chemin par défaut. Un `import` statique l'aurait embarqué dans `ui/main.js` et chargé à chaque
 * démarrage ; le chargeur, lui, n'injecte `vendor/hls.min.js` qu'une fois, au moment où le lecteur
 * en a besoin. Les tests vérifient donc : une seule injection par session, résolution avec le
 * constructeur `Hls`, et des échecs **nommés** (fichier absent, script chargé sans `Hls`, document
 * inexistant) — un repli muet serait un écran noir de plus.
 */

var assert = require('./assert');
var harness = require('./harness');
var path = require('path');

/** Faux DOM minimal : enregistre la balise injectée et permet de la faire répondre. */
function fauxDocument() {
  var injectees = [];
  return {
    injectees: injectees,
    document: {
      head: {
        appendChild: function (balise) {
          injectees.push(balise);
        }
      },
      createElement: function (nom) {
        return {nom: nom, src: '', async: false, onload: null, onerror: null};
      }
    }
  };
}

/** Prépare un environnement global isolé, puis le restaure en fin de test. */
function avecGlobaux(globaux, corps) {
  var avant = {window: global.window, document: global.document};
  global.window = globaux.window;
  global.document = globaux.document;
  var restaurer = function () {
    if (avant.window === undefined) delete global.window;
    else global.window = avant.window;
    if (avant.document === undefined) delete global.document;
    else global.document = avant.document;
  };
  var resultat;
  try {
    resultat = corps(restaurer);
  } catch (erreur) {
    restaurer();
    throw erreur;
  }
  if (resultat && typeof resultat.then === 'function') {
    return resultat.then(
      function (valeur) {
        restaurer();
        return valeur;
      },
      function (erreur) {
        restaurer();
        throw erreur;
      }
    );
  }
  restaurer();
  return resultat;
}

/** Le module est rechargé à chaque cas : son état « chargement en cours » ne doit pas fuiter. */
function chargeur() {
  var chemin = path.join(__dirname, '..', 'ui', 'src', 'services', 'hls.js');
  delete require.cache[require.resolve(chemin)];
  return require(chemin);
}

harness.describe('Repli MSE : chargement à la demande de hls.js (D-45)', function () {
  harness.it('injecte le fichier du paquet, puis rend le constructeur Hls', function () {
    var faux = fauxDocument();
    var window = {};
    return avecGlobaux({window: window, document: faux.document}, function () {
      var module = chargeur();
      assert.equal(module.CHEMIN, 'vendor/hls.min.js', 'chemin du fichier dans le paquet');
      var promesse = module.chargerHls();
      assert.equal(faux.injectees.length, 1, 'une balise script injectee');
      assert.equal(faux.injectees[0].nom, 'script', 'c est bien un script');
      assert.equal(faux.injectees[0].src, 'vendor/hls.min.js', 'chemin relatif a index.html');
      // la plateforme répond : le script se charge et expose Hls
      window.Hls = {isSupported: function () { return true; }, version: '1.7.3'};
      faux.injectees[0].onload();
      return promesse.then(function (Hls) {
        assert.equal(Hls.version, '1.7.3', 'le constructeur rendu est celui du paquet');
      });
    });
  });

  harness.it('ne charge qu une fois par session, même appelé deux fois', function () {
    var faux = fauxDocument();
    var window = {};
    return avecGlobaux({window: window, document: faux.document}, function () {
      var module = chargeur();
      var premier = module.chargerHls();
      var second = module.chargerHls();
      assert.equal(faux.injectees.length, 1, 'pas de seconde balise');
      assert.equal(premier, second, 'la meme promesse est rendue');
      window.Hls = {version: '1.7.3'};
      faux.injectees[0].onload();
      return premier.then(function () {
        return module.chargerHls().then(function (Hls) {
          assert.equal(faux.injectees.length, 1, 'Hls deja present : aucune injection de plus');
          assert.equal(Hls.version, '1.7.3');
        });
      });
    });
  });

  harness.it('un script absent du paquet est dit, jamais avalé', function () {
    var faux = fauxDocument();
    return avecGlobaux({window: {}, document: faux.document}, function () {
      var module = chargeur();
      var promesse = module.chargerHls();
      faux.injectees[0].onerror();
      return promesse.then(
        function () {
          throw new Error('un script absent ne doit pas resoudre');
        },
        function (erreur) {
          assert.ok(erreur.message.indexOf('introuvable dans le paquet') !== -1, 'message : ' + erreur.message);
          assert.ok(erreur.message.indexOf('vendor/hls.min.js') !== -1, 'le chemin est nomme');
        }
      );
    });
  });

  harness.it('un script charge sans Hls est dit aussi', function () {
    var faux = fauxDocument();
    return avecGlobaux({window: {}, document: faux.document}, function () {
      var module = chargeur();
      var promesse = module.chargerHls();
      faux.injectees[0].onload(); // charge, mais la plateforme n a pas expose Hls
      return promesse.then(
        function () {
          throw new Error('un chargement vide ne doit pas resoudre');
        },
        function (erreur) {
          assert.ok(erreur.message.indexOf('window.Hls introuvable') !== -1, 'message : ' + erreur.message);
        }
      );
    });
  });

  harness.it('sans document (banc sans DOM), le repli se refuse clairement', function () {
    return avecGlobaux({window: {}, document: undefined}, function () {
      var module = chargeur();
      return module.chargerHls().then(
        function () {
          throw new Error('sans document, le repli ne peut pas charger');
        },
        function (erreur) {
          assert.ok(erreur.message.indexOf('aucun document') !== -1, 'message : ' + erreur.message);
        }
      );
    });
  });

  harness.it('un echec de chargement ne bloque pas une tentative ulterieure', function () {
    var faux = fauxDocument();
    var window = {};
    return avecGlobaux({window: window, document: faux.document}, function () {
      var module = chargeur();
      var premier = module.chargerHls();
      faux.injectees[0].onerror();
      return premier.then(
        function () {
          throw new Error('premier chargement en echec');
        },
        function () {
          // le fichier est disponible au deuxieme essai (paquet repare, cache, etc.)
          var second = module.chargerHls();
          assert.equal(faux.injectees.length, 2, 'un nouvel essai injecte a nouveau');
          window.Hls = {version: '1.7.3'};
          faux.injectees[1].onload();
          return second.then(function (Hls) {
            assert.equal(Hls.version, '1.7.3', 'le deuxieme essai aboutit');
          });
        }
      );
    });
  });
});
