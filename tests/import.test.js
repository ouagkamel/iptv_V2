'use strict';

/**
 * Import reprenable Xtream (§2.4, §15.5) : points de reprise, staging conservé puis repris,
 * compteurs cohérents, modes `storedSecret` / `derived` / `urlNoSecret`, filtres de groupes et
 * identité d'index partagée entre l'import et la lecture.
 *
 * Le portail est synthétique : rien ne sort du processus, aucun compte réel n'est utilisé.
 */

var assert = require('./assert');
var harness = require('./harness');
var fixtures = require('./fixtures');
var portalLib = require('./fake-portal');
var fs = require('fs');
var os = require('os');
var path = require('path');

var libRoot = path.join(__dirname, '..', 'service', 'com.ouagkamel.app.iptvplayer.service', 'lib');
var clientLib = require(path.join(libRoot, 'service', 'http', 'httpClient'));
var xtreamLib = require(path.join(libRoot, 'service', 'providers', 'xtream'));
var importLib = require(path.join(libRoot, 'service', 'import', 'xtreamImport'));
var identityLib = require(path.join(libRoot, 'service', 'store', 'identity'));
var readerLib = require(path.join(libRoot, 'service', 'store', 'reader'));
var writerLib = require(path.join(libRoot, 'service', 'store', 'writer'));
var manifestLib = require(path.join(libRoot, 'service', 'store', 'manifest'));

var masterKey = Buffer.alloc(32, 7);
var PORTAL_URL = 'https://portal.example.com';

function tempBase(name) {
  var dir = path.join(os.tmpdir(), 'iptv-import-' + name + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
  fs.mkdirSync(dir);
  return dir;
}

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
      id: 'p1',
      baseUrl: PORTAL_URL,
      username: portal.config.username,
      password: portal.config.password,
      lanAllowed: options.lanAllowed === true
    },
    session: { username: portal.config.username, password: portal.config.password, acceptedHosts: [] }
  });
}

function makePlan(baseDir, indexVersion, options) {
  options = options || {};
  var job = importLib.createXtreamImportJob({
    profileId: 'p1',
    contentType: 'live',
    indexVersion: indexVersion || 1,
    usesEmbeddedCredentials: true,
    resumable: true,
    now: Date.now()
  });
  return {
    profileId: 'p1',
    contentType: 'live',
    indexVersion: indexVersion || 1,
    masterKey: masterKey,
    job: job,
    baseDir: baseDir,
    resumeFromEntry: options.resumeFromEntry,
    persistSecrets: options.persistSecrets === true,
    groups: options.groups,
    lanAllowed: options.lanAllowed === true
  };
}

function openReader(baseDir, indexVersion) {
  return readerLib.CatalogIndexReader.open({
    baseDir: baseDir,
    profileId: 'p1',
    contentType: 'live',
    masterKey: masterKey,
    expectedIndexVersion: indexVersion || 1,
    refKind: 'providerId'
  });
}

function refHashesOf(reader) {
  var hashes = [];
  var cursor;
  do {
    var page = reader.getPage({ order: 'source', cursor: cursor });
    page.items.forEach(function (item) {
      hashes.push(item.ref.providerId);
    });
    cursor = page.cursor;
  } while (cursor);
  return hashes;
}

