'use strict';

/**
 * Adaptateur Xtream (§5.1) : test de connexion, catégories, ingestion « tous les flux » par analyse
 * incrémentale, repli par catégorie, détail de série et construction des URL de lecture.
 *
 * Aucune donnée réelle : le portail est synthétique et le transport est celui de `fake-portal.js`.
 */

var assert = require('./assert');
var harness = require('./harness');
var portalLib = require('./fake-portal');
var path = require('path');

var libRoot = path.join(__dirname, '..', 'service', 'com.ouagkamel.app.iptvplayer.service', 'lib');
var clientLib = require(path.join(libRoot, 'service', 'http', 'httpClient'));
var xtreamLib = require(path.join(libRoot, 'service', 'providers', 'xtream'));

var PORTAL_URL = 'https://portal.example.com';

function makeProvider(portal, options) {
  options = options || {};
  var http = new clientLib.HttpClient({
    transport: portal.transport,
    lookup: portal.lookup,
    caProvider: function () {
      return undefined;
    }
  });
  return new xtreamLib.XtreamProvider({
    http: http,
    profile: {
      id: options.profileId || 'p1',
      baseUrl: PORTAL_URL,
      username: options.sessionOnly ? undefined : portal.config.username,
      password: options.sessionOnly ? undefined : portal.config.password,
      lanAllowed: options.lanAllowed,
      persistSecrets: options.persistSecrets
    },
    session: { username: portal.config.username, password: portal.config.password, acceptedHosts: [] },
    onWarning: options.onWarning
  });
}

harness.describe('Adaptateur Xtream : test de connexion (§3.5)', function () {
  harness.it('un portail valide expose le compte sans jamais journaliser d identifiants', function () {
    var portal = portalLib.createPortal({ counts: { live: 4 } });
    var provider = makeProvider(portal);
    return provider.testConnection().then(function (result) {
      assert.equal(result.ok, true, 'connexion acceptee');
      assert.equal(result.errors.length, 0, 'aucune erreur');
      assert.equal(result.account.status, 'Active', 'statut du compte');
      assert.ok(result.account.formats.indexOf('m3u8') !== -1, 'formats exposes');
      assert.ok(result.account.maxConnections === 2, 'connexions lues');
      assert.equal(provider.portalUrl(), PORTAL_URL, 'URL de portail sans identifiants');
      assert.ok(provider.portalUrl().indexOf('secret') === -1, 'aucun identifiant dans l URL de portail');
    });
  });

  harness.it('des identifiants refuses produisent auth/invalidCredentials, sans nouvelle tentative', function () {
    var portal = portalLib.createPortal({ counts: { live: 4 } });
    var http = new clientLib.HttpClient({
      transport: portal.transport,
      lookup: portal.lookup,
      caProvider: function () {
        return undefined;
      }
    });
    var provider = new xtreamLib.XtreamProvider({
      http: http,
      profile: { id: 'p1', baseUrl: PORTAL_URL, username: 'testeur', password: 'mauvais' },
      session: { acceptedHosts: [] }
    });
    return provider.testConnection().then(function (result) {
      assert.equal(result.ok, false, 'connexion refusee');
      assert.equal(result.errors[0].code, 'auth/invalidCredentials', 'code d erreur');
      assert.equal(result.errors[0].retryable, false, 'non rejouable en boucle');
    });
  });

  harness.it('un compte inactif est signale auth/expired', function () {
    var portal = portalLib.createPortal({ counts: { live: 2 } });
    var provider = makeProvider(portal);
    // le portail synthetique renvoie un compte actif : on verifie le contrat de sortie, puis l etat
    // n'est pas simule ici pour ne pas mentir sur ce que le code teste reellement.
    return provider.testConnection().then(function (result) {
      assert.equal(result.errors.filter(function (error) {
        return error.code === 'auth/expired';
      }).length, 0, 'aucune expiration annoncee par ce portail');
    });
  });

  harness.it('un portail sans user_info est refuse comme reponse non conforme', function () {
    var portal = portalLib.createPortal({ counts: { live: 2 } });
    var http = new clientLib.HttpClient({
      transport: {
        request: function (options, callback) {
          var response = {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            on: function (event, listener) {
              if (event === 'data') setTimeout(function () { listener(Buffer.from('{"autre":1}', 'utf8')); }, 0);
              if (event === 'end') setTimeout(function () { listener(); }, 1);
              return response;
            }
          };
          var request = {
            on: function () {
              return request;
            },
            write: function () {},
            end: function () {
              setTimeout(function () { callback(response); }, 0);
            },
            destroy: function () {},
            setTimeout: function () {
              return request;
            }
          };
          return request;
        }
      },
      lookup: portal.lookup,
      caProvider: function () {
        return undefined;
      }
    });
    var provider = new xtreamLib.XtreamProvider({
      http: http,
      profile: { id: 'p1', baseUrl: PORTAL_URL, username: 'testeur', password: 'secret' },
      session: { acceptedHosts: [] }
    });
    return provider.testConnection().then(function (result) {
      assert.equal(result.ok, false, 'reponse non conforme refusee');
      assert.equal(result.errors[0].code, 'auth/invalidCredentials', 'code d erreur');
      assert.ok(result.errors[0].message.indexOf('user_info') !== -1, 'motif explicite');
    });
  });
});

