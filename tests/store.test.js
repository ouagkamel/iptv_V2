'use strict';

/**
 * Index catalogue (§15.2) : pagination à curseur versionné, recherche bornée, plafonds
 * d'octets, bascule atomique et absence de parcours linéaire en recherche.
 */

var assert = require('./assert');
var harness = require('./harness');
var fixtures = require('./fixtures');
var fs = require('fs');
var os = require('os');
var path = require('path');

var libRoot = path.join(__dirname, '..', 'service', 'com.ouagkamel.app.iptvplayer.service', 'lib');
var writerLib = require(path.join(libRoot, 'service', 'store', 'writer'));
var readerLib = require(path.join(libRoot, 'service', 'store', 'reader'));
var manifestLib = require(path.join(libRoot, 'service', 'store', 'manifest'));
var identityLib = require(path.join(libRoot, 'service', 'store', 'identity'));
var cryptoLib = require(path.join(libRoot, 'service', 'crypto', 'indexCrypto'));
var pagesLib = require(path.join(libRoot, 'core', 'pages'));
var MAX_PAGE_OBJECTS = pagesLib.MAX_PAGE_OBJECTS;
var MAX_PAGE_BYTES = pagesLib.MAX_PAGE_BYTES;

var masterKey = Buffer.alloc(32, 3);