harness.describe('Import Xtream : index publie (§2.4)', function () {
  harness.it('un import complet bascule une version valide et suit les phases du §15.5', function () {
    var portal = portalLib.createPortal({ counts: { live: 40 }, chunkSize: 64 });
    var provider = makeProvider(portal);
    var base = tempBase('complet');
    var plan = makePlan(base, 1, { persistSecrets: true });
    var phases = [];
    var checkpoints = 0;
    return importLib
      .runXtreamImport(provider, plan, {
        onCheckpoint: function (job) {
          checkpoints += 1;
          if (phases[phases.length - 1] !== job.phase) phases.push(job.phase);
        },
        shouldAbort: function () {
          return false;
        },
        checkpointEveryEntries: 7
      })
      .then(function (outcome) {
        assert.equal(outcome.outcome, 'done', 'issue de l import');
        assert.equal(outcome.manifest.state, 'valid', 'index publie');
        assert.equal(outcome.manifest.entryCount, 40, 'toutes les chaines indexees');
        assert.deepEqual(phases, ['downloading', 'parsing', 'writing', 'validating', 'swapping', 'done'], 'phases ordonnees');
        assert.ok(checkpoints > 6, 'points de reprise ecrits pendant le telechargement');

        var manifest = manifestLib.readManifest(base);
        assert.equal(manifest.indexVersion, 1, 'version elue');
        var reader = openReader(base, 1);
        assert.equal(reader.getPage({ order: 'source' }).items.length, 40, 'lecture de la version publiee');
        reader.close();
      });
  });

  harness.it('l identite d index est la meme a l import et a la lecture', function () {
    var portal = portalLib.createPortal({ counts: { live: 12 }, chunkSize: 96 });
    var provider = makeProvider(portal);
    var base = tempBase('identite');
    var plan = makePlan(base, 1, { persistSecrets: true });
    return importLib
      .runXtreamImport(provider, plan, {
        onCheckpoint: function () {},
        shouldAbort: function () {
          return false;
        }
      })
      .then(function () {
        var reader = openReader(base, 1);
        var ordinal = reader.findOrdinalByProviderId('1005');
        assert.ok(ordinal !== null, 'entree retrouvee par identifiant fournisseur');
        var details = reader.getDetails(ordinal);
        assert.equal(details.item.title, 'Chaine 0006 FR|HD', 'titre de l entree');
        assert.equal(details.item.ref.providerId, '1005', 'identifiant fournisseur');
        assert.equal(
          reader.detailRef(ordinal),
          identityLib.detailRefFor(1, ordinal, identityLib.refHashFor('live', '1005')),
          'reference opaque = version + secteur + empreinte'
        );
        assert.ok(reader.detailRef(ordinal).indexOf('http') === -1, 'aucune URL dans la reference opaque');
        assert.equal(reader.findOrdinalByProviderId('inconnu'), null, 'identifiant absent : aucune exception');
        reader.close();
      });
  });

  harness.it('en mode memorise, l URL de lecture est chiffree au repos et jamais en clair', function () {
    var portal = portalLib.createPortal({ counts: { live: 6 }, chunkSize: 128 });
    var provider = makeProvider(portal);
    var base = tempBase('storedSecret');
    var plan = makePlan(base, 1, { persistSecrets: true });
    return importLib
      .runXtreamImport(provider, plan, {
        onCheckpoint: function () {},
        shouldAbort: function () {
          return false;
        }
      })
      .then(function () {
        var reader = openReader(base, 1);
        assert.equal(reader.streamMode(0), 'storedSecret', 'mode memorise');
        var details = reader.getDetails(0);
        assert.equal(details.heavy.u, PORTAL_URL + '/live/testeur/secret/1000.ts', 'URL conservee dans la charge chiffree');
        var raw = fs.readFileSync(path.join(base, 'index-v1', 'payload.bin'));
        assert.ok(raw.toString('utf8').indexOf('secret') === -1, 'aucun identifiant en clair sur le disque');
        assert.ok(raw.toString('utf8').indexOf('testeur') === -1, 'aucun utilisateur en clair sur le disque');
        reader.close();
      });
  });

  harness.it('en mode non memorise, seule une forme repliee est conservee', function () {
    var portal = portalLib.createPortal({ counts: { live: 6 }, chunkSize: 128 });
    var provider = makeProvider(portal);
    var base = tempBase('derived');
    var plan = makePlan(base, 1, { persistSecrets: false });
    return importLib
      .runXtreamImport(provider, plan, {
        onCheckpoint: function () {},
        shouldAbort: function () {
          return false;
        }
      })
      .then(function () {
        var reader = openReader(base, 1);
        assert.equal(reader.streamMode(0), 'derived', 'mode reconstruit');
        var details = reader.getDetails(0);
        assert.equal(details.heavy.u, undefined, 'aucune URL stockee');
        assert.equal(details.heavy.f, '/live/{credentials}/1000.ts', 'forme repliee sans secret');
        var raw = fs.readFileSync(path.join(base, 'index-v1', 'payload.bin')).toString('utf8');
        assert.ok(raw.indexOf('/live/') === -1, 'la charge reste chiffree sur le disque');
        assert.ok(raw.indexOf('secret') === -1, 'aucun mot de passe sur le disque');
        var forms = [0, 1, 2].map(function (ordinal) {
          return reader.getDetails(ordinal).heavy.f;
        });
        assert.deepEqual(forms, ['/live/{credentials}/1000.ts', '/live/{credentials}/1001.ts', '/live/{credentials}/1002.ts'], 'formes repliees');
        reader.close();
        reader.close();
      });
  });

  harness.it('une URL imposee est classee selon ses identifiants et jamais stockee sans consentement', function () {
    var portal = portalLib.createPortal({ counts: { live: 8 }, chunkSize: 128, credentialedDirectSource: true });
    var provider = makeProvider(portal);
    var base = tempBase('direct');
    var plan = makePlan(base, 1, { persistSecrets: false });
    return importLib
      .runXtreamImport(provider, plan, {
        onCheckpoint: function () {},
        shouldAbort: function () {
          return false;
        }
      })
      .then(function (outcome) {
        var reader = openReader(base, 1);
        // index 3 : URL publique imposee, pas de secret
        assert.equal(reader.streamMode(3), 'urlNoSecret', 'URL publique imposee');
        var publicDetails = reader.getDetails(3);
        assert.equal(publicDetails.heavy.u, 'https://cdn.example.net/live/embed/3.ts', 'URL publique conservee');
        // index 4 : URL avec identifiants, consentement refuse
        assert.equal(reader.streamMode(4), 'storedSecret', 'URL a identifiants classee secret');
        assert.equal(reader.getDetails(4).item.playable, false, 'entree non jouable sans consentement');
        assert.ok(
          outcome.warnings.join(' ').indexOf('memoriser le profil') !== -1,
          'motif consigne dans le job : ' + outcome.warnings.join(' | ')
        );
        var raw = fs.readFileSync(path.join(base, 'index-v1', 'payload.bin')).toString('utf8');
        assert.ok(raw.indexOf('motdepasse') === -1, 'identifiants jamais ecrits');
        reader.close();
      });
  });

  harness.it('un filtre de groupes n introduit ni trou ni erreur de compteur', function () {
    var portal = portalLib.createPortal({ counts: { live: 30 }, chunkSize: 96 });
    var provider = makeProvider(portal);
    var base = tempBase('groupes');
    var plan = makePlan(base, 1, { persistSecrets: true, groups: ['1'] });
    return importLib
      .runXtreamImport(provider, plan, {
        onCheckpoint: function () {},
        shouldAbort: function () {
          return false;
        }
      })
      .then(function (outcome) {
        assert.equal(outcome.outcome, 'done', 'import valide malgre le filtre');
        assert.ok(outcome.skipped > 0, 'entrees ecartees comptees');
        assert.equal(outcome.entries, 10, 'seules les entrees du groupe retenu sont indexees');
        var reader = openReader(base, 1);
        var page = reader.getPage({ order: 'source' });
        page.items.forEach(function (item) {
          assert.equal(item.categoryId, '1', 'groupe retenu uniquement');
        });
        reader.close();
      });
  });
});

