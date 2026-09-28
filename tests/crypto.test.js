'use strict';

/**
 * Vecteurs RFC 5869 (cas 1 à 3) et invariants du format de fichier chiffré (§15.3).
 * Ces tests sont les « vecteurs de test obligatoires en CI » exigés par la spécification.
 */

var assert = require('./assert');
var harness = require('./harness');
var path = require('path');

var libRoot = path.join(__dirname, '..', 'service', 'com.ouagkamel.app.iptvplayer.service', 'lib');
var hkdfLib = require(path.join(libRoot, 'service', 'crypto', 'hkdf'));
var indexCrypto = require(path.join(libRoot, 'service', 'crypto', 'indexCrypto'));

function hex(value) {
  return Buffer.from(value.replace(/\s+/g, ''), 'hex');
}

harness.describe('HKDF-SHA256 (RFC 5869)', function () {
  harness.it('cas 1 : IKM 22 octets, salt 13 octets, info 10 octets', function () {
    var ikm = hex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
    var salt = hex('000102030405060708090a0b0c');
    var info = hex('f0f1f2f3f4f5f6f7f8f9');
    var prk = hkdfLib.hkdfExtract(salt, ikm);
    assert.equal(prk.toString('hex'), '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5', 'PRK cas 1');
    var okm = hkdfLib.hkdfExpand(prk, info, 42);
    assert.equal(
      okm.toString('hex'),
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
      'OKM cas 1'
    );
  });

  harness.it('cas 2 : entrées longues (80 octets) et sortie 82 octets', function () {
    var ikmParts = [];
    for (var i = 0; i < 80; i++) ikmParts.push(i);
    var saltParts = [];
    for (var j = 0x60; j <= 0xaf; j++) saltParts.push(j);
    var infoParts = [];
    for (var k = 0xb0; k <= 0xff; k++) infoParts.push(k);
    var prk = hkdfLib.hkdfExtract(Buffer.from(saltParts), Buffer.from(ikmParts));
    assert.equal(prk.toString('hex'), '06a6b88c5853361a06104c9ceb35b45cef760014904671014a193f40c15fc244', 'PRK cas 2');
    var okm = hkdfLib.hkdfExpand(prk, Buffer.from(infoParts), 82);
    assert.equal(
      okm.toString('hex'),
      'b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e0' +
        '9da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87',
      'OKM cas 2'
    );
  });

  harness.it('cas 3 : salt et info vides', function () {
    var ikm = hex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
    var prk = hkdfLib.hkdfExtract(Buffer.alloc(0), ikm);
    assert.equal(prk.toString('hex'), '19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04', 'PRK cas 3');
    var okm = hkdfLib.hkdfExpand(prk, Buffer.alloc(0), 42);
    assert.equal(
      okm.toString('hex'),
      '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
      'OKM cas 3'
    );
  });

  harness.it('refuse une longueur hors bornes', function () {
    var prk = hkdfLib.hkdfExtract(Buffer.alloc(0), Buffer.from('x'));
    assert.throws(function () {
      hkdfLib.hkdfExpand(prk, Buffer.alloc(0), 255 * 32 + 1);
    }, null, 'longueur maximale');
  });
});