function tempBase(name) {
  var dir = path.join(os.tmpdir(), 'iptv-test-' + name + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
  fs.mkdirSync(dir);
  return dir;
}

function buildIndex(base, entries, options) {
  options = options || {};
  var writer = new writerLib.CatalogIndexWriter({
    baseDir: base,
    profileId: options.profileId || 'p1',
    contentType: options.contentType || 'live',
    indexVersion: options.indexVersion || 1,
    masterKey: masterKey
  });
  entries.forEach(function (entry) {
    writer.append(entry);
  });
  var result = writer.finish();
  writer.commit(result.manifest);
  return result.manifest;
}

function openReader(base, options) {
  options = options || {};
  return readerLib.CatalogIndexReader.open({
    baseDir: base,
    profileId: options.profileId || 'p1',
    contentType: options.contentType || 'live',
    masterKey: masterKey,
    expectedIndexVersion: options.expectedIndexVersion,
    refKind: 'providerId'
  });
}

harness.describe('Index catalogue : pagination (§15.2)', function () {
  var base = tempBase('pagination');
  var entries = fixtures.makeEntries(500);
  buildIndex(base, entries);
  var reader = openReader(base);

  harness.it('pagination en ordre source, sans trou ni doublon', function () {
    var first = reader.getPage({ order: 'source' });
    assert.equal(first.items.length, MAX_PAGE_OBJECTS, 'page bornee a 200 objets');
    assert.equal(first.indexVersion, 1, 'version d index renvoyee');
    assert.ok(first.cursor, 'curseur present');
    assert.equal(first.cursor.order, 'source', 'ordre du curseur');
    var second = reader.getPage({ order: 'source', cursor: first.cursor });
    var seen = {};
    first.items.concat(second.items).forEach(function (item) {
      assert.ok(!seen[item.sourceOrder], 'aucun doublon : ' + item.sourceOrder);
      seen[item.sourceOrder] = true;
    });
    var last = reader.getPage({ order: 'source', cursor: { indexVersion: 1, contentType: 'live', order: 'source', ordinal: 450 } });
    assert.ok(!last.cursor, 'fin de liste sans curseur');
  });

  harness.it('filtre par categorie via les plages d ordinaux', function () {
    var page = reader.getPage({ order: 'source', categoryId: 'Cinema' });
    assert.ok(page.items.length > 0, 'categorie non vide');
    page.items.forEach(function (item) {
      assert.equal(item.categoryId, 'Cinema', 'toutes les entrees de la categorie');
    });
    assert.ok(page.totalKnown !== undefined && page.totalKnown > 0, 'total connu expose');
  });

  harness.it('ordre alphabetique via la table dense', function () {
    var page = reader.getPage({ order: 'title' });
    assert.equal(page.items.length, MAX_PAGE_OBJECTS, 'page bornee');
    var titles = page.items.map(function (item) {
      return item.title;
    });
    var normalized = titles.map(function (title) {
      return require(path.join(libRoot, 'core', 'normalize')).normalizeTitle(title);
    });
    for (var i = 1; i < normalized.length; i++) {
      assert.ok(normalized[i - 1] <= normalized[i], 'ordre alphabetique respecte a la position ' + i);
    }
  });

  harness.it('une page reste sous le plafond d octets', function () {
    var fatBase = tempBase('fat');
    buildIndex(fatBase, fixtures.makeEntries(400, { fatItems: true }));
    var fatReader = openReader(fatBase);
    var page = fatReader.getPage({ order: 'source' });
    var bytes = pagesLib.jsonByteLength(page.items);
    assert.atMost(bytes, MAX_PAGE_BYTES, 'plafond de 256 Kio');
    assert.ok(page.items.length <= MAX_PAGE_OBJECTS, 'plafond de 200 objets');
    assert.ok(page.cursor, 'curseur renvoye malgre la coupure');
    fatReader.close();
  });

  harness.it('les listes ne transportent aucun resume long ni URL de flux', function () {
    var page = reader.getPage({ order: 'source' });
    var json = JSON.stringify(page.items);
    assert.ok(json.indexOf('"plot"') === -1, 'pas de description longue en liste');
    assert.ok(json.indexOf('streamRef') === -1, 'pas d URL de flux dans une page de liste');
    page.items.forEach(function (item) {
      assert.ok(item.summary === undefined || item.summary.length <= 200, 'resume borne a 200 caracteres');
    });
  });

  harness.it('getDetails est la seule voie vers la charge lourde', function () {
    var details = reader.getDetails(0);
    assert.ok(details.heavy.p === undefined || typeof details.heavy.p === 'string', 'description complete');
    var stored = reader.getDetails(4); // entree i%5===0 => streamMode storedSecret
    assert.ok(stored.heavy.u === undefined || stored.heavy.u.indexOf('://') !== -1, 'URL conservee uniquement ici');
  });

  harness.it('tranches alphabetiques produites a l indexation', function () {
    var buckets = reader.getBuckets();
    assert.equal(buckets.generatedFrom, 'index', 'provenance index');
    assert.equal(buckets.script, 'latin', 'script dominant');
    assert.ok(buckets.buckets.length > 0, 'tranches presentes');
    buckets.buckets.forEach(function (bucket) {
      assert.ok(bucket.count > 0, 'aucune tranche vide');
    });
  });

  harness.it('groupes exposes avec plages', function () {
    var groups = reader.getGroups();
    assert.ok(groups.length >= 3, 'trois groupes declares');
    groups.forEach(function (group) {
      assert.ok(group.ranges.length > 0, 'plages non vides');
      assert.equal(group.count, group.ranges.reduce(function (total, range) { return total + (range[1] - range[0] + 1); }, 0), 'compteur coherent avec les plages');
    });
  });

  harness.it('famille arabe : tranches issues des donnees', function () {
    var arabicBase = tempBase('arabic');
    buildIndex(arabicBase, fixtures.makeEntries(60, { arabicOnly: true }));
    var arabicReader = openReader(arabicBase);
    var buckets = arabicReader.getBuckets();
    assert.equal(buckets.script, 'arabic', 'script arabe');
    assert.equal(buckets.buckets[0].key, '\u0642', 'premiere tranche : qaf (apres repli de l article ال)');
    assert.ok(buckets.buckets[0].count === 60, 'toutes les entrees dans la tranche qaf');
    var total = buckets.buckets.reduce(function (sum, bucket) { return sum + bucket.count; }, 0);
    assert.equal(total, 60, 'les compteurs couvrent tout le catalogue');
    arabicReader.close();
  });

  harness.it('fermeture du lecteur', function () {
    reader.close();
  });
});

harness.describe('Index catalogue : recherche indexee (§15.2, §11.1)', function () {
  var base = tempBase('search');
  buildIndex(base, fixtures.makeEntries(3000));
  var reader = openReader(base);

  harness.it('recherche par prefixe, resultats pagines', function () {
    var page = reader.search({ query: 'chaine 0042' });
    assert.ok(page.items.length > 0, 'resultats trouves');
    page.items.forEach(function (item) {
      assert.ok(
        require(path.join(libRoot, 'core', 'normalize')).normalizeTitle(item.title).indexOf('chaine 0042') === 0,
        'prefixe respecte : ' + item.title
      );
    });
    assert.equal(page.indexVersion, 1, 'version d index renvoyee');
    assert.ok(page.items.length >= 1, 'au moins une correspondance');
    // une requete precise renvoie peu de resultats : le curseur n apparait que si la page est pleine
    var broad = reader.search({ query: 'chaine' });
    assert.equal(broad.cursor && broad.cursor.order, 'search', 'curseur de recherche sur une requete large');
  });

  harness.it('reprise exacte au meme ancrage', function () {
    var first = reader.search({ query: 'chaine' });
    assert.ok(first.cursor, 'page pleine, curseur present');
    var second = reader.search({ query: 'chaine', cursor: first.cursor });
    assert.equal(second.cursor && second.cursor.queryKey, first.cursor.queryKey, 'meme empreinte de requete');
    var firstOrders = first.items.map(function (item) { return item.sourceOrder; });
    second.items.forEach(function (item) {
      assert.ok(firstOrders.indexOf(item.sourceOrder) === -1, 'aucun recouvrement entre pages');
    });
  });

  harness.it('aucun parcours lineaire : lecture bornee par la page', function () {
    var before = reader.getStats();
    var page = reader.search({ query: 'chaine 1500' });
    var after = reader.getStats();
    var recordsRead = after.recordsRead - before.recordsRead;
    var blocksRead = after.blocksRead - before.blocksRead;
    assert.ok(page.items.length > 0, 'resultats trouves');
    assert.atMost(recordsRead, 260, 'lectures d enregistrements bornees par la page (sur 3000 entrees)');
    assert.atMost(blocksRead, 160, 'blocs dechiffres bornes (un seul bloc en memoire)');
  });

  harness.it('une requete sans correspondance ne balaie pas le catalogue', function () {
    var before = reader.getStats();
    var page = reader.search({ query: 'zzzz-inexistant' });
    var after = reader.getStats();
    assert.equal(page.items.length, 0, 'aucun resultat');
    assert.atMost(after.recordsRead - before.recordsRead, 40, 'quelques lectures suffisent');
  });

  harness.it('requete vide : page vide sans erreur', function () {
    var page = reader.search({ query: '   ' });
    assert.equal(page.items.length, 0, 'aucun resultat');
    assert.ok(!page.cursor, 'aucun curseur');
  });

  harness.it('curseur de recherche reutilise sur une autre requete : indexChanged', function () {
    var page = reader.search({ query: 'chaine' });
    assert.throws(function () {
      reader.search({ query: 'autre requete', cursor: page.cursor });
    }, 'catalog/indexChanged', 'empreinte de requete differente');
  });

  harness.it('fermeture du lecteur de recherche', function () {
    reader.close();
  });
});

harness.describe('Bascule d index, rétention et annulation (§2.4, §15.5)', function () {
  var base = tempBase('swap');
  buildIndex(base, fixtures.makeEntries(120), { indexVersion: 1 });
  var oldReader = openReader(base, { expectedIndexVersion: 1 });
  var pageFromOld = oldReader.getPage({ order: 'source' });

  buildIndex(base, fixtures.makeEntries(140), { indexVersion: 2 });
  var newReader = openReader(base);

  harness.it('le manifeste pointe la nouvelle version', function () {
    assert.equal(newReader.manifest.indexVersion, 2, 'version courante');
    assert.ok(manifestLib.readPreviousManifest(base), 'manifeste precedent conserve pour la retention');
    assert.ok(manifestLib.readPreviousManifest(base).indexVersion === 1, 'version precedente identifiable');
  });

  harness.it('curseur d une version revolue : catalog/indexChanged, rejeu au meme ancrage', function () {
    assert.throws(function () {
      newReader.getPage({ order: 'source', cursor: pageFromOld.cursor || { indexVersion: 1, contentType: 'live', order: 'source', ordinal: 10 } });
    }, 'catalog/indexChanged', 'curseur d une version revolue');
    var replayed = newReader.getPage({ order: 'source', cursor: { indexVersion: 2, contentType: 'live', order: 'source', ordinal: 10 } });
    assert.equal(replayed.indexVersion, 2, 'rejeu sur la nouvelle version');
    assert.equal(replayed.items[0].sourceOrder, 10, 'ancrage respecte');
  });

  harness.it('un lecteur ouvert sur la version revolue est refuse a l ouverture', function () {
    assert.throws(function () {
      openReader(base, { expectedIndexVersion: 1 });
    }, 'catalog/indexChanged', 'version attendue differente du manifeste');
  });

  harness.it('les temporaires orphelins et versions non elues sont supprimes', function () {
    var removed = manifestLib.pruneOrphans(base, [2]);
    assert.ok(removed.indexOf('index-v1') === -1 || manifestLib.isRetentionActive(base), 'retention respectee si active');
  });

  harness.it('un import annule ne touche jamais l index valide', function () {
    var cancelBase = tempBase('cancel');
    buildIndex(cancelBase, fixtures.makeEntries(50), { indexVersion: 1 });
    var writer = new writerLib.CatalogIndexWriter({
      baseDir: cancelBase,
      profileId: 'p1',
      contentType: 'live',
      indexVersion: 2,
      masterKey: masterKey
    });
    writer.append(fixtures.makeEntries(10)[0]);
    writer.abort();
    var manifest = manifestLib.readManifest(cancelBase);
    assert.equal(manifest.indexVersion, 1, 'index valide inchange');
    assert.equal(fs.existsSync(path.join(cancelBase, 'index-v2.tmp')), false, 'staging supprime');
    assert.equal(fs.existsSync(path.join(cancelBase, 'index-v2')), false, 'aucune version publiee');
  });

  harness.it('fermeture des lecteurs de bascule', function () {
    oldReader.close();
    newReader.close();
  });
});

harness.describe('Plafonds de page (§15.2) : objets et octets', function () {
  harness.it('la coupure en octets precede la coupure en objets', function () {
    var acc = new pagesLib.PageAccumulator();
    var filler = 'x'.repeat(4000);
    var added = 0;
    for (var i = 0; i < 200; i++) {
      if (!acc.tryAdd({ id: i, filler: filler }, i)) break;
      added += 1;
    }
    assert.ok(added < 200, 'coupure avant 200 objets');
    assert.ok(acc.bytes <= MAX_PAGE_BYTES, 'plafond d octets respecte');
    assert.ok(acc.truncated, 'coupe signalee');
    assert.equal(acc.lastOrdinal, added - 1, 'dernier ordinal retenu');
  });

  harness.it('comptage UTF-8 correct pour les titres arabes', function () {
    assert.equal(pagesLib.utf8ByteLength('abc'), 3, 'ASCII');
    assert.equal(pagesLib.utf8ByteLength('\u0627\u0644'), 4, 'deux caracteres arabes');
    assert.equal(pagesLib.utf8ByteLength('\uD83D\uDE00'), 4, 'emoji hors BMP');
  });
});

/**
 * Régression : la résolution d'une référence (détail, flux) passait par un **balayage linéaire** du
 * catalogue — 61 616 lectures de blocs mesurées sur l'import réel de 5 299 chaînes. Elle s'appuie
 * désormais sur `refs.idx` (`iptv/index/v1/refs:hash16+ordinal4`) et une recherche binaire.
 */
harness.describe('Résolution de référence : index dense, recherche binaire (§15.2)', function () {
  var count = 300;
  var entries = fixtures.makeEntries(count).map(function (entry, index) {
    entry.refKey = 'ch-' + index;
    entry.refHash = identityLib.refHashFor('live', 'ch-' + index);
    return entry;
  });
  var base = tempBase('refs');
  var refsManifest = buildIndex(base, entries);
  var reader = openReader(base);

  harness.it('refs.idx publie : 20 octets par entree, aucun remplissage superflu', function () {
    var target = path.join(base, 'index-v1', 'refs.idx');
    assert.equal(fs.existsSync(target), true, 'index de references present');
    var blockBytes = cryptoLib.USABLE_BLOCK_BYTES;
    var payload = count * 20;
    var blocks = Math.ceil(payload / blockBytes);
    var expected = cryptoLib.HEADER_SIZE + blocks * (cryptoLib.BLOCK_SIZE + cryptoLib.TAG_LEN);
    assert.equal(fs.statSync(target).size, expected, 'taille exacte attendue');
    assert.equal(refsManifest.blockCounts.refs, blocks, 'blocs declares dans le manifeste');
  });

  harness.it('resolution par identifiant fournisseur : premier, median, dernier', function () {
    [0, Math.floor(count / 2), count - 1].forEach(function (index) {
      var ordinal = reader.findOrdinalByProviderId('ch-' + index);
      assert.equal(ordinal, index, 'ordinal exact pour ch-' + index);
      assert.equal(reader.getDetails(ordinal).item.title, entries[index].title, 'detail coherent');
    });
  });

  harness.it('pire cas borne par dichotomie : aucune lecture en masse', function () {
    var calls = 0;
    var original = reader.refs.readRange;
    reader.refs.readRange = function (offset, length) {
      calls += 1;
      return original.call(reader.refs, offset, length);
    };
    try {
      reader.findOrdinalByProviderId('ch-' + (count - 1));
      reader.findOrdinalByProviderId('ch-0');
      reader.findOrdinalByProviderId('ch-151');
    } finally {
      reader.refs.readRange = original;
    }
    var bound = Math.ceil(Math.log(count) / Math.log(2)) * 3 + 3;
    assert.ok(calls <= bound, 'lectures bornees (' + calls + ' <= ' + bound + ')');
    assert.ok(calls < count / 4, 'aucun parcours lineaire du catalogue');
  });

  harness.it('identifiant absent ou empreinte invalide : null', function () {
    assert.equal(reader.findOrdinalByProviderId('ch-inconnue'), null, 'reference inconnue');
    assert.equal(reader.findOrdinalByRefHash('zz'), null, 'empreinte invalide refusee');
  });

  harness.it('index publie sans refs.idx : repli compatible sur l ancien format', function () {
    var legacyBase = tempBase('refs-legacy');
    var source = path.join(base, 'index-v1');
    var target = path.join(legacyBase, 'index-v1');
    fs.mkdirSync(target);
    fs.readdirSync(source).forEach(function (name) {
      if (name === 'refs.idx') return;
      fs.copyFileSync(path.join(source, name), path.join(target, name));
    });
    fs.copyFileSync(path.join(base, 'manifest.json'), path.join(legacyBase, 'manifest.json'));
    var legacy = openReader(legacyBase);
    assert.equal(legacy.findOrdinalByProviderId('ch-' + (count - 1)), count - 1, 'repli fonctionnel');
    legacy.close();
  });

  harness.it('fermeture du lecteur de references', function () {
    reader.close();
  });
});