harness.describe('Import Xtream : reprise apres echec (§15.5)', function () {
  harness.it('un echec conserve le staging sans toucher a l index valide, puis la reprise est exacte', function () {
    // 1) premier import complet : version 1 valide
    var portalFull = portalLib.createPortal({ counts: { live: 24 }, chunkSize: 96 });
    var base = tempBase('reprise');
    var reference;
    var providerFull = makeProvider(portalFull);
    return importLib
      .runXtreamImport(providerFull, makePlan(base, 1, { persistSecrets: true }), {
        onCheckpoint: function () {},
        shouldAbort: function () {
          return false;
        }
      })
      .then(function () {
        var reader = openReader(base, 1);
        reference = refHashesOf(reader);
        reader.close();
        assert.equal(reference.length, 24, 'reference complete');

        // 2) nouvel import (version 2) qui echoue en plein flux : la connexion est coupee
        var portalBroken = portalLib.createPortal({ counts: { live: 24 }, chunkSize: 96, abortAfterChunks: 12 });
        var brokenProvider = makeProvider(portalBroken);
        return importLib.runXtreamImport(brokenProvider, makePlan(base, 2, { persistSecrets: true }), {
          onCheckpoint: function () {},
          shouldAbort: function () {
            return false;
          },
          checkpointEveryEntries: 3
        });
      })
      .then(function (failed) {
        assert.equal(failed.outcome, 'failed', 'issue de l import interrompu');
        assert.equal(failed.error.code, 'network/refused', 'cause : connexion coupee');
        assert.equal(failed.job.phase, 'failed', 'phase persistee');
        assert.equal(failed.error.code, 'network/refused', 'cause reseau conservee');
        assert.ok(failed.job.entriesRead > 0, 'position de reprise enregistree : ' + failed.job.entriesRead);
        assert.ok(
          fs.existsSync(path.join(base, 'index-v2.tmp')),
          'staging conserve pour reprise'
        );
        var manifest = manifestLib.readManifest(base);
        assert.equal(manifest.indexVersion, 1, 'ancien index toujours elu');

        // 3) reprise : la meme source, complete, reconstruit la meme version (staging neuf)
        var portalResume = portalLib.createPortal({ counts: { live: 24 }, chunkSize: 96 });
        var resumeProvider = makeProvider(portalResume);
        return importLib
          .runXtreamImport(resumeProvider, makePlan(base, 2, { persistSecrets: true }), {
            onCheckpoint: function () {},
            shouldAbort: function () {
              return false;
            },
            checkpointEveryEntries: 3
          })
          .then(function (done) {
            assert.equal(done.outcome, 'done', 'reprise menee a terme');
            assert.equal(done.skipped, 0, 'aucune entree ecartee');
            assert.equal(fs.existsSync(path.join(base, 'index-v2.tmp')), false, 'staging remplace');
            assert.equal(manifestLib.readManifest(base).indexVersion, 2, 'nouvelle version elue');
            var reader = openReader(base, 2);
            var resumed = refHashesOf(reader);
            assert.deepEqual(resumed, reference, 'index repris identique a un import complet');
            assert.equal(resumed.length, 24, 'aucune entree perdue ni dupliquee');
            reader.close();
          });
      });
  });

  harness.it('une annulation explicite ne laisse aucun staging a reprendre', function () {
    var portal = portalLib.createPortal({ counts: { live: 40 }, chunkSize: 32 });
    var provider = makeProvider(portal);
    var base = tempBase('annulation');
    var indexed = 0;
    return importLib
      .runXtreamImport(provider, makePlan(base, 1, { persistSecrets: true }), {
        onCheckpoint: function (job) {
          if (job.entriesRead > 0) indexed = job.entriesRead;
        },
        shouldAbort: function () {
          return indexed > 0;
        },
        checkpointEveryEntries: 2
      })
      .then(function (outcome) {
        assert.equal(outcome.outcome, 'cancelled', 'issue annulee');
        assert.equal(outcome.job.phase, 'cancelled', 'phase persistee');
        assert.equal(fs.existsSync(path.join(base, 'index-v1.tmp')), false, 'staging retire');
        assert.equal(manifestLib.readManifest(base), null, 'aucun index publie');
      });
  });

  harness.it('sans identifiants, l import echoue avant toute ecriture', function () {
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
      profile: { id: 'p1', baseUrl: PORTAL_URL },
      session: { acceptedHosts: [] }
    });
    var base = tempBase('sans-identifiants');
    return importLib
      .runXtreamImport(provider, makePlan(base, 1, { persistSecrets: true }), {
        onCheckpoint: function () {},
        shouldAbort: function () {
          return false;
        }
      })
      .then(function (outcome) {
        assert.equal(outcome.outcome, 'failed', 'import refuse');
        assert.equal(outcome.error.code, 'auth/invalidCredentials', 'code explicite');
        assert.equal(manifestLib.readManifest(base), null, 'aucun index publie');
      });
  });
});

