'use strict';
/**
 * Banc d'essai **headless** de l'application empaquetee (V1-A).
 *
 * Le simulateur et la TV executent l'interface dans un navigateur Chromium en `file://`. Ce banc
 * rejoue ce demarrage hors appareil :
 *
 *  - `index.html`, `profils.js` et `ui/main.js` sont pris dans l'arborescence empaquetee, dans
 *    l'ordre ou la page les charge ;
 *  - `XMLHttpRequest` est remplace par une imitation de Chromium en `file://` : un fichier present
 *    repond **statut 0 avec un corps**, un fichier absent **leve une exception**. C'est ce dernier
 *    comportement qui a produit l'ecran noir du simulateur en 0.1.8 (voir D-35 et
 *    `ui/src/services/sansLocales.js`) ;
 *  - `localStorage` est fourni (present sur la TV, absent d'une origine opaque sous jsdom) ;
 *  - erreurs non rattrapees, requetes et requetes ratees sont collectees.
 *
 * Usage direct : node tools/render-app.js <racine> [attente ms]
 * En test      : require('./render-app').executerBanc(racine, attente)
 */

var fs = require('fs');
var path = require('path');

/** jsdom : dependance d'outillage (devDependencies), sinon repli sur le dossier local d'outils. */
function chargerJsdom() {
  var candidats = [process.env.JSDOM_PATH, 'jsdom', '/home/user/.local/jsdom-env/node_modules/jsdom'];
  for (var i = 0; i < candidats.length; i++) {
    if (!candidats[i]) continue;
    try {
      return require(candidats[i]);
    } catch (erreur) {
      // candidat suivant
    }
  }
  throw new Error('jsdom introuvable : npm i --no-save jsdom (ou JSDOM_PATH)');
}

/**
 * Execute l'application et renvoie un rapport.
 *
 * @param {String} racine repertoire de l'application (celui qui contient `index.html`)
 * @param {Number} attente duree laissee a React pour rendre l'ecran, en ms
 * @returns {Promise<Object>} `{verdict, requetes, requetesRatees, erreurs, texteRendu, racineHtml}`
 */
function executerBanc(racine, attente) {
  var jsdom = chargerJsdom();
  var JSDOM = jsdom.JSDOM;
  var RACINE = path.resolve(racine || 'release/package');
  var ATTENTE = Number(attente || 3000);

  var requetes = [];
  var requetesRatees = [];
  var erreurs = [];

  function FauxXhr() {
    this.readyState = 0;
    this.status = 0;
    this.response = '';
    this.responseText = '';
    this.onreadystatechange = null;
    this.onload = null;
    this.onerror = null;
    this.onprogress = null;
    this.onabort = null;
  }
  FauxXhr.prototype.open = function (methode, url) {
    this._methode = methode;
    this._url = String(url);
  };
  FauxXhr.prototype.setRequestHeader = function () {};
  FauxXhr.prototype.getAllResponseHeaders = function () {
    return '';
  };
  FauxXhr.prototype.abort = function () {};
  FauxXhr.prototype.send = function () {
    var relatif = this._url.replace(/^file:\/\/[^/]*/, '').replace(/^\/+/, '');
    var complet = path.join(RACINE, relatif);
    requetes.push(relatif);
    if (!fs.existsSync(complet)) {
      requetesRatees.push(relatif);
      var erreur = new Error(
        "Failed to execute 'send' on 'XMLHttpRequest': Failed to load '" + this._url + "'"
      );
      erreur.name = 'DOMException';
      throw erreur;
    }
    var corps = fs.readFileSync(complet, 'utf8');
    // Chromium en file:// : statut 0, corps present
    this.readyState = 4;
    this.status = 0;
    this.responseText = corps;
    this.response = corps;
    if (this.onreadystatechange) this.onreadystatechange();
    if (this.onload) this.onload();
    return corps;
  };

  var html = fs.readFileSync(path.join(RACINE, 'index.html'), 'utf8');
  var consoleVirtuelle = new jsdom.VirtualConsole();
  consoleVirtuelle.on('jsdomError', function (erreur) {
    erreurs.push('jsdom : ' + erreur.message);
  });
  consoleVirtuelle.on('error', function (message) {
    erreurs.push('console : ' + message);
  });
  var dom = new JSDOM(html, {
    url: 'file:///' + RACINE.split(path.sep).join('/') + '/index.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: consoleVirtuelle
  });
  var fenetre = dom.window;
  fenetre.XMLHttpRequest = FauxXhr;

  // `localStorage` n'existe pas sur une origine opaque (`file://`) pour jsdom ; sur la TV et dans le
  // simulateur webOS il existe. On fournit l'equivalent en memoire pour rester fidele a la cible.
  var memoire = {};
  Object.defineProperty(fenetre, 'localStorage', {
    configurable: true,
    value: {
      getItem: function (cle) {
        return Object.prototype.hasOwnProperty.call(memoire, cle) ? memoire[cle] : null;
      },
      setItem: function (cle, valeur) {
        memoire[cle] = String(valeur);
      },
      removeItem: function (cle) {
        delete memoire[cle];
      },
      clear: function () {
        memoire = {};
      },
      key: function (index) {
        return Object.keys(memoire)[index] || null;
      },
      get length() {
        return Object.keys(memoire).length;
      }
    }
  });

  fenetre.addEventListener('error', function (evenement) {
    var erreur = evenement.error || {};
    erreurs.push('window.error : ' + (erreur.message || evenement.message));
  });

  // scripts de la page, dans l'ordre : `profils.js` (sources preconfigurees) puis `ui/main.js`
  ['profils.js'].forEach(function (nom) {
    var fichier = path.join(RACINE, nom);
    if (!fs.existsSync(fichier)) return;
    try {
      fenetre.eval(fs.readFileSync(fichier, 'utf8'));
    } catch (erreur) {
      erreurs.push(nom + ' : ' + erreur.message);
    }
  });

  try {
    fenetre.eval(fs.readFileSync(path.join(RACINE, 'ui', 'main.js'), 'utf8'));
  } catch (erreur) {
    erreurs.push('ui/main.js : ' + erreur.name + ': ' + erreur.message);
  }

  return new Promise(function (resolve) {
    setTimeout(function () {
      var racineDom = fenetre.document.getElementById('root');
      var texte = racineDom ? (racineDom.textContent || '').replace(/\s+/g, ' ').trim() : '';
      resolve({
        verdict:
          requetesRatees.length === 0 && erreurs.length === 0 && racineDom && racineDom.innerHTML.length > 0
            ? 'OK'
            : 'ECHEC',
        racineHtml: racineDom ? racineDom.innerHTML.length : 0,
        texteRendu: texte,
        requetes: requetes,
        requetesRatees: requetesRatees,
        erreurs: erreurs
      });
      dom.window.close();
    }, ATTENTE);
  });
}

module.exports = {
  executerBanc: executerBanc,
  /** jsdom est-il utilisable ici ? (les tests s'ignorent proprement quand il manque) */
  bancDisponible: function () {
    try {
      chargerJsdom();
      return true;
    } catch (erreur) {
      return false;
    }
  }
};

if (require.main === module) {
  executerBanc(process.argv[2], process.argv[3]).then(
    function (rapport) {
      console.log(JSON.stringify(rapport, null, 2));
      process.exit(rapport.verdict === 'OK' ? 0 : 1);
    },
    function (erreur) {
      console.error(String(erreur && erreur.message ? erreur.message : erreur));
      process.exit(2);
    }
  );
}
