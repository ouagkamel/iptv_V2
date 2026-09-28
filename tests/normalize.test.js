'use strict';

/** Normalisation partagée (§9.3), scripts/tranches (§9.1), hôtes et secrets (§5.2). */

var assert = require('./assert');
var harness = require('./harness');
var path = require('path');

var libRoot = path.join(__dirname, '..', 'service', 'com.ouagkamel.app.iptvplayer.service', 'lib');
var normalize = require(path.join(libRoot, 'core', 'normalize'));
var scripts = require(path.join(libRoot, 'core', 'scripts'));
var hostSafety = require(path.join(libRoot, 'core', 'hostSafety'));
var urltools = require(path.join(libRoot, 'core', 'urltools'));

harness.describe('Normalisation de tri et de recherche (§9.3)', function () {
  harness.it('retire prefixes fournisseur, suffixes qualite et articles', function () {
    assert.equal(normalize.normalizeTitle('FR| TF1 HD'), 'tf1', 'prefixe pays et suffixe qualite');
    assert.equal(normalize.normalizeTitle('|4K| Cinema Premium FHD'), 'cinema premium', 'prefixe barre');
    assert.equal(normalize.normalizeTitle('[VIP] Les Enquetes 4K'), 'enquetes', 'prefixe crochets et article');
    assert.equal(normalize.normalizeTitle('The Matrix HEVC'), 'matrix', 'article anglais et codec');
    assert.equal(normalize.normalizeTitle('Le Petit Prince VOSTFR'), 'petit prince', 'suffixe langue');
  });

  harness.it('retire les accents et plie la casse', function () {
    assert.equal(normalize.normalizeTitle('CINEMA ÉTRANGER'), 'cinema etranger', 'accents');
    assert.equal(normalize.normalizeTitle('Cœur Brisé'), 'coeur brise', 'ligature decomposee');
  });

  harness.it('ne modifie jamais le titre affiche (fonction pure sur une copie)', function () {
    var displayed = 'FR| TF1 HD';
    normalize.normalizeTitle(displayed);
    assert.equal(displayed, 'FR| TF1 HD', 'titre inchange');
  });

  harness.it('normalise l arabe : diacritiques, alef, ta marbouta, ya', function () {
    assert.equal(normalize.normalizeTitle('\u0627\u0644\u0642\u0646\u0627\u0629 \u0627\u0644\u0623\u0648\u0644\u0649'), normalize.normalizeTitle('\u0627\u0644\u0642\u0646\u0627\u0647 \u0627\u0644\u0627\u0648\u0644\u064a'), 'replis arabes');
    assert.equal(normalize.normalizeTitle('\u0642\u0646\u0627\u0629\u064d'), normalize.normalizeTitle('\u0642\u0646\u0627\u0629'), 'tashkeel retire');
  });

  harness.it('produit la meme cle pour des variantes de qualite', function () {
    assert.equal(normalize.normalizeTitle('TF1 HD'), normalize.normalizeTitle('TF1 FHD'), 'HD et FHD');
  });

  harness.it('empreinte de requete stable', function () {
    assert.equal(normalize.hash32('matrix'), normalize.hash32('matrix'), 'stable');
    assert.ok(normalize.hash32('matrix') !== normalize.hash32('matri'), 'sensible a la requete');
  });
});

