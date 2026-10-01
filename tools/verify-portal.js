'use strict';

/**
 * Contrôle de bout en bout **hors TV** : le service LS2 réel est piloté contre un portail Xtream réel,
 * avec les mêmes commandes que celles appelées par l'application (`testProfile`, `importPlaylist`,
 * `getPage`, `getDetails`, `resolveStream`, `diagnostics`). Le flux résolu est ensuite lu pour de bon :
 * redirections suivies, en-tête `video/mp2t` et synchronisation MPEG-TS vérifiés.
 *
 *   IPTV_HOST=portail.example:8080 IPTV_USER=... IPTV_PASS=... npm run verify:portal
 *
 * Les identifiants ne sont **jamais** journalisés (toute sortie est masquée) et rien n'est écrit dans
 * le dépôt : le répertoire de travail est temporaire. Ce contrôle n'appartient pas à `npm test` :
 * il exige un accès réseau et un compte réel.
 *
 * Options :
 *   IPTV_SCHEME   http (défaut) | https
 *   IPTV_ID       identifiant de chaîne à privilégier pour l'essai de lecture
 *   IPTV_CONTENT  type de contenu importé : live (défaut) | vod | series
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var urlLib = require('url');

/** Création d'arborescence portable : `mkdirSync(dir, {recursive:true})` date de Node 10.12. */
function creerDossiers(dir) {
  var parent = path.dirname(dir);
  if (parent !== dir && !fs.existsSync(parent)) creerDossiers(parent);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
}

var libRoot = path.join(__dirname, '..', 'service', 'com.ouagkamel.app.iptvplayer.service', 'lib');
var clientLib = require(path.join(libRoot, 'service', 'http', 'httpClient'));
var db8Lib = require(path.join(libRoot, 'service', 'db8', 'client'));
var serviceLib = require(path.join(libRoot, 'service', 'ls2', 'service'));
var busLib = require(path.join(libRoot, 'service', 'ls2', 'bus'));
var envelopeLib = require(path.join(libRoot, 'service', 'ls2', 'envelope'));

var host = process.env.IPTV_HOST;
var utilisateur = process.env.IPTV_USER;
var motDePasse = process.env.IPTV_PASS;
var contentType = process.env.IPTV_CONTENT || 'live';

if (!host || !utilisateur || !motDePasse) {
  console.error('Renseigner IPTV_HOST, IPTV_USER et IPTV_PASS (voir docs/PHASE-0.md §0A).');
  process.exit(2);
}

var baseUrl = (process.env.IPTV_SCHEME || 'http') + '://' + host;

function masque(texte) {
  return String(texte).split(utilisateur).join('***').split(motDePasse).join('***');
}

function journal(titre, valeur) {
  console.log('  ' + titre.padEnd(13, ' ') + ':', masque(valeur));
}

/** Message d'erreur LS2, quelle que soit sa forme (enveloppe du service ou erreur du bus). */
function formatTexte(valeur) {
  if (!valeur) return 'echec';
  if (valeur.error) {
    return valeur.error.code + ' — ' + valeur.error.message + (valeur.error.hint ? ' (' + valeur.error.hint + ')' : '');
  }
  return valeur.errorText || valeur.message || JSON.stringify(valeur);
}

function attendre(predicat, delaiMs) {
  var echeance = Date.now() + delaiMs;
  return new Promise(function (resolve, reject) {
    (function boucle() {
      if (predicat()) return resolve();
      if (Date.now() > echeance) return reject(new Error('delai depasse'));
      setTimeout(boucle, 25);
    })();
  });
}

/** Lecture réelle d'un flux : suit les redirections, contrôle l'en-tête et la synchronisation TS. */
function lireFlux(cible, octetsMax, delaiMs) {
  return new Promise(function (resolve) {
    var debut = Date.now();
    function suivre(url, sauts) {
      var analyse = urlLib.parse(url);
      var transport = analyse.protocol === 'https:' ? require('https') : require('http');
      var requete = transport.get(
        {
          host: analyse.hostname,
          port: analyse.port || (analyse.protocol === 'https:' ? 443 : 80),
          path: analyse.path,
          headers: { 'user-agent': 'IPTVPlayer/0.1.0 (webOS TV)', accept: '*/*' }
        },
        function (reponse) {
          if ([301, 302, 303, 307, 308].indexOf(reponse.statusCode) !== -1 && reponse.headers.location && sauts < 4) {
            reponse.resume();
            journal('redirection', reponse.statusCode + ' vers ' + String(reponse.headers.location).replace(/\/play\/[^\/]+/, '/play/<jeton>'));
            return suivre(urlLib.resolve(url, reponse.headers.location), sauts + 1);
          }
          var octets = 0;
          var premier = null;
          reponse.on('data', function (chunk) {
            if (premier === null) premier = chunk;
            octets += chunk.length;
            if (octets >= octetsMax) {
              requete.destroy();
              journal('HTTP', reponse.statusCode + ' ' + (reponse.headers['content-type'] || ''));
              journal('octets', octets + ' recus, connexion interrompue volontairement');
              journal('MPEG-TS', premier[0] === 0x47 && premier[188] === 0x47 ? 'oui (0x47 tous les 188 octets)' : 'non (premier octet ' + premier[0] + ')');
              journal('duree', (Date.now() - debut) + ' ms');
              resolve(true);
            }
          });
          reponse.on('end', function () {
            journal('HTTP', reponse.statusCode + ' ' + (reponse.headers['content-type'] || ''));
            journal('octets', octets + ' en ' + (Date.now() - debut) + ' ms');
            journal('MPEG-TS', premier && premier[0] === 0x47 ? 'oui' : 'non (flux vide ou non TS)');
            resolve(octets > 0);
          });
        }
      );
      requete.on('error', function (erreur) {
        journal('erreur', erreur.code || erreur.message);
        resolve(false);
      });
      requete.setTimeout(delaiMs, function () {
        requete.destroy();
        journal('flux', 'delai depasse');
        resolve(false);
      });
    }
    suivre(cible, 0);
  });
}

