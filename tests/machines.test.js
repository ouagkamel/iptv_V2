'use strict';

/** Machines d'état du lecteur et de l'import (§15.5) : transitions exactes, tests sans TV. */

var assert = require('./assert');
var harness = require('./harness');
var path = require('path');

var libRoot = path.join(__dirname, '..', 'service', 'com.ouagkamel.app.iptvplayer.service', 'lib');
var machines = require(path.join(libRoot, 'core', 'machines'));

function effectTypes(transition) {
  return transition.effects.map(function (effect) {
    return effect.type;
  });
}

harness.describe('Machine d etat du lecteur (§15.5)', function () {
  harness.it('cycle nominal IDLE -> PREPARING -> BUFFERING -> PLAYING', function () {
    var s = machines.applyPlayerEvent('IDLE', {}, { type: 'play', refKey: 'chaine-1' });
    assert.equal(s.state, 'PREPARING', 'apres play');
    assert.ok(effectTypes(s).indexOf('resolve') !== -1, 'resolution demandee');
    var b = machines.applyPlayerEvent(s.state, s.context, { type: 'sourceAssigned' });
    assert.equal(b.state, 'BUFFERING', 'source affectee');
    assert.ok(effectTypes(b).indexOf('startNoFirstFrameTimer') !== -1, 'minuteur de premiere image');
    var p = machines.applyPlayerEvent(b.state, b.context, { type: 'playing' });
    assert.equal(p.state, 'PLAYING', 'lecture');
    assert.ok(effectTypes(p).indexOf('clearTimers') !== -1, 'minuteurs nettoyes');
  });

  harness.it('absence de premiere image apres 20 s : ERROR', function () {
    var b = { state: 'BUFFERING', context: { refKey: 'x' } };
    var err = machines.applyPlayerEvent(b.state, b.context, { type: 'noFirstFrameTimeout' });
    assert.equal(err.state, 'ERROR', 'erreur de delai');
    assert.equal(err.context.lastError, 'player/timeout', 'code expose');
    assert.equal(machines.NO_FIRST_FRAME_TIMEOUT_MS, 20000, 'seuil de 20 s');
  });

  harness.it('waiting prolonge : message distingue, etat BUFFERING', function () {
    var playing = { state: 'PLAYING', context: { refKey: 'x' } };
    var short = machines.applyPlayerEvent(playing.state, playing.context, { type: 'waiting', elapsedMs: 2000 });
    assert.equal(short.state, 'BUFFERING', 'retour en tampon');
    assert.equal(short.effects.length, 0, 'aucun message premature');
    var long = machines.applyPlayerEvent(playing.state, playing.context, { type: 'waiting', elapsedMs: 13000 });
    assert.equal(long.effects.length, 1, 'message apres le seuil');
    assert.equal(long.effects[0].detail, 'flux interrompu ou tampon insuffisant', 'message distinct');
  });

  harness.it('erreur media : message, puis nouvelle tentative', function () {
    var err = machines.applyPlayerEvent('PLAYING', { refKey: 'x' }, { type: 'mediaError' });
    assert.equal(err.state, 'ERROR', 'erreur');
    var retry = machines.applyPlayerEvent(err.state, err.context, { type: 'retry' });
    assert.equal(retry.state, 'PREPARING', 'nouvelle session');
    assert.ok(effectTypes(retry).indexOf('clearSource') !== -1, 'source retiree avant resolution');
    assert.equal(retry.context.autoResolvedOnce, true, 'tentative unique consommee');
  });

  harness.it('re-resolution automatique unique', function () {
    assert.equal(machines.shouldAutoResolveOnce({}, 'expired'), true, 'expiration');
    assert.equal(machines.shouldAutoResolveOnce({}, 'forbidden'), true, '403');
    assert.equal(machines.shouldAutoResolveOnce({ autoResolvedOnce: true }, 'forbidden'), false, 'une seule fois');
  });

  harness.it('arret propre : STOPPING puis IDLE sur emptied', function () {
    var stopping = machines.applyPlayerEvent('PLAYING', { refKey: 'x' }, { type: 'stop' });
    assert.equal(stopping.state, 'STOPPING', 'arret en cours');
    assert.ok(effectTypes(stopping).indexOf('pause') !== -1, 'pause');
    assert.ok(effectTypes(stopping).indexOf('clearSource') !== -1, 'source retiree');
    var idle = machines.applyPlayerEvent(stopping.state, stopping.context, { type: 'emptied' });
    assert.equal(idle.state, 'IDLE', 'retour au repos');
    assert.deepEqual(idle.context, {}, 'contexte vide');
  });

  harness.it('timeout d arret : signale au diagnostic, pas masque', function () {
    var idle = machines.applyPlayerEvent('STOPPING', { refKey: 'x' }, { type: 'stopTimeout' });
    assert.equal(idle.state, 'IDLE', 'etat final');
    assert.equal(idle.effects[0].detail, 'stopTimeout', 'anomalie remontee');
  });

  harness.it('coalescence de zapping : une seule demande dans la fenetre', function () {
    var scheduled = [];
    var cancelled = [];
    var coalescer = new machines.ZapCoalescer(
      function (fn, ms) {
        scheduled.push({ fn: fn, ms: ms });
        return scheduled.length;
      },
      function (handle) {
        cancelled.push(handle);
      }
    );
    var requested = [];
    coalescer.request('a', function (key) { requested.push(key); });
    coalescer.request('b', function (key) { requested.push(key); });
    coalescer.request('c', function (key) { requested.push(key); });
    assert.equal(cancelled.length, 2, 'les demandes precedentes sont annulees');
    assert.equal(scheduled[scheduled.length - 1].ms, 400, 'fenetre de 400 ms');
    scheduled[scheduled.length - 1].fn();
    assert.deepEqual(requested, ['c'], 'seule la derniere cible est ouverte');
  });
});