harness.describe('Scripts et tranches alphabetiques (§9.1)', function () {
  harness.it('catalogue latin : tranches A-Z avec comptes', function () {
    var acc = scripts.createBucketAccumulator();
    scripts.accumulateBucket(acc, 'Apple TV', 0);
    scripts.accumulateBucket(acc, 'Arte', 1);
    scripts.accumulateBucket(acc, 'ZDF', 2);
    scripts.accumulateBucket(acc, '123 FM', 3);
    var set = scripts.buildBucketSet(acc);
    assert.equal(set.script, 'latin', 'script dominant');
    assert.equal(set.generatedFrom, 'index', 'provenance');
    var a = set.buckets.filter(function (b) { return b.key === 'A'; })[0];
    assert.equal(a.count, 2, 'compte de la tranche A');
    assert.equal(a.startOrdinal, 0, 'ordinal de depart');
    assert.ok(set.buckets.filter(function (b) { return b.key === 'Z'; }).length === 1, 'tranche Z presente');
  });

  harness.it('catalogue arabe avec interface francaise : tranches arabes', function () {
    var acc = scripts.createBucketAccumulator();
    scripts.accumulateBucket(acc, '\u0645\u0643\u0629', 0); // مكة
    scripts.accumulateBucket(acc, '\u0627\u0644\u0645\u062f\u064a\u0646\u0629', 1); // المدينة
    scripts.accumulateBucket(acc, '\u0627\u0644\u062c\u0632\u064a\u0631\u0629', 2); // الجزيرة
    var set = scripts.buildBucketSet(acc);
    assert.equal(set.script, 'arabic', 'script arabe dominant');
    // l'article défini est retiré par la normalisation partagée (§9.3) : الجزيرة -> جزيره
    // l'article défini est retiré par la normalisation partagée (§9.3) : المدينة -> مدينه
    var byKey = {};
    set.buckets.forEach(function (b) { byKey[b.key] = b.count; });
    assert.equal(byKey['\u0645'], 2, 'deux chaines dans la tranche م (مكة et المدينة)');
    assert.equal(byKey['\u062c'], 1, 'une chaine dans la tranche ج (الجزيرة apres repli)');
    assert.equal(set.buckets[0].key, '\u062c', 'ordre alphabetique arabe canonique');
    assert.equal(normalize.normalizeTitle('\u0627\u0644\u062c\u0632\u064a\u0631\u0629'), '\u062c\u0632\u064a\u0631\u0647', 'article arabe retire pour le tri');
  });

  harness.it('les titres d un autre script sont regroupes dans #', function () {
    var acc = scripts.createBucketAccumulator();
    scripts.accumulateBucket(acc, '\u0645\u0643\u0629', 0);
    scripts.accumulateBucket(acc, '\u0645\u062f\u064a\u0646\u0629', 1);
    scripts.accumulateBucket(acc, 'BBC World', 2);
    void 0;
    var set = scripts.buildBucketSet(acc);
    assert.equal(set.script, 'arabic', 'script arabe');
    var hash = set.buckets.filter(function (b) { return b.key === '#'; })[0];
    assert.ok(hash, 'tranche # presente');
    assert.equal(hash.count, 1, 'un titre latin regroupe dans # du script dominant');
  });

  harness.it('tranches vides masquees', function () {
    var acc = scripts.createBucketAccumulator();
    scripts.accumulateBucket(acc, 'Arte', 0);
    var set = scripts.buildBucketSet(acc);
    assert.equal(set.buckets.length, 1, 'seule la tranche non vide est exposee');
  });
});

harness.describe('Marquage des hotes de flux (§5.2)', function () {
  harness.it('bloque loopback, prive, link-local et metadonnees', function () {
    assert.equal(hostSafety.markHost('http://10.0.0.1/live.ts').hostSafety, 'private', '10/8');
    assert.equal(hostSafety.markHost('http://127.0.0.1:8080/a.ts').hostSafety, 'private', 'loopback');
    assert.equal(hostSafety.markHost('http://169.254.169.254/latest/meta-data').hostSafety, 'private', 'metadonnees');
    assert.equal(hostSafety.markHost('http://192.168.1.1/stream').hostSafety, 'private', '192.168/16');
    assert.equal(hostSafety.markHost('http://172.20.5.4/stream').hostSafety, 'private', '172.16/12');
    assert.equal(hostSafety.markHost('http://100.100.1.1/stream').hostSafety, 'private', 'CGNAT');
  });

  harness.it('bloque les notations decimales, octales et hexadecimales', function () {
    assert.equal(hostSafety.markHost('http://2130706433/live.ts').hostSafety, 'private', 'decimal compact');
    assert.equal(hostSafety.markHost('http://0177.0.0.1/live.ts').hostSafety, 'private', 'octal');
    assert.equal(hostSafety.markHost('http://0x7f.0.0.1/live.ts').hostSafety, 'private', 'hexadecimal');
    assert.equal(hostSafety.markHost('http://127.1/live.ts').hostSafety, 'private', 'notation courte');
  });

  harness.it('bloque les IPv6 loopback, link-local et IPv4 encapsulee', function () {
    assert.equal(hostSafety.markHost('http://[::1]:8080/a.ts').hostSafety, 'private', '::1');
    assert.equal(hostSafety.markHost('http://[fe80::1]/a.ts').hostSafety, 'private', 'fe80::/10');
    assert.equal(hostSafety.markHost('http://[::ffff:192.168.0.1]/a.ts').hostSafety, 'private', 'IPv4 mappee');
    assert.equal(hostSafety.markHost('http://[::ffff:7f00:1]/a.ts').hostSafety, 'private', 'IPv4 mappee hexadecimale');
  });

  harness.it('bloque multicast et reserve', function () {
    assert.equal(hostSafety.markHost('http://224.0.0.1/a.ts').hostSafety, 'private', 'multicast');
    assert.equal(hostSafety.markHost('http://255.255.255.255/a.ts').hostSafety, 'private', 'reserve');
  });

  harness.it('un nom d hote reste ok avec avertissement de risque residuel', function () {
    var marking = hostSafety.markHost('https://cdn.example.com/live/1.ts');
    assert.equal(marking.hostSafety, 'ok', 'CDN publique');
    assert.ok(marking.playable, 'jouable');
    assert.ok(marking.warnings.length === 1, 'avertissement documente');
  });

  harness.it('autorisation LAN explicite rend l entree jouable', function () {
    var denied = hostSafety.markHost('http://192.168.1.10/a.ts', { lanAllowed: false });
    assert.equal(denied.playable, false, 'refusee sans autorisation');
    var allowed = hostSafety.markHost('http://192.168.1.10/a.ts', { lanAllowed: true });
    assert.equal(allowed.hostSafety, 'allowed-lan', 'marquee autorisee');
    assert.ok(allowed.playable, 'jouable apres autorisation');
  });

  harness.it('schema non supporte : unknown', function () {
    assert.equal(hostSafety.markHost('rtsp://example.com/a').hostSafety, 'unknown', 'rtsp non supporte');
  });

  harness.it('controle pre-video.src', function () {
    assert.equal(hostSafety.canPlay('http://10.1.2.3/a.ts').ok, false, 'refus avant affectation');
    assert.equal(hostSafety.canPlay('https://cdn.example.com/a.m3u8').ok, true, 'autorise en HTTPS');
  });
});

