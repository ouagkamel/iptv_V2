'use strict';

/**
 * Couche LS2 du service (§2.6, §15.4) : les douze commandes déclarées dans le manifeste, l'enveloppe
 * unique, la règle « aucune URL de flux hors `resolveStream` », l'unicité de l'opération lourde par
 * profil, l'annulation coopérative, la suppression de profil et le diagnostic sans secret.
 *
 * Le service est instancié sur un **faux bus** (aucun `webos-service` requis) et un **faux bus DB8** :
 * les tests tournent sur Node 8.12 comme sur Node 20, sans TV et sans réseau.
 */

var assert = require('./assert');
var harness = require('./harness');
var portalLib = require('./fake-portal');
var fs = require('fs');
var os = require('os');
var path = require('path');

var libRoot = path.join(__dirname, '..', 'service', 'com.ouagkamel.app.iptvplayer.service', 'lib');
var serviceDir = path.join(__dirname, '..', 'service', 'com.ouagkamel.app.iptvplayer.service');
var clientLib = require(path.join(libRoot, 'service', 'http', 'httpClient'));
var db8Lib = require(path.join(libRoot, 'service', 'db8', 'client'));
var serviceLib = require(path.join(libRoot, 'service', 'ls2', 'service'));
var busLib = require(path.join(libRoot, 'service', 'ls2', 'bus'));
var envelopeLib = require(path.join(libRoot, 'service', 'ls2', 'envelope'));

var PORTAL_URL = 'https://portal.example.com';
var USERNAME = 'utilisateur-test';
var PASSWORD = 'motdepasse-de-test';

function tempRoot(name) {
  var dir = path.join(os.tmpdir(), 'iptv-service-' + name + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
  fs.mkdirSync(dir);
  return dir;
}

function makeStack(portalOptions, options) {
  options = options || {};
  var portal = portalLib.createPortal(
    Object.assign({ username: USERNAME, password: PASSWORD, counts: { live: 6, vod: 2, series: 1 } }, portalOptions || {})
  );
  var http = new clientLib.HttpClient({
    transport: portal.transport,
    lookup: portal.lookup,
    caProvider: function () {
      return undefined;
    }
  });
  var fakeDb = new db8Lib.FakeDb8Bus();
  var db = new db8Lib.Db8Client({ call: fakeDb.call, appId: db8Lib.APP_ID });
  var logs = [];
  var storageRoot = options.storageRoot || tempRoot('ls2');
  var service = new serviceLib.IptvService({
    db: db,
    http: http,
    storageRoot: storageRoot,
    onLog: function (line) {
      logs.push(line);
    }
  });
  var bus = busLib.createFakeBus();
  service.register(bus);
  return {
    portal: portal,
    http: http,
    db: db,
    fakeDb: fakeDb,
    service: service,
    bus: bus,
    logs: logs,
    storageRoot: storageRoot
  };
}

function addProfile(stack, options) {
  options = options || {};
  return stack.service.profiles.save({
    id: options.id || 'p1',
    name: 'Maison',
    kind: 'xtream',
    providerType: 'xtream',
    preferredLiveFormat: 'auto',
    status: 'ok',
    baseUrl: options.baseUrl || PORTAL_URL,
    lanAllowed: options.lanAllowed === true,
    persistSecrets: options.persistSecrets === true
  });
}

function credentials(stack) {
  return { username: stack.portal.config.username, password: stack.portal.config.password };
}

/** Import d'un type de contenu, suivi jusqu'à la réponse finale de l'abonnement. */
function importContent(stack, options) {
  options = options || {};
  var payload = {
    profileId: options.profileId || 'p1',
    kind: 'xtream',
    contentType: options.contentType || 'live',
    source: { url: options.url || PORTAL_URL, credentials: options.credentials || credentials(stack) },
    consent: { persistSecrets: options.persistSecrets === true, insecureHttp: options.insecureHttp === true }
  };
  if (options.groups) payload.groups = options.groups;
  return stack.bus.invoke('importPlaylist', payload, { subscribed: options.subscribed !== false }).then(function (initial) {
    var first = initial[0];
    var jobId = first && first.data ? first.data.jobId : null;
    return waitFor(
      function () {
        return repliesOf(stack.bus, 'importPlaylist').some(function (reply) {
          return (
            reply &&
            reply.returnValue === true &&
            reply.data &&
            reply.data.final === true &&
            reply.data.jobId === jobId
          );
        });
      },
      20000
    ).then(function () {
      return first;
    });
  });
}

function repliesOf(bus, command) {
  return bus.log
    .filter(function (entry) {
      return entry.command === command;
    })
    .map(function (entry) {
      return entry.reply;
    });
}

function waitFor(predicate, timeoutMs) {
  var deadline = Date.now() + (timeoutMs === undefined ? 5000 : timeoutMs);
  return new Promise(function (resolve, reject) {
    var tick = function () {
      var value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('condition non atteinte dans le delai du test'));
        return;
      }
      setTimeout(tick, 2);
    };
    tick();
  });
}

function jsonOf(reply) {
  return JSON.stringify(reply === undefined ? null : reply);
}