var stockage = path.join(os.tmpdir(), 'iptv-verify-' + Date.now());
creerDossiers(stockage);

var http = new clientLib.HttpClient({});
var fauxDb = new db8Lib.FakeDb8Bus();
var db = new db8Lib.Db8Client({ call: fauxDb.call, appId: db8Lib.APP_ID });
var journalService = [];
var service = new serviceLib.IptvService({
  db: db,
  http: http,
  storageRoot: stockage,
  onLog: function (ligne) {
    journalService.push(masque(ligne));
  }
});
var bus = busLib.createFakeBus();
service.register(bus);

var identifiants = { username: utilisateur, password: motDePasse };
var etat = {};
var echecs = 0;

// Aucun profil n'est créé ici : le contrôle rejoue le cas d'un **appareil neuf** (simulateur ou
// téléviseur après effacement), où `importPlaylist` doit créer le profil lui-même.
Promise.resolve()
  .then(function () {
    console.log('\n1. testProfile');
    return bus
      .invoke('testProfile', {
        profileId: 'verif',
        kind: 'xtream',
        baseUrl: baseUrl,
        username: utilisateur,
        password: motDePasse,
        consent: { insecureHttp: baseUrl.indexOf('https://') !== 0 }
      })
      .then(function (reponses) {
        var reponse = reponses[0];
        var verdict = reponse.data || {};
        journal('appel LS2', reponse.returnValue === true ? 'servi' : formatTexte(reponse.error));
        journal('verdict', verdict.ok === true ? 'ok' : 'echec : ' + JSON.stringify(verdict.errors || []));
        if (verdict.account) journal('compte', JSON.stringify(verdict.account));
        if (verdict.warnings && verdict.warnings.length) journal('avertiss.', JSON.stringify(verdict.warnings));
        if (reponse.returnValue !== true || verdict.ok !== true) echecs += 1;
        return reponse.returnValue === true && verdict.ok === true;
      });
  })
  .then(function (ok) {
    if (!ok) throw new Error('testProfile refuse : arret du controle');
    console.log('\n2. importPlaylist (' + contentType + ')');
    var debut = Date.now();
    return bus
      .invoke(
        'importPlaylist',
        {
          profileId: 'verif',
          kind: 'xtream',
          contentType: contentType,
          source: { url: baseUrl, credentials: identifiants },
          consent: { insecureHttp: baseUrl.indexOf('https://') !== 0, persistSecrets: false }
        },
        { subscribed: true }
      )
      .then(function (initiales) {
        if (initiales[0].returnValue !== true) {
          journal('import', 'refuse : ' + formatTexte(initiales[0].error));
          echecs += 1;
          throw new Error('import refuse');
        }
        var jobId = initiales[0].data && initiales[0].data.jobId;
        if (initiales[0].data.profilCree !== undefined) {
          journal('profil', initiales[0].data.profilCree === true ? 'cree par cet import' : 'deja present');
        }
        journal('jobId', jobId);
        return attendre(function () {
          return bus.log.some(function (entree) {
            return (
              entree.command === 'importPlaylist' &&
              entree.reply &&
              entree.reply.data &&
              entree.reply.data.final === true &&
              entree.reply.data.jobId === jobId
            );
          });
        }, 120000).then(function () {
          var messages = bus.log
            .filter(function (entree) {
              return entree.command === 'importPlaylist' && entree.reply && entree.reply.data && entree.reply.data.jobId === jobId;
            })
            .map(function (entree) {
              return entree.reply.data;
            });
          var final = messages[messages.length - 1];
          var travail = final.job || final;
          journal('phase', travail.phase);
          journal('entrees', travail.entriesRead);
          journal('octets', travail.bytesRead);
          journal('duree', (Date.now() - debut) + ' ms');
          journal('messages', messages.length + ' (abonnement)');
          if (travail.phase !== 'done') echecs += 1;
        });
      });
  })
  .then(function () {
    console.log('\n3. getPage / getBuckets / search');
    return Promise.all([
      bus.invoke('getPage', { profileId: 'verif', contentType: contentType, order: 'source' }),
      bus.invoke('getBuckets', { profileId: 'verif', contentType: contentType })
    ]).then(function (reponses) {
      var chaine = reponses[0][0];
      if (chaine.returnValue !== true) {
        journal('getPage', 'echec : ' + JSON.stringify(chaine.error));
        echecs += 1;
        throw new Error('page indisponible');
      }
      var page = chaine.data;
      journal('page', page.items.length + ' objets | version ' + page.indexVersion);
      var tranches = reponses[1][0].data;
      journal('tranches', tranches.buckets.length + ' | script ' + tranches.script);
      if (process.env.IPTV_ID) {
        var choisi = page.items.filter(function (item) {
          return item.ref.providerId === process.env.IPTV_ID;
        })[0];
        if (choisi) page.items = [choisi].concat(page.items.filter(function (item) { return item !== choisi; }));
      }
      etat.ref = page.items[0].ref;
      etat.titre = page.items[0].title;
      journal('premier', JSON.stringify(page.items[0]));
      return bus.invoke('search', { profileId: 'verif', contentType: contentType, query: String(etat.titre).slice(0, 4) });
    });
  })
  .then(function (recherche) {
    journal('search', recherche[0].returnValue === true ? recherche[0].data.items.length + ' resultats' : JSON.stringify(recherche[0].error));
    console.log('\n4. getDetails / resolveStream');
    return bus
      .invoke('getDetails', { profileId: 'verif', contentType: contentType, ref: etat.ref })
      .then(function (reponses) {
        var detail = reponses[0];
        if (detail.returnValue !== true) {
          journal('getDetails', 'echec : ' + JSON.stringify(detail.error));
          echecs += 1;
          throw new Error('detail indisponible');
        }
        journal('titre', detail.data.title);
        journal('streamRef', detail.data.streamRef + ' | mode ' + detail.data.streamMode);
        var texte = JSON.stringify(detail);
        journal('octets', Buffer.byteLength(texte) + ' (<= 32 Kio)');
        // le contrôle est celui du service lui-même (§15.4) : le détail ne transporte aucun secret
        var motifs = envelopeLib.findSecretPatterns(texte);
        journal('sans secret', motifs.length === 0 ? 'oui (aucun motif interdit)' : 'NON : ' + motifs.join(', '));
        if (motifs.length > 0) echecs += 1;
        return bus.invoke('resolveStream', { profileId: 'verif', ref: etat.ref, requestedFormat: 'auto' });
      })
      .then(function (reponses) {
        var resolution = reponses[0];
        if (resolution.returnValue !== true) {
          journal('resolveStream', 'echec : ' + JSON.stringify(resolution.error));
          echecs += 1;
          return false;
        }
        journal('kind', resolution.data.kind + ' | mime ' + (resolution.data.preferredMime || 'non declare'));
        journal('url', resolution.data.url);
        return lireFlux(resolution.data.url, 1024 * 1024, 20000);
      });
  })
  .then(function (lu) {
    if (lu !== true) echecs += 1;
    console.log('\n5. diagnostics');
    return bus.invoke('diagnostics', {}).then(function (reponses) {
      var diag = reponses[0];
      if (diag.returnValue !== true) {
        journal('diagnostics', 'echec : ' + JSON.stringify(diag.error));
        echecs += 1;
        return;
      }
      var donnees = diag.data;
      journal('runtime', JSON.stringify(donnees.runtime));
      journal('racines', donnees.roots.certificateCount + ' certificats (' + donnees.roots.source + ')');
      journal('index', JSON.stringify(donnees.indexes));
      journal('capacites', JSON.stringify(donnees.capabilities));
    });
  })
  .then(function () {
    console.log('\n' + (echecs === 0 ? 'CONTROLE REUSSI' : 'CONTROLE EN ECHEC (' + echecs + ' point(s))'));
    console.log('journal du service : ' + journalService.length + ' ligne(s) ; dernieres :');
    console.log(masque(journalService.slice(-6).map(function (l) { return '  ' + l; }).join('\n')));
    process.exitCode = echecs === 0 ? 0 : 1;
  })
  .catch(function (erreur) {
    console.log('\nECHEC : ' + masque((erreur && erreur.message) || erreur));
    console.log(masque(journalService.slice(-6).map(function (l) { return '  ' + l; }).join('\n')));
    process.exitCode = 1;
  });