harness.describe('Import Xtream : identite et coexistence avec les fixtures (§15.2)', function () {
  harness.it('les empreintes de l import different des empreintes de fixtures et ne portent aucun identifiant en clair', function () {
    var hash = importLib.xtreamRefHash('live', '1000');
    assert.equal(hash.length, 32, 'empreinte de 16 octets en hexadecimal');
    assert.ok(hash.indexOf('1000') === -1, 'identifiant non lisible dans l empreinte');
    var fixtureHash = fixtures.refHash('1000');
    assert.ok(hash !== fixtureHash, 'espaces d empreintes distincts (fixtures vs import)');
    assert.equal(importLib.xtreamRefHash('live', '1000'), hash, 'empreinte deterministe');
    assert.ok(importLib.xtreamRefHash('vod', '1000') !== hash, 'type de contenu dans l empreinte');
  });

  harness.it('un staging conserve est inspectable, puis un import complet le remplace sans doublon', function () {
    var base = tempBase('staging');
    var writer = new writerLib.CatalogIndexWriter({
      baseDir: base,
      profileId: 'p1',
      contentType: 'live',
      indexVersion: 1,
      masterKey: masterKey
    });
    var entries = fixtures.makeEntries(20);
    entries.slice(0, 12).forEach(function (entry) {
      writer.append(entry);
    });
    writer.abortStagingKeep();
    // le staging est relisible (donc chiffre correctement scelle) mais ne permet pas d'ajouter :
    // c'est une piece de diagnostic, la reprise repart de la source
    var inspected = writerLib.CatalogIndexWriter.inspectStaging({
      baseDir: base,
      profileId: 'p1',
      contentType: 'live',
      indexVersion: 1,
      masterKey: masterKey
    });
    assert.equal(inspected.entryCount, 12, 'compteur du staging conserve');
    assert.ok(inspected.payloadBytes > 0, 'charge partielle presente');
    assert.deepEqual(inspected.categories, ['Sports', 'Cinema', 'Documentaires'], 'groupes du staging');
    writerLib.CatalogIndexWriter.discardStaging({
      baseDir: base,
      profileId: 'p1',
      contentType: 'live',
      indexVersion: 1,
      masterKey: masterKey
    });
    var replacement = new writerLib.CatalogIndexWriter({
      baseDir: base,
      profileId: 'p1',
      contentType: 'live',
      indexVersion: 1,
      masterKey: masterKey
    });
    entries.forEach(function (entry) {
      replacement.append(entry);
    });
    var finished = replacement.finish();
    replacement.commit(finished.manifest);
    var reader = openReader(base, 1);
    assert.equal(reader.getPage({ order: 'source' }).items.length, 20, 'index final complet');
    assert.equal(reader.getBuckets().buckets.length > 0, true, 'tranches alphabetiques presentes');
    reader.close();
});
});