/* ---------------------------------------------------------------- commandes */

harness.describe('Service LS2 : commandes et enveloppe (§2.6, §15.4)', function () {
  harness.it('les douze commandes du manifeste sont enregistrees et aucune n est publique', function () {
    var stack = makeStack();
    var manifest = JSON.parse(fs.readFileSync(path.join(serviceDir, 'services.json'), 'utf8'));
    var declared = manifest.services[0].commands.map(function (command) {
      assert.equal(command.public, false, 'commande non publique : ' + command.name);
      return command.name;
    });
    var registered = Object.keys(stack.bus.handlers);
    assert.deepEqual(registered.slice().sort(), declared.slice().sort(), 'commandes enregistrees = commandes declarees');
    assert.equal(registered.length, 12, 'douze commandes');
    assert.equal(stack.bus.handlers.testProfile instanceof Function, true, 'gestionnaire enregistre');
  });

  harness.it('testProfile expose le compte sans journaliser ni renvoyer les identifiants', function () {
    var stack = makeStack();
    return stack.bus
      .invoke('testProfile', {
        kind: 'xtream',
        baseUrl: PORTAL_URL,
        username: USERNAME,
        password: PASSWORD,
        lanAllowed: false
      })
      .then(function (replies) {
        var reply = replies[0];
        assert.equal(reply.returnValue, true, 'appel accepte');
        assert.equal(reply.data.ok, true, 'portail joignable');
        assert.equal(reply.data.account.status, 'Active', 'etat du compte');
        var text = jsonOf(reply) + ' ' + stack.logs.join(' | ');
        assert.ok(text.indexOf(PASSWORD) === -1, 'mot de passe absent de la reponse et des journaux');
        assert.ok(text.indexOf(USERNAME) === -1, 'identifiant absent de la reponse et des journaux');
        assert.equal(stack.portal.callsFor('get_live_streams').length, 0, 'testProfile n importe rien');
      });
  });

  harness.it('des identifiants refuses donnent auth/invalidCredentials sans nouvel essai', function () {
    var stack = makeStack();
    return stack.bus
      .invoke('testProfile', {
        kind: 'xtream',
        baseUrl: PORTAL_URL,
        username: USERNAME,
        password: 'mauvais-mot-de-passe',
        lanAllowed: false
      })
      .then(function (replies) {
        var reply = replies[0];
        assert.equal(reply.returnValue, true, 'le test de source repond toujours son verdict');
        assert.equal(reply.data.ok, false, 'source refusee');
        assert.equal(reply.data.errors[0].code, 'auth/invalidCredentials', 'code normalise');
        assert.equal(reply.data.errors[0].retryable, false, 'non rejouable');
        var authCalls = stack.portal.calls.filter(function (call) {
          return call.path.indexOf('/player_api.php') === 0;
        });
        assert.equal(authCalls.length, 1, 'un seul essai d authentification');
        assert.equal(jsonOf(reply).indexOf('mauvais-mot-de-passe'), -1, 'mot de passe jamais renvoye');
      });
  });

  harness.it('importPlaylist refuse M3U et les types de contenu non importables', function () {
    var stack = makeStack();
    return addProfile(stack)
      .then(function () {
        return stack.bus.invoke('importPlaylist', { profileId: 'p1', kind: 'm3u' });
      })
      .then(function (replies) {
        assert.equal(replies[0].returnValue, false, 'M3U refuse');
        assert.equal(replies[0].error.code, 'provider/unsupported', 'M3U arrive en V1-D');
        return stack.bus.invoke('importPlaylist', {
          profileId: 'p1',
          kind: 'xtream',
          contentType: 'episode',
          source: { url: PORTAL_URL, credentials: credentials(stack) },
          consent: { persistSecrets: true }
        });
      })
      .then(function (replies) {
        assert.equal(replies[0].returnValue, false, 'type non importable refuse');
        assert.equal(replies[0].error.code, 'profile/invalid', 'code explicite');
      });
  });

  harness.it('une commande inconnue ne sort jamais de l enveloppe', function () {
    var stack = makeStack();
    stack.bus.register('commandeInconnue', stack.service.commands().testProfile);
    return stack.bus.invoke('commandeInconnue', {}).then(function (replies) {
      assert.equal(replies.length, 1, 'une seule reponse');
      assert.equal(replies[0].returnValue, false, 'aucune exception ne remonte au bus');
      assert.equal(replies[0].error.code, 'profile/invalid', 'erreur normalisee de la commande');
    });
  });
});

/* ------------------------------------------------------- import et progression */

