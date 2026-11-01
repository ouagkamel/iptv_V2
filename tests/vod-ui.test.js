'use strict';

var assert = require('./assert');
var harness = require('./harness');
var vodUtils = require('../ui/src/services/vod-utils');

harness.describe('Aides d’affichage VOD (UI)', function () {
  harness.it('formate les durées sans fabriquer de donnée absente', function () {
    assert.equal(vodUtils.formaterDuree(0), '', 'durée nulle masquée');
    assert.equal(vodUtils.formaterDuree(-3), '', 'durée invalide masquée');
    assert.equal(vodUtils.formaterDuree('inconnue'), '', 'valeur non numérique masquée');
    assert.equal(vodUtils.formaterDuree(65), '1 min', 'durée courte arrondie à la minute');
    assert.equal(vodUtils.formaterDuree(3900), '1 h 5 min', 'heures et minutes lisibles');
    assert.equal(vodUtils.formaterDuree(7200), '2 h', 'heure exacte sans suffixe vide');
  });

  harness.it('n’affiche que les métadonnées fournies', function () {
    assert.equal(vodUtils.libelleSecondaire({year: 2024, durationSeconds: 3660}), '2024 · 1 h 1 min', 'année et durée réunies');
    assert.equal(vodUtils.libelleSecondaire({year: 2024}), '2024', 'durée absente omise');
    assert.equal(vodUtils.libelleSecondaire({durationSeconds: 1800}), '30 min', 'année absente omise');
    assert.equal(vodUtils.libelleSecondaire({}), '', 'aucun champ ne réserve une ligne vide');
  });

  harness.it('filtre les sources d’affiche non HTTP(S) et les userinfo', function () {
    assert.equal(vodUtils.urlAffiche('https://images.example/poster.jpg'), 'https://images.example/poster.jpg', 'HTTPS accepté');
    assert.equal(vodUtils.urlAffiche(' http://images.example/poster.jpg '), 'http://images.example/poster.jpg', 'espaces périphériques retirés');
    assert.equal(vodUtils.urlAffiche('javascript:alert(1)'), '', 'schéma actif refusé');
    assert.equal(vodUtils.urlAffiche('file:///etc/passwd'), '', 'fichier local refusé');
    assert.equal(vodUtils.urlAffiche('https://user:secret@images.example/poster.jpg'), '', 'userinfo refusé');
    assert.equal(vodUtils.urlAffiche(null), '', 'valeur absente prise en charge');
  });
});
