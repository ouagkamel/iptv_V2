'use strict';

/**
 * **Formats de flux : l'ordre d'essai suit ce que la plateforme déclare** (D-44, §0B).
 *
 * Ce que ces tests protègent : le lecteur a demandé pendant des versions un direct **MPEG-TS
 * progressif** sans jamais consulter `canPlayType` ; sur un appareil qui refuse ce conteneur, le flux
 * était pourtant servi (302 → 200) mais la lecture échouait en `MediaError 4`. L'ordre d'essai
 * (HLS d'abord, MPEG-TS ensuite), le repli borné sur l'autre conteneur et le message qui **nomme les
 * formats essayés** vivent dans un module sans dépendance — c'est lui qui est testé ici.
 */

var assert = require('./assert');
var harness = require('./harness');
var path = require('path');

var media = require(path.join(__dirname, '..', 'src', 'app', 'mediaformats.js'));

/** Faux `canPlayType` : n'accepte que les MIME listés, avec la réponse fournie. */
function canPlayType(acceptes, reponse) {
  return function (mime) {
    return acceptes.indexOf(mime) !== -1 ? reponse || 'probably' : '';
  };
}

harness.describe('Formats de lecture : ordre déclaré par la plateforme (D-44)', function () {
  harness.it('HLS d abord quand la plateforme le déclare', function () {
    assert.deepEqual(media.candidats(canPlayType(['application/vnd.apple.mpegurl'])), ['hls', 'ts']);
    assert.deepEqual(
      media.candidats(canPlayType(['application/vnd.apple.mpegurl', 'video/mp2t'])),
      ['hls', 'ts'],
      'les deux déclarés : HLS (adaptatif) d abord'
    );
  });

  harness.it('MPEG-TS d abord quand il est le seul déclaré', function () {
    assert.deepEqual(media.candidats(canPlayType(['video/mp2t'])), ['ts', 'hls']);
  });

  harness.it('aucun avis (canPlayType absent ou muet) : ordre par défaut, les deux formats', function () {
    assert.deepEqual(media.candidats(null), ['hls', 'ts']);
    assert.deepEqual(media.candidats(undefined), ['hls', 'ts']);
    assert.deepEqual(media.candidats(canPlayType([])), ['hls', 'ts']);
  });

  harness.it('canPlayType qui lève une exception ne bloque pas la lecture', function () {
    var casse = function () {
      throw new Error('canPlayType indisponible');
    };
    assert.deepEqual(media.candidats(casse), ['hls', 'ts']);
  });

  harness.it('la variante `application/x-mpegURL` est reconnue comme HLS', function () {
    var declare = media.support(canPlayType(['application/x-mpegURL']));
    assert.equal(declare.hls, 'probably', 'variante reconnue');
    assert.deepEqual(media.candidats(canPlayType(['application/x-mpegURL'])), ['hls', 'ts']);
  });

  harness.it('l autre conteneur est connu, l inconnu rend une chaîne vide', function () {
    assert.equal(media.autre('hls'), 'ts');
    assert.equal(media.autre('ts'), 'hls');
    assert.equal(media.autre('auto'), '');
    assert.equal(media.autre(undefined), '');
  });

  harness.it('le message nomme la cause et les formats réellement essayés', function () {
    var message = media.messageErreurMedia(4, ['hls', 'ts']);
    assert.ok(message.indexOf('MediaError 4') !== -1, 'code du lecteur : ' + message);
    assert.ok(message.indexOf('format non pris en charge') !== -1, 'cause : ' + message);
    assert.ok(message.indexOf('hls, ts') !== -1, 'formats essayés : ' + message);
    assert.ok(
      media.messageErreurMedia(2, ['hls']).indexOf('expire') !== -1,
      'une erreur réseau parle d expiration'
    );
    assert.ok(media.messageErreurMedia(3, []).indexOf('decodage') !== -1, 'erreur de décodage nommée');
  });

  harness.it('le résumé des formats est lisible pour la page de diagnostic', function () {
    var resume = media.resume(canPlayType(['application/vnd.apple.mpegurl']));
    assert.ok(resume.indexOf('HLS') !== -1 && resume.indexOf('probably') !== -1, 'HLS annoncé : ' + resume);
    assert.ok(resume.indexOf('MPEG-TS') !== -1 && resume.indexOf('non') !== -1, 'MPEG-TS non déclaré : ' + resume);
    assert.equal(media.resume(null).indexOf('non') !== -1, true, 'sans canPlayType : « non » partout');
  });

  harness.it('le module est chargeable dans une page et sous Node', function () {
    // le fichier sert deux mondes : `window.iptvMedia` (page et interface) et `module.exports` (tests)
    assert.equal(typeof media.mock, 'undefined', 'pas de dépendance de test embarquée');
    assert.equal(media.MIME.hls, 'application/vnd.apple.mpegurl', 'MIME HLS');
    assert.equal(media.MIME.ts, 'video/mp2t', 'MIME MPEG-TS');
  });
});