harness.describe('Service LS2 : import, progression et annulation (§15.4, §15.5)', function () {
  harness.it('un import complet publie les phases du §15.5 puis l etat final', function () {
    var stack = makeStack();
    return addProfile(stack)
      .then(function () {
        return importContent(stack, { persistSecrets: true });
      })
      .then(function (initial) {
        assert.equal(initial.returnValue, true, 'appel accepte');
        assert.equal(initial.data.contentType, 'live', 'type de contenu du job');
        assert.equal(initial.data.indexVersion, 1, 'premiere version d index');
        assert.ok(initial.data.jobId, 'identifiant de job retourne');

        var phases = [];
        repliesOf(stack.bus, 'importPlaylist').forEach(function (reply) {
          var job = reply && reply.data && reply.data.job;
          if (job && phases.indexOf(job.phase) === -1) phases.push(job.phase);
        });
        assert.deepEqual(
          phases,
          ['downloading', 'parsing', 'writing', 'validating', 'swapping', 'done'],
          'phases persistees dans l ordre §15.5'
        );

        var final = repliesOf(stack.bus, 'importPlaylist').filter(function (reply) {
          return reply && reply.data && reply.data.final === true;
        })[0];
        assert.equal(final.data.job.phase, 'done', 'job termine');
        assert.equal(final.data.job.resumable, false, 'un job termine n est plus repris');
        assert.equal(final.indexVersion, 1, 'version d index dans l enveloppe');

        return stack.bus.invoke('getImportJob', { jobId: initial.data.jobId });
      })
      .then(function (replies) {
        assert.equal(replies[0].returnValue, true, 'job relisible depuis DB8');
        assert.equal(replies[0].data.job.phase, 'done', 'etat persistant');
        assert.equal(replies[0].data.offerCleanup, false, 'pas de nettoyage propose');
      });
  });

  harness.it('une seule operation lourde par profil, annulable sans toucher a l index', function () {
    var stack = makeStack({ latencyMs: 2, counts: { live: 30, vod: 2, series: 1 } });
    var jobId = null;
    return addProfile(stack)
      .then(function () {
        return stack.bus.invoke(
          'importPlaylist',
          {
            profileId: 'p1',
            kind: 'xtream',
            contentType: 'live',
            source: { url: PORTAL_URL, credentials: credentials(stack) },
            consent: { persistSecrets: false }
          },
          { subscribed: true }
        );
      })
      .then(function (replies) {
        jobId = replies[0].data.jobId;
        return stack.bus.invoke('importPlaylist', {
          profileId: 'p1',
          kind: 'xtream',
          contentType: 'live',
          source: { url: PORTAL_URL, credentials: credentials(stack) },
          consent: { persistSecrets: false }
        });
      })
      .then(function (replies) {
        assert.equal(replies[0].returnValue, false, 'second import refuse');
        assert.equal(replies[0].error.code, 'catalog/busy', 'une operation a la fois par profil');
        return stack.bus.invoke('cancelOperation', { jobId: jobId });
      })
      .then(function (replies) {
        assert.equal(replies[0].returnValue, true, 'annulation acceptee');
        assert.equal(replies[0].data.cancelled, true, 'job en cours annule');
        return waitFor(function () {
          return Object.keys(stack.service.runningJobs).length === 0;
        }, 20000);
      })
      .then(function () {
        return stack.bus.invoke('getImportJob', { jobId: jobId });
      })
      .then(function (replies) {
        assert.equal(replies[0].data.job.phase, 'cancelled', 'job annule persiste');
        return stack.bus.invoke('getPage', { profileId: 'p1', contentType: 'live', order: 'source' });
      })
      .then(function (replies) {
        assert.equal(replies[0].returnValue, false, 'aucun index publie');
        assert.equal(replies[0].error.code, 'catalog/indexMissing', 'ancien index intact (ici aucun)');
      });
  });

  harness.it('un import vod alimente son propre index et sa propre version', function () {
    var stack = makeStack({ counts: { live: 6, vod: 3, series: 1 } });
    return addProfile(stack)
      .then(function () {
        return importContent(stack, { persistSecrets: true, contentType: 'live' });
      })
      .then(function () {
        return importContent(stack, { persistSecrets: true, contentType: 'vod' });
      })
      .then(function () {
        return stack.bus.invoke('getPage', { profileId: 'p1', contentType: 'vod', order: 'source' });
      })
      .then(function (replies) {
        assert.equal(replies[0].returnValue, true, 'index vod publie');
        assert.equal(replies[0].data.items.length, 3, 'trois films indexes');
        assert.equal(replies[0].indexVersion, 1, 'chaque type de contenu a sa propre version');
        return stack.bus.invoke('getPage', { profileId: 'p1', contentType: 'live', order: 'source' });
      })
      .then(function (replies) {
        assert.equal(replies[0].data.items.length, 6, 'index live intact');
      });
  });
});

/* -------------------------------------------------- ce que l interface ne voit pas */