harness.describe('Machine d etat de l import (§15.5)', function () {
  function newJob() {
    return machines.createImportJob({
      jobId: 'job-1',
      profileId: 'p1',
      sourceType: 'xtream',
      tempIndexVersion: 7,
      usesEmbeddedCredentials: true
    });
  }

  harness.it('sequence nominale jusqu a done', function () {
    var job = newJob();
    var phases = ['parsing', 'writing', 'validating', 'swapping', 'done'];
    phases.forEach(function (phase) {
      var transition = machines.transitionImport(job, { phase: phase });
      assert.ok(transition.accepted, 'transition acceptee vers ' + phase);
      job = transition.job;
    });
    assert.equal(job.phase, 'done', 'phase finale');
  });

  harness.it('transition interdite : downloading -> swapping', function () {
    var job = newJob();
    var transition = machines.transitionImport(job, { phase: 'swapping' });
    assert.equal(transition.accepted, false, 'transition refusee');
    assert.equal(transition.job.phase, 'downloading', 'job inchange');
  });

  harness.it('annulation apres 60 % : l index valide n est pas touche (phase preservee)', function () {
    var job = newJob();
    job = machines.checkpointImport(job, { bytesRead: 600, entriesRead: 60, currentCategory: 'Sports' }, 1000);
    var result = machines.transitionImport(job, { phase: 'cancelled', warnings: ['import annule par l utilisateur'] }, 2000);
    assert.ok(result.accepted, 'annulation acceptee');
    assert.equal(result.job.phase, 'cancelled', 'phase annulee');
    assert.equal(result.job.tempIndexVersion, 7, 'version temporaire conservee pour reprise');
    assert.equal(result.job.entriesRead, 60, 'compteur preserve');
  });

  harness.it('reprise apres mort du service : interrupted -> downloading', function () {
    var job = newJob();
    job = machines.transitionImport(job, { phase: 'interrupted' }).job;
    var resumed = machines.resumeImportJob(job, 5000);
    assert.ok(resumed.accepted, 'reprise acceptee');
    assert.equal(resumed.job.phase, 'downloading', 'phase de reprise');
    var notResumable = machines.resumeImportJob(Object.assign({}, job, { resumable: false }));
    assert.equal(notResumable.accepted, false, 'job non reprisable refuse');
  });

  harness.it('les compteurs ne reculent jamais', function () {
    var job = newJob();
    job = machines.checkpointImport(job, { bytesRead: 1000, entriesRead: 100 }, 1000);
    job = machines.checkpointImport(job, { bytesRead: 400, entriesRead: 40 }, 2000);
    assert.equal(job.bytesRead, 1000, 'octets monotones');
    assert.equal(job.entriesRead, 100, 'entrees monotones');
  });

  harness.it('avertissements nettoyes de tout secret', function () {
    var job = newJob();
    var result = machines.transitionImport(job, {
      phase: 'parsing',
      warnings: ['doublon ignore http://user:pass@host/live.ts?token=abcdefghij']
    });
    assert.ok(result.job.warnings[0].indexOf('pass') === -1, 'userinfo masque');
    assert.ok(result.job.warnings[0].indexOf('abcdefghij') === -1, 'token masque');
  });

  harness.it('job interrompu depuis plus de 7 jours propose au nettoyage', function () {
    var job = newJob();
    job = machines.transitionImport(job, { phase: 'interrupted' }, 1000).job;
    assert.equal(machines.shouldOfferCleanup(job, 1000 + 6 * 24 * 3600 * 1000), false, '6 jours : conserve');
    assert.equal(machines.shouldOfferCleanup(job, 1000 + 8 * 24 * 3600 * 1000), true, '8 jours : nettoyage propose');
  });

  harness.it('swapping est la seule transition qui change la version elue', function () {
    var job = newJob();
    var phases = ['parsing', 'writing', 'validating'];
    var versionBefore = job.tempIndexVersion;
    phases.forEach(function (phase) {
      job = machines.transitionImport(job, { phase: phase }).job;
    });
    assert.equal(job.tempIndexVersion, versionBefore, 'version temporaire inchangee avant swapping');
    var swapped = machines.transitionImport(job, { phase: 'swapping' }).job;
    assert.equal(swapped.phase, 'swapping', 'bascule engagee');
  });
});