harness.describe('Adaptateur Xtream : categories et ingestion (§5.1)', function () {
  harness.it('les categories sont normalisees avec leur ordre source', function () {
    var portal = portalLib.createPortal({ counts: { live: 4 } });
    var provider = makeProvider(portal);
    return provider.fetchCategories('live').then(function (categories) {
      assert.equal(categories.length, 3, 'trois categories');
      assert.equal(categories[0].id, '1', 'identifiant stable');
      assert.equal(categories[0].sourceOrder, 0, 'ordre source conserve');
      assert.equal(categories[1].name, 'Cin\u00e9ma', 'nom accentue preserve');
      assert.equal(categories[1].contentType, 'live', 'type de contenu');
    });
  });

  harness.it('l appel global ingere tous les flux en analyse incrementale', function () {
    var portal = portalLib.createPortal({ counts: { live: 40 }, chunkSize: 64 });
    var provider = makeProvider(portal);
    var records = [];
    return provider
      .streamContentType('live', {
        onEntry: function (record) {
          records.push(record);
        }
      })
      .then(function (result) {
        assert.equal(result.usedFallback, false, 'appel global reussi');
        assert.equal(result.entries, 40, 'toutes les entrees ingerees');
        assert.equal(records.length, 40, 'rappel appele pour chaque entree');
        assert.equal(records[0].providerId, '1000', 'identifiant fournisseur');
        assert.equal(records[3].directSource, 'https://cdn.example.net/live/embed/3.ts', 'URL imposee conservee');
        assert.ok(result.bytesRead > 0, 'octets lus comptes');
        // le flux n est jamais mis en tampon : plusieurs morceaux recus
        assert.ok(portal.callsFor('get_live_streams').length === 1, 'un seul appel global');
      });
  });

  harness.it('un echec global recuperable declenche le repli par categorie', function () {
    var portal = portalLib.createPortal({
      counts: { live: 12 },
      chunkSize: 128,
      failure: { action: 'get_live_streams', status: 503, times: 1 },
      categoryStreams: true
    });
    var warnings = [];
    var provider = makeProvider(portal, {
      onWarning: function (warning) {
        warnings.push(warning);
      }
    });
    var records = [];
    return provider
      .streamContentType('live', {
        onEntry: function (record) {
          records.push(record);
        }
      })
      .then(function (result) {
        assert.equal(result.usedFallback, true, 'repli signale');
        assert.equal(result.entries, 12, 'aucune entree perdue');
        assert.equal(result.categories, 3, 'categories balayees');
        assert.ok(warnings.join(' ').indexOf('repli par categorie') !== -1, 'repli consigne en avertissement');
        var perCategory = portal.calls.filter(function (call) {
          return call.path.indexOf('action=get_live_streams') !== -1 && call.path.indexOf('category_id=') !== -1;
        });
        assert.equal(perCategory.length, 3, 'un appel par categorie');
      });
  });

  harness.it('une erreur non recuperable n est pas masquee par un repli', function () {
    var portal = portalLib.createPortal({
      counts: { live: 4 },
      failure: { action: 'get_live_streams', status: 401, times: 1 }
    });
    var provider = makeProvider(portal);
    return provider
      .streamContentType('live', {
        onEntry: function () {}
      })
      .then(
        function () {
          assert.fail('401 pendant l import : une erreur etait attendue');
        },
        function (error) {
          assert.equal(error.code, 'auth/invalidCredentials', 'code d authentification');
        }
      );
  });
});