harness.describe('Service LS2 : aucune URL de flux hors resolveStream', function () {
  function withIndex(options) {
    var stack = makeStack(options);
    return addProfile(stack)
      .then(function () {
        return importContent(stack, { persistSecrets: options && options.persistSecrets === true });
      })
      .then(function () {
        return stack;
      });
  }

  harness.it('paginer ne transporte ni URL, ni identifiant, ni cle', function () {
    return withIndex({ persistSecrets: true }).then(function (stack) {
      return stack.bus.invoke('getPage', { profileId: 'p1', contentType: 'live', order: 'source' }).then(function (replies) {
        var reply = replies[0];
        assert.equal(reply.returnValue, true, 'page servie');
        assert.equal(reply.data.items.length, 6, 'six chaines');
        assert.equal(reply.indexVersion, 1, 'version d index');
        assert.deepEqual(envelopeLib.findSecretPatterns(jsonOf(reply)), [], 'aucun motif interdit');
        assert.equal(jsonOf(reply).indexOf('/live/'), -1, 'aucune URL de flux dans la page');
        assert.equal(jsonOf(reply).indexOf('/movie/'), -1, 'aucune URL de flux VOD');
        assert.equal(jsonOf(reply).indexOf(PASSWORD) === -1, true, 'aucun mot de passe dans la page');
        var item = reply.data.items[0];
        assert.ok(item.ref && item.ref.providerId, 'reference opaque fournie');
        assert.equal(item.url, undefined, 'aucun champ url');
        assert.equal(item.streamUrl, undefined, 'aucun champ streamUrl');
        assert.equal(item.direct_source, undefined, 'aucune source directe du portail');
        assert.equal(item.playable, true, 'lisibilite annoncee sans exposer l URL');
      });
    });
  });

  harness.it('getDetails renvoie un streamRef opaque et le mode de lecture', function () {
    return withIndex({ persistSecrets: true }).then(function (stack) {
      return stack.bus
        .invoke('getDetails', { profileId: 'p1', contentType: 'live', ref: { providerId: '1000' } })
        .then(function (replies) {
          var detail = replies[0].data;
          assert.equal(replies[0].returnValue, true, 'detail servi');
          assert.equal(/^v1:\d+:[0-9a-f]{8}$/.test(detail.streamRef), true, 'reference opaque versionnee : ' + detail.streamRef);
          assert.equal(detail.streamMode, 'storedSecret', 'mode de lecture declare');
          assert.deepEqual(envelopeLib.findSecretPatterns(jsonOf(replies[0])), [], 'aucun motif interdit');
          assert.equal(jsonOf(replies[0]).indexOf('/live/'), -1, 'aucune URL de flux dans le detail');
          assert.equal(detail.url, undefined, 'aucun champ url dans le detail');
        });
    });
  });

  harness.it('resolveStream est la seule commande qui renvoie une URL de lecture', function () {
    return withIndex({ persistSecrets: true }).then(function (stack) {
      return stack.bus
        .invoke('resolveStream', { profileId: 'p1', ref: { contentType: 'live', providerId: '1000' } })
        .then(function (replies) {
          var resolution = replies[0].data;
          assert.equal(replies[0].returnValue, true, 'resolution servie');
          assert.equal(resolution.kind, 'storedSecret', 'mode memorise');
          assert.equal(/^https:\/\/portal\.example\.com\/live\//.test(resolution.url), true, 'URL du portail construite');
          assert.equal(resolution.expiresAt, undefined, 'pas d expiration inventee');
          var logs = stack.logs.join(' | ');
          assert.equal(logs.indexOf('http'), -1, 'aucune URL dans les journaux du service');
          assert.equal(logs.indexOf(PASSWORD), -1, 'aucun identifiant dans les journaux');
          assert.equal(logs.indexOf(USERNAME), -1, 'aucun nom d utilisateur dans les journaux');
        });
    });
  });

  harness.it('sans identifiants memorises, resolveStream demande de ressaisir le profil', function () {
    var stack = makeStack();
    return addProfile(stack)
      .then(function () {
        // import sans consentement : seul un prefixe sans secret est conserve (mode `derived`)
        return importContent(stack, { persistSecrets: false });
      })
      .then(function () {
        // nouvelle instance de service : les identifiants de session ont disparu avec elle
        var restarted = new serviceLib.IptvService({
          db: stack.db,
          http: stack.http,
          storageRoot: stack.storageRoot,
          onLog: function () {}
        });
        var bus = busLib.createFakeBus();
        restarted.register(bus);
        return bus.invoke('resolveStream', { profileId: 'p1', ref: { contentType: 'live', providerId: '1000' } }).then(function (replies) {
          assert.equal(replies[0].returnValue, false, 'resolution refusee');
          assert.equal(replies[0].error.code, 'auth/invalidCredentials', 'identifiants non memorises');
          assert.equal(replies[0].error.retryable, false, 'nouvelle tentative inutile');
          return bus.invoke('getDetails', { profileId: 'p1', contentType: 'live', ref: { providerId: '1000' } });
        });
      })
      .then(function (replies) {
        assert.equal(replies[0].data.streamMode, 'derived', 'mode non memorise declare');
      });
  });
});

/* ------------------------------------------------------------ profil et diagnostic */

harness.describe('Service LS2 : profil et diagnostic (§9.2, §15.4)', function () {
  harness.it('deleteProfile efface les donnees DB8, la cle maitre et les fichiers', function () {
    var stack = makeStack();
    var profileDir = null;
    return addProfile(stack)
      .then(function () {
        return importContent(stack, { persistSecrets: true });
      })
      .then(function () {
        profileDir = stack.service.profileRootDir('p1');
        assert.equal(fs.existsSync(profileDir), true, 'index ecrit dans le repertoire prive du service');
        return stack.bus.invoke('deleteProfile', { profileId: 'p1' });
      })
      .then(function (replies) {
        assert.equal(replies[0].returnValue, true, 'suppression acceptee');
        assert.equal(replies[0].data.deleted, true, 'profil supprime');
        assert.equal(replies[0].data.masterKeyRemoved, true, 'cle maitre detruite avec le profil');
        assert.equal(fs.existsSync(profileDir), false, 'fichiers du profil effaces');
        assert.ok(jsonOf(stack.fakeDb.stores).indexOf(PASSWORD) === -1, 'aucun secret en DB8 apres suppression');
        return stack.bus.invoke('getPage', { profileId: 'p1', contentType: 'live', order: 'source' });
      })
      .then(function (replies) {
        assert.equal(replies[0].returnValue, false, 'plus aucun index');
        assert.equal(replies[0].error.code, 'catalog/indexMissing', 'index supprime avec le profil');
      });
  });

  harness.it('diagnostics ne contient aucun secret et separe le certifie du reste', function () {
    var stack = makeStack();
    return addProfile(stack)
      .then(function () {
        return importContent(stack, { persistSecrets: true });
      })
      .then(function () {
        return stack.bus.invoke('diagnostics', {});
      })
      .then(function (replies) {
        var reply = replies[0];
        assert.equal(reply.returnValue, true, 'diagnostic servi');
        var text = jsonOf(reply);
        assert.deepEqual(envelopeLib.findSecretPatterns(text), [], 'aucun motif interdit');
        assert.ok(text.indexOf(PASSWORD) === -1, 'aucun mot de passe');
        assert.ok(text.indexOf(USERNAME) === -1, 'aucun nom d utilisateur');
        assert.ok(text.indexOf(PORTAL_URL) !== -1, 'adresse de portail presente pour le diagnostic');
        assert.ok(text.indexOf(USERNAME) === -1 && text.indexOf(PASSWORD) === -1, 'aucun identifiant, meme dans l adresse');
        assert.equal(reply.data.indexes.length, 1, 'index decrit');
        assert.equal(reply.data.indexes[0].entryCount, 6, 'compteur d index');
        assert.equal(reply.data.indexes[0].contentType, 'live', 'type de contenu');
        assert.equal(reply.data.jobs.length, 1, 'job decrit sans secret');
        assert.equal(reply.data.profiles.length, 1, 'profil decrit');
        assert.equal(reply.data.capabilities['m3u'], 'non livre (V1-D)', 'capacite non livree annoncee');
        assert.ok(reply.data.capabilities['player.hls'].indexOf('non certifie') === 0, 'rien n est promis sans mesure TV');
        assert.equal(reply.data.requestedBy, 'local', 'diagnostic local par defaut');
      });
  });

  harness.it('le profil assaini ne laisse passer ni identifiant ni adresse porteuse de secret', function () {
    var repositoriesLib = require(path.join(libRoot, 'service', 'db8', 'repositories'));
    var redacted = repositoriesLib.redactProfile({
      id: 'p2',
      name: 'Second',
      kind: 'xtream',
      providerType: 'xtream',
      preferredLiveFormat: 'auto',
      status: 'ok',
      baseUrl: 'http://utilisateur:motdepasse@portail.example.com:8080/portal',
      username: 'utilisateur',
      password: 'motdepasse'
    });
    var text = jsonOf(redacted);
    assert.equal(redacted.hasCredentials, true, 'memorisation signalee sans identifiant');
    assert.equal(redacted.username, undefined, 'nom d utilisateur retire');
    assert.equal(redacted.password, undefined, 'mot de passe retire');
    assert.ok(text.indexOf('motdepasse') === -1, 'adresse redigee : aucun secret');
    assert.ok(text.indexOf('portail.example.com') !== -1, 'hote conserve pour le diagnostic');
  });

  harness.it('une reponse qui porterait une URL de flux est refusee par le controle de surete', function () {
    var reply = envelopeLib.ls2Ok({ items: [{ title: 'Chaine', url: 'https://cdn.example.com/live/user/pass/1.ts' }] });
    var refused = null;
    try {
      envelopeLib.assertReplySafe(reply);
    } catch (error) {
      refused = error;
    }
    assert.ok(refused, 'controle de surete declenche');
    assert.equal(refused.code, 'internal/unexpected', 'code normalise');
    // la seule exception autorisee est resolveStream, borne a 8 Kio
    assert.equal(envelopeLib.assertReplySafe(reply, { allowStreamUrl: true, maxBytes: 8 * 1024 }), undefined, 'resolveStream exempte');
  });
});

/**
 * Régression phase 0A : une page **réelle** était refusée de bout en bout (« reponse refusee par le
 * controle de surete ») parce qu'un logo du catalogue (`images.pluto.tv/channels/<24 hex>/…`)
 * déclenchait la règle « segment base64 long ». Le contrôle doit viser les secrets, pas les URL.
 */
harness.describe('Controle de surete des reponses (§15.4) : secrets, pas donnees du catalogue', function () {
  harness.it('un logo reel a identifiant long ne fait plus refuser la page', function () {
    var page = {
      returnValue: true,
      indexVersion: 1,
      data: {
        items: [
          { ref: { profileId: 'p1', contentType: 'live', providerId: '1000', displayName: 'Bein' }, title: 'Bein',
            logoOrPosterUrl: 'https://images.pluto.tv/channels/64bab8ba5dc1660008969b5a/colorLogoPNG.png' },
          { ref: { profileId: 'p1', contentType: 'live', providerId: '1001', displayName: 'TF1' }, title: 'TF1',
            logoOrPosterUrl: 'https://img.example.com/p/8023c9a4b7e1f6d5038a9c7b4e2f1d0a9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4/poster.jpg' }
        ]
      }
    };
    assert.deepEqual(envelopeLib.findSecretPatterns(JSON.stringify(page)), [], 'aucun motif interdit');
    assert.equal(envelopeLib.assertReplySafe(page), undefined, 'page acceptee');
  });

  harness.it('les secrets restent refuses hors resolveStream', function () {
    var cle = Buffer.alloc(32, 7).toString('base64');
    assert.deepEqual(
      envelopeLib.findSecretPatterns(JSON.stringify({ v: cle })).sort(),
      ['segment base64 long'],
      'cle de chiffrement hors URL detectee'
    );
    assert.deepEqual(
      envelopeLib.findSecretPatterns(JSON.stringify({ masterKey: cle })).sort(),
      ['cle de chiffrement', 'segment base64 long'],
      'champ de cle nomme explicitement'
    );
    assert.deepEqual(
      envelopeLib.findSecretPatterns(JSON.stringify({ url: 'http://user:pass@cdn.example.com/a.ts' })).sort(),
      ['userinfo'],
      'identifiants dans l URL'
    );
    assert.deepEqual(
      envelopeLib.findSecretPatterns(JSON.stringify({ url: 'http://host/hls/1.ts?username=bob&password=secret' })).sort(),
      ['identifiant en requete'],
      'identifiants en requete'
    );
    assert.deepEqual(
      envelopeLib.findSecretPatterns(JSON.stringify({ detail: { streamUrl: 'http://host/live/bob/secret/1000.ts' } })).sort(),
      ['URL de flux'],
      'URL de flux hors resolveStream'
    );
    var refused = null;
    try {
      envelopeLib.assertReplySafe({ returnValue: true, data: { url: 'http://user:pass@host/live/1.ts' } });
    } catch (error) {
      refused = error;
    }
    assert.ok(refused, 'controle de surete declenche');
  });
});

/**
 * Aucune commande LS2 ne crée de profil : `importPlaylist` porte `kind` et `source.url`, il doit donc
 * **créer le profil au premier import**. Sans cela, un appareil neuf — simulateur, ou téléviseur
 * après effacement — répondait « profil inconnu » à la première tentative d'import (constaté en 0A).
 */
harness.describe('Premier import sur un appareil neuf : le profil est cree', function () {
  harness.it('importPlaylist cree le profil absent et poursuit l import', function () {
    var stack = makeStack();
    return stack.service.profiles
      .list()
      .then(function (avant) {
        assert.equal(avant.length, 0, 'aucun profil au depart');
        return importContent(stack, { contentType: 'live' });
      })
      .then(function (initial) {
        assert.equal(initial.returnValue, true, 'import accepte');
        assert.equal(initial.data.profilCree, true, 'creation signalee a l appelant');
        return stack.service.profiles.list();
      })
      .then(function (apres) {
        assert.equal(apres.length, 1, 'profil cree');
        assert.equal(apres[0].id, 'p1', 'identifiant demande');
        assert.equal(apres[0].baseUrl.indexOf(PORTAL_URL) === 0, true, 'adresse du portail retenue');
        assert.equal(apres[0].name, 'portal.example.com', 'nom deduit du nom d hote, sans identifiants');
        assert.equal(apres[0].persistSecrets, false, 'identifiants non memorises sans consentement');
        // second import : le profil existe, aucune creation signalee
        return importContent(stack, { contentType: 'live', credentials: credentials(stack) });
      })
      .then(function (second) {
        assert.equal(second.data.profilCree, false, 'profil deja present : pas de nouvelle creation');
      });
  });

  harness.it('sans adresse de portail, l import reste refuse clairement', function () {
    var stack = makeStack();
    return stack.bus
      .invoke('importPlaylist', {
        profileId: 'p9',
        kind: 'xtream',
        contentType: 'live',
        source: { credentials: { username: USERNAME, password: PASSWORD } },
        consent: { persistSecrets: false }
      })
      .then(function (replies) {
        assert.equal(replies[0].returnValue, false, 'refus');
        assert.equal(replies[0].error.code, 'profile/invalid', 'code normalise');
        assert.ok(replies[0].error.message.indexOf('adresse de portail') !== -1, 'message explicite');
      });
  });

  harness.it('diagnostics annonce l etat de DB8 sans echouer', function () {
    var stack = makeStack();
    return addProfile(stack)
      .then(function () {
        return stack.bus.invoke('diagnostics', {});
      })
      .then(function (replies) {
        assert.equal(replies[0].returnValue, true, 'diagnostic servi');
        assert.equal(replies[0].data.db.ok, true, 'base accessible signalee');
        assert.equal(replies[0].data.db.profiles, 1, 'nombre de profils');
      });
  });
});

/**
 * Un compte inactif ou expiré doit être **dit** avant l'import : sans contrôle préalable, chaque
 * appel fournisseur échoue et l'erreur affichée parle de réseau — fausse piste constatée en 0A avec
 * un abonnement de test arrivé à échéance.
 */
harness.describe('Import refuse proprement sur un compte inutilisable (auth/*)', function () {
  harness.it('compte expire : import refuse avec auth/expired, aucun job lance', function () {
    var stack = makeStack({ account: { status: 'Expired', expireInDays: -2 } });
    return addProfile(stack)
      .then(function () {
        return stack.bus.invoke('importPlaylist', {
          profileId: 'p1',
          kind: 'xtream',
          contentType: 'live',
          source: { url: PORTAL_URL, credentials: credentials(stack) },
          consent: { persistSecrets: false }
        });
      })
      .then(function (replies) {
        assert.equal(replies[0].returnValue, false, 'import refuse');
        assert.equal(replies[0].error.code, 'auth/expired', 'code normalise');
        assert.ok(replies[0].error.message.indexOf('expire') !== -1 || replies[0].error.message.indexOf('inactif') !== -1, 'cause dite : ' + replies[0].error.message);
        return stack.bus.invoke('getImportJob', { jobId: 'xtream:p1:live:1' });
      })
      .then(function (replies) {
        assert.equal(replies[0].returnValue, false, 'aucun job enregistre');
      });
  });

  harness.it('identifiants refuses : import refuse avec auth/invalidCredentials', function () {
    var stack = makeStack({ account: { auth: 0 } });
    return addProfile(stack)
      .then(function () {
        return stack.bus.invoke('importPlaylist', {
          profileId: 'p1',
          kind: 'xtream',
          contentType: 'live',
          source: { url: PORTAL_URL, credentials: credentials(stack) },
          consent: { persistSecrets: false }
        });
      })
      .then(function (replies) {
        assert.equal(replies[0].returnValue, false, 'import refuse');
        assert.equal(replies[0].error.code, 'auth/invalidCredentials', 'code normalise');
      });
  });

  harness.it('compte actif : l import reste accepte', function () {
    var stack = makeStack();
    return addProfile(stack)
      .then(function () {
        return importContent(stack, { contentType: 'live' });
      })
      .then(function (initial) {
        assert.equal(initial.returnValue, true, 'import accepte');
      });
  });
});

/**
 * HTTP clair (§8.2) : le service doit **refuser immédiatement** — avec l'hôte à confirmer — au lieu
 * de lancer un import qui échouerait plus loin. Constaté en phase 0A : l'utilisateur voyait
 * `security/insecurescheme` au test de source puis un `internal/unexpected` à l'import, sans lien
 * apparent entre les deux.
 */
harness.describe('Portail en HTTP clair : refus explicite, puis import apres confirmation', function () {
  var URL_CLAIR = 'http://portal.example.com';

  harness.it('testProfile signale l hote a confirmer (hint)', function () {
    var stack = makeStack();
    return stack.bus
      .invoke('testProfile', { profileId: 'p1', kind: 'xtream', baseUrl: URL_CLAIR, username: USERNAME, password: PASSWORD })
      .then(function (replies) {
        var verdict = replies[0].data;
        var erreur = verdict.errors.filter(function (entree) {
          return entree.code === 'security/insecureScheme';
        })[0];
        assert.ok(erreur, 'erreur security/insecureScheme presente');
        assert.equal(erreur.hint, 'hote:portal.example.com', 'hote a confirmer transmis');
        assert.equal(verdict.ok, false, 'verdict non conforme sans confirmation');
      });
  });

  harness.it('importPlaylist refuse sans confirmation, sans creer de job', function () {
    var stack = makeStack();
    return addProfile(stack, { baseUrl: URL_CLAIR }).then(function () {
      return stack.bus
        .invoke('importPlaylist', {
          profileId: 'p1',
          kind: 'xtream',
          contentType: 'live',
          source: { url: URL_CLAIR, credentials: credentials(stack) },
          consent: { persistSecrets: false }
        }, { subscribed: true })
        .then(function (replies) {
          var premiere = replies[0];
          assert.equal(premiere.returnValue, false, 'import refuse');
          assert.equal(premiere.error.code, 'security/insecureScheme', 'code normalise');
          assert.equal(premiere.error.hint, 'hote:portal.example.com', 'hote a confirmer');
          var jobs = replies.filter(function (reply) {
            return reply.data && reply.data.job;
          });
          assert.equal(jobs.length, 0, 'aucun job lance');
        });
    });
  });

  harness.it('avec consent.insecureHttp, l import aboutit', function () {
    var stack = makeStack();
    return addProfile(stack, { baseUrl: URL_CLAIR })
      .then(function () {
        return importContent(stack, {
          credentials: credentials(stack),
          insecureHttp: true,
          url: URL_CLAIR
        });
      })
      .then(function () {
        // `importContent` rend la **première** réponse (le jobId) : l'état final se lit dans la
        // dernière réponse publiée sur l'abonnement.
        var finales = repliesOf(stack.bus, 'importPlaylist').filter(function (reply) {
          return reply && reply.data && reply.data.final === true;
        });
        assert.equal(finales.length >= 1, true, 'reponse finale publiee');
        assert.equal(finales[finales.length - 1].data.job.phase, 'done', 'phase finale : done');
        return stack.service.profiles.list();
      })
      .then(function (profils) {
        assert.equal(profils.length, 1, 'profil unique');
      });
  });
});

/**
 * Un échec d'import doit porter sa **cause réelle** : la réponse finale annonçait
 * « internal/unexpected — import interrompu avant la bascule », ce qui ne permettait aucune action.
 */
harness.describe('Echec d import : la cause reelle est transmise', function () {
  harness.it('refus du fournisseur pendant l import : code auth/* conserve', function () {
    var stack = makeStack({ failure: { action: 'get_live_streams', status: 401, times: 50 } });
    return addProfile(stack)
      .then(function () {
        // pas d'`importContent` ici : cet import n'atteint jamais la phase `done`, il faut donc
        // attendre la **réponse d'échec** publiée sur l'abonnement.
        return stack.bus.invoke(
          'importPlaylist',
          {
            profileId: 'p1',
            kind: 'xtream',
            contentType: 'live',
            source: { url: PORTAL_URL, credentials: credentials(stack) },
            consent: { persistSecrets: false }
          },
          { subscribed: true }
        );
      })
      .then(function () {
        return waitFor(
          function () {
            return repliesOf(stack.bus, 'importPlaylist').some(function (reply) {
              return reply && reply.returnValue === false && reply.error;
            });
          },
          20000
        );
      })
      .then(function () {
        var refus = repliesOf(stack.bus, 'importPlaylist').filter(function (reply) {
          return reply && reply.returnValue === false && reply.error;
        });
        assert.equal(refus.length >= 1, true, 'echec publie sur l abonnement');
        var erreur = refus[refus.length - 1].error;
        assert.equal(erreur.code !== 'internal/unexpected', true, 'cause reelle et non generique : ' + erreur.code);
        assert.ok(
          erreur.code.indexOf('auth/') === 0 || erreur.code.indexOf('network/') === 0 || erreur.code === 'security/insecureScheme',
          'code exploitable : ' + erreur.code
        );
        // la cause figure aussi dans l'état du job, pour un appelant qui reprend après coup
        var jobs = repliesOf(stack.bus, 'importPlaylist').filter(function (reply) {
          return reply && reply.data && reply.data.job && reply.data.job.phase === 'failed';
        });
        assert.equal(jobs.length >= 1, true, 'job en phase failed');
      });
  });
});

/**
 * Panneau des catégories (Live en V1-A, VOD et Séries ensuite) : la liste vient de l'index déjà
 * écrit (`groups.bin`), dans l'ordre fournisseur, avec le nombre d'entrées — l'UI n'a rien à
 * recalculer et aucune requête fournisseur n'est refaite pour l'afficher.
 */
harness.describe('Categories du catalogue : ordre fournisseur et comptes', function () {
  harness.it('getCategories sert la liste indexee, sans recalcul cote UI', function () {
    var stack = makeStack();
    return addProfile(stack)
      .then(function () {
        return importContent(stack, { contentType: 'live' });
      })
      .then(function () {
        return stack.bus.invoke('getCategories', { profileId: 'p1', contentType: 'live' });
      })
      .then(function (replies) {
        assert.equal(replies[0].returnValue, true, 'commande servie');
        var data = replies[0].data;
        assert.equal(Array.isArray(data.categories), true, 'liste presente');
        assert.equal(data.categories.length > 0, true, 'au moins une categorie');
        assert.equal(data.total, 6, 'total des entrees indexees');
        var total = data.categories.reduce(function (somme, categorie) {
          return somme + categorie.count;
        }, 0);
        assert.equal(total, data.total, 'les comptes couvrent tout le catalogue');
        var ordres = data.categories.map(function (categorie) {
          return categorie.sourceOrder;
        });
        var tries = ordres.slice().sort(function (a, b) {
          return a - b;
        });
        assert.equal(ordres.join(','), tries.join(','), 'ordre fournisseur respecte');
        assert.ok(data.categories[0].name.length > 0, 'nom de categorie present');
        assert.equal(typeof replies[0].indexVersion, 'number', 'version d index renvoyee');
      });
  });

  harness.it('un contenu non indexe est refuse proprement', function () {
    var stack = makeStack();
    return addProfile(stack).then(function () {
      return stack.bus.invoke('getCategories', { profileId: 'p1', contentType: 'vod' });
    }).then(function (replies) {
      assert.equal(replies[0].returnValue, false, 'refus');
      assert.equal(replies[0].error.code, 'catalog/indexMissing', 'code normalise');
    });
  });
});