harness.describe('Index chiffré (§15.3)', function () {
  var masterKey = Buffer.alloc(32, 7);
  var profileId = 'profil-1';

  function params(indexVersion, fileKind, contentType) {
    return {
      masterKey: masterKey,
      profileId: profileId,
      contentType: contentType || 'live',
      indexVersion: indexVersion,
      schemaHash: indexCrypto.schemaHash('test/schema'),
      fileKind: fileKind || 'records'
    };
  }

  harness.it('deux versions d index ne partagent ni clé ni nonce', function () {
    var v1 = params(1);
    var v2 = params(2);
    var k1 = indexCrypto.deriveIndexKey(v1).indexKey;
    var k2 = indexCrypto.deriveIndexKey(v2).indexKey;
    assert.ok(!k1.equals(k2), 'cles differentes entre versions');
    var n1 = indexCrypto.deriveNonce(v1, 0);
    var n2 = indexCrypto.deriveNonce(v2, 0);
    assert.ok(!n1.equals(n2), 'nonces differents entre versions');
    assert.equal(n1.length, 12, 'nonce de 12 octets');
    assert.equal(k1.length, 32, 'cle de 32 octets');
  });

  harness.it('deux fichiers du meme index ne partagent ni cle ni nonce', function () {
    var records = params(3, 'records');
    var payload = params(3, 'payload');
    assert.ok(
      !indexCrypto.deriveIndexKey(records).indexKey.equals(indexCrypto.deriveIndexKey(payload).indexKey),
      'cles par type de fichier'
    );
    assert.ok(
      !indexCrypto.deriveNonce(records, 5).equals(indexCrypto.deriveNonce(payload, 5)),
      'nonces par type de fichier'
    );
  });

  harness.it('chiffre et relit un contenu, longueur reelle preservee', function () {
    var content = Buffer.from('titre|groupe|resume', 'utf8');
    var file = indexCrypto.encryptContent(content, params(4));
    var decrypted = indexCrypto.decryptBlock(file, 0, params(4));
    assert.bufferEqual(decrypted, content, 'aller-retour');
    var header = indexCrypto.parseHeader(file.slice(0, 32));
    assert.equal(header.blockSize, 4096, 'taille de bloc');
    assert.equal(header.contentType, 'live', 'contentType dans l en-tete');
    assert.equal(header.blockCount, 1, 'nombre de blocs');
  });

  harness.it('un bloc deplace vers un autre fichier est rejete', function () {
    var file = indexCrypto.encryptContent(Buffer.from('contenu testamentaire'), params(5, 'records'));
    assert.throws(function () {
      indexCrypto.decryptBlock(file, 0, params(5, 'payload'));
    }, 'catalog/corrupt', 'AAD differente => rejet');
  });

  harness.it('un bloc deplace vers un autre indexVersion est rejete', function () {
    var file = indexCrypto.encryptContent(Buffer.from('contenu'), params(6));
    assert.throws(function () {
      indexCrypto.decryptBlock(file, 0, params(7));
    }, 'catalog/indexChanged', 'version differente');
  });

  harness.it('un tag altere est rejete', function () {
    var file = indexCrypto.encryptContent(Buffer.from('contenu'), params(8));
    var altered = Buffer.from(file);
    altered[altered.length - 1] = altered[altered.length - 1] ^ 0xff;
    assert.throws(function () {
      indexCrypto.decryptBlock(altered, 0, params(8));
    }, 'catalog/corrupt', 'tag altere');
  });

  harness.it('un cryptogramme altere est rejete', function () {
    var file = indexCrypto.encryptContent(Buffer.from('contenu important'), params(9));
    var altered = Buffer.from(file);
    altered[32 + 10] = altered[32 + 10] ^ 0x01;
    assert.throws(function () {
      indexCrypto.decryptBlock(altered, 0, params(9));
    }, 'catalog/corrupt', 'cryptogramme altere');
  });

  harness.it('deux index successifs du meme profil produisent des chiffres differents', function () {
    var content = Buffer.from('meme contenu', 'utf8');
    var file1 = indexCrypto.encryptContent(content, params(10));
    var file2 = indexCrypto.encryptContent(content, params(11));
    assert.ok(!file1.slice(32, 64).equals(file2.slice(32, 64)), 'chiffres differents (cle differente)');
  });

  harness.it('un en-tete incoherent est rejete (magic, format)', function () {
    var file = indexCrypto.encryptContent(Buffer.from('x'), params(12));
    var broken = Buffer.from(file);
    broken[0] = 0x00;
    assert.throws(function () {
      indexCrypto.parseHeader(broken.slice(0, 32));
    }, 'catalog/corrupt', 'magic invalide');
  });
});