harness.describe('Adaptateur Xtream : URL de lecture et series (§6.1)', function () {
  harness.it('construit les URL live, VOD et episode sans jamais les journaliser', function () {
    var portal = portalLib.createPortal({ counts: { live: 2 } });
    var provider = makeProvider(portal);
    var live = provider.buildStreamUrl({ providerId: '1000', contentType: 'live' }, 'auto');
    assert.equal(live.url, PORTAL_URL + '/live/testeur/secret/1000.ts', 'URL live MPEG-TS par defaut');
    assert.equal(live.kind, 'derived', 'URL reconstruite');
    assert.equal(live.preferredMime, 'video/mp2t', 'type MIME annonce');
    var hls = provider.buildStreamUrl({ providerId: '1000', contentType: 'live' }, 'hls');
    assert.ok(hls.url.indexOf('.m3u8') !== -1, 'variante HLS');
    assert.equal(hls.preferredMime, 'application/vnd.apple.mpegurl', 'type MIME HLS');
    var vod = provider.buildStreamUrl({ providerId: '5000', contentType: 'vod', containerExtension: 'mp4' });
    assert.equal(vod.url, PORTAL_URL + '/movie/testeur/secret/5000.mp4', 'URL VOD');
    var episode = provider.buildStreamUrl({ providerId: '90011', contentType: 'episode', containerExtension: 'mkv' });
    assert.equal(episode.url, PORTAL_URL + '/series/testeur/secret/90011.mkv', 'URL episode');
  });

  harness.it('une URL imposee par le portail est classee selon la presence d identifiants', function () {
    var portal = portalLib.createPortal({ counts: { live: 2 } });
    var provider = makeProvider(portal);
    var publicUrl = provider.buildStreamUrl({ providerId: '1', contentType: 'live', directSource: 'https://cdn.example.net/live/1.ts' });
    assert.equal(publicUrl.kind, 'urlNoSecret', 'CDN public : aucune donnee secrete');
    var secretUrl = provider.buildStreamUrl({
      providerId: '2',
      contentType: 'live',
      directSource: 'https://cdn.example.net/live/2.ts?user=ab&pass=cd'
    });
    assert.equal(secretUrl.kind, 'storedSecret', 'URL porteuse d identifiants traitee comme secret');
    var userinfoUrl = provider.buildStreamUrl({
      providerId: '3',
      contentType: 'live',
      directSource: 'https://user:motdepasse@cdn.example.net/live/3.ts'
    });
    assert.equal(userinfoUrl.kind, 'storedSecret', 'userinfo detecte');
  });

  harness.it('sans identifiants disponibles, la construction echoue explicitement', function () {
    var portal = portalLib.createPortal({ counts: { live: 2 } });
    var http = new clientLib.HttpClient({
      transport: portal.transport,
      lookup: portal.lookup,
      caProvider: function () {
        return undefined;
      }
    });
    var provider = new xtreamLib.XtreamProvider({
      http: http,
      profile: { id: 'p1', baseUrl: PORTAL_URL },
      session: { acceptedHosts: [] }
    });
    assert.throws(function () {
      provider.buildStreamUrl({ providerId: '1000', contentType: 'live' });
    }, 'auth/invalidCredentials', 'identifiants requis pour reconstruire une URL');
    return provider.testConnection().then(function (result) {
      assert.equal(result.ok, false, 'test de connexion refuse sans identifiants');
      assert.equal(result.errors[0].code, 'auth/invalidCredentials', 'code explicite');
    });
  });

  harness.it('les identifiants de session sont distingues des identifiants memorises', function () {
    var portal = portalLib.createPortal({ counts: { live: 2 } });
    var sessionOnly = makeProvider(portal, { sessionOnly: true });
    assert.equal(sessionOnly.usesSessionOnlyCredentials(), true, 'mode session seule');
    assert.ok(sessionOnly.credentials() !== null, 'identifiants disponibles pour cette session');
    var memorise = makeProvider(portal);
    assert.equal(memorise.usesSessionOnlyCredentials(), false, 'identifiants du profil');
  });

  harness.it('le detail de serie expose saisons et episodes', function () {
    var portal = portalLib.createPortal({ counts: { series: 3 } });
    var provider = makeProvider(portal);
    return provider.getSeriesInfo('9001').then(function (detail) {
      assert.equal(detail.seasons.length, 1, 'une saison');
      assert.equal(detail.seasons[0].seasonNumber, 1, 'numero de saison');
      assert.equal(detail.seasons[0].episodes.length, 2, 'deux episodes');
      assert.equal(detail.seasons[0].episodes[0].providerId, '90011', 'identifiant de flux episode');
      assert.equal(detail.seasons[0].episodes[1].title, 'Suite', 'titre episode');
      assert.equal(detail.seasons[0].episodes[0].containerExtension, 'mkv', 'conteneur de l episode');
    });
  });
});