harness.describe('Analyse des identifiants d URL (§5.2, §15.6)', function () {
  harness.it('un CDN public n est pas classe secret', function () {
    var analysis = urltools.analyzeCredential('https://cdn.example.com/live/cha\u00eene.m3u8');
    assert.equal(analysis.hasCredential, false, 'URL publique');
    var hls = urltools.analyzeCredential('https://edge1.example.net/hls/stream_720/index.m3u8');
    assert.equal(hls.hasCredential, false, 'chemin HLS public');
  });

  harness.it('detecte userinfo, requete nommee et segment long', function () {
    assert.equal(urltools.analyzeCredential('http://user:pass@host/live.ts').hasCredential, true, 'userinfo');
    assert.equal(urltools.analyzeCredential('http://host/live.ts?username=bob&password=secret').hasCredential, true, 'requete nommee');
    assert.equal(
      urltools.analyzeCredential('http://host/' + 'abcdefghij0123456789ABCDEFGHIJ/live.ts').hasCredential,
      true,
      'segment long'
    );
  });

  harness.it('reconnait un prefixe porteur d identifiants commun', function () {
    var portal = 'http://portal.example.com:8080/' + 'userName0123456789SecretAbc' + '/';
    var prefix = urltools.commonCredentialPrefix([portal + '1001.ts', portal + '1002.ts']);
    assert.equal(prefix, portal, 'prefixe d identifiants reconstitue');
    var analysis = urltools.analyzeCredential(portal + '1001.ts');
    assert.equal(analysis.streamSegment, '1001.ts', 'identifiant de flux conserve (non secret)');
    assert.equal(analysis.credentialPrefix, portal, 'partie secrete = prefixe d identifiants');
  });

  harness.it('redaction : jamais d identifiant dans un journal', function () {
    var redacted = urltools.redactUrl('http://user:pass@host:8080/secretpath/1.ts?token=abcdef');
    assert.equal(redacted, 'http://host:8080/[chemin]?[redacted]', 'forme journalisable');
    assert.ok(redacted.indexOf('pass') === -1 && redacted.indexOf('token') === -1, 'aucun secret');
  });

  harness.it('les messages d erreur ne laissent pas fuiter de secret', function () {
    var AppError = require(path.join(libRoot, 'contracts', 'errors')).AppError;
    var err = new AppError('network/http', 'echec sur http://user:pass@host/live.ts?token=xyz');
    assert.ok(err.message.indexOf('pass') === -1, 'userinfo masque');
    assert.ok(err.message.indexOf('xyz') === -1, 'token masque');
  });
});
