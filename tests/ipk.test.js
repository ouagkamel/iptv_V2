'use strict';

/**
 * **Lecture et contrôle des paquets** (`tools/ipk.js`).
 *
 * Deux choses à ne pas confondre, et que ces tests séparent :
 *
 *  - le `.ipk` est une archive `ar` qui contient `data.tar.gz` : notre lecture du format doit être
 *    exacte, sinon un contrôle « aucune source » peut passer à côté d'un paquet qui en contient ;
 *  - un paquet **publiable** ne déclare aucune source préconfigurée, un paquet **d'essai** en déclare
 *    une : le contrôle doit être ferme dans les deux sens.
 *
 * Les cas de format sont fabriqués ici même (`ar` + `tar` écrits à la main) : le test ne dépend donc
 * ni d'un paquet présent sur la machine, ni des outils `ar`/`tar`.
 */

var assert = require('./assert');
var harness = require('./harness');
var fs = require('fs');
var os = require('os');
var path = require('path');
var zlib = require('zlib');

var ROOT = path.join(__dirname, '..');
var ipk = require(path.join(ROOT, 'tools', 'ipk'));

/** Écrit une entrée `tar` (en-tête ustar + contenu aligné sur 512 octets). */
function blocTar(nom, contenu) {
  var entete = Buffer.alloc(512);
  entete.write(nom, 0, 100, 'latin1');
  entete.write('0000644', 100, 8, 'latin1');
  entete.write('0000000', 108, 8, 'latin1');
  entete.write('0000000', 116, 8, 'latin1');
  entete.write(contenu.length.toString(8).padStart(11, '0'), 124, 12, 'latin1');
  entete.write('00000000000', 136, 12, 'latin1');
  entete.write('        ', 148, 8, 'latin1');
  entete.write('0', 156, 1, 'latin1');
  entete.write('ustar\0', 257, 6, 'latin1');
  entete.write('00', 263, 2, 'latin1');
  // somme de contrôle : champs additionnés avec la somme remplacée par des espaces
  var somme = 0;
  for (var i = 0; i < 512; i++) somme += entete[i];
  entete.write(somme.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');

  var remplissage = Buffer.alloc((512 - (contenu.length % 512)) % 512);
  return Buffer.concat([entete, contenu, remplissage]);
}

function tar(entrees) {
  var morceaux = entrees.map(function (entree) {
    return blocTar(entree.nom, Buffer.from(entree.contenu, 'utf8'));
  });
  return Buffer.concat(morceaux.concat([Buffer.alloc(1024)]));
}

/** Écrit un membre d'archive `ar` (nom de 16 octets, taille en décimal). */
function membreAr(nom, donnees) {
  var entete = Buffer.alloc(60, 0x20);
  entete.write(nom, 0, nom.length, 'latin1');
  entete.write(String(donnees.length), 48, String(donnees.length).length, 'latin1');
  entete.write('`\n', 58, 2, 'latin1');
  var remplissage = donnees.length % 2 === 1 ? Buffer.from('\n', 'utf8') : Buffer.alloc(0);
  return Buffer.concat([entete, donnees, remplissage]);
}

/** Assemble un `.ipk` minimal contenant l'application et son `profils.js`. */
function ipkSynthetique(dossier, profilsJs, nom) {
  var charge = tar([
    { nom: 'usr/palm/applications/com.test.app/profils.js', contenu: profilsJs },
    { nom: 'usr/palm/applications/com.test.app/index.html', contenu: '<html></html>' },
    { nom: 'usr/palm/services/com.test.app.service/services.json', contenu: '{"services":[]}' }
  ]);
  var archive = Buffer.concat([
    Buffer.from('!<arch>\n', 'latin1'),
    membreAr('debian-binary', Buffer.from('2.0\n', 'utf8')),
    membreAr('control.tar.gz', zlib.gzipSync(tar([{ nom: './control', contenu: 'Package: com.test.app\n' }]))),
    membreAr('data.tar.gz', zlib.gzipSync(charge))
  ]);
  var fichier = path.join(dossier, nom || 'com.test.app_0.0.0_all.ipk');
  fs.writeFileSync(fichier, archive);
  return fichier;
}

var NEUTRE = [
  "'use strict';",
  '/**',
  " * Exemple : window.iptvProfils = {sources: [{id: \'p1\', url: \'http://exemple\'}]};",
  ' */',
  'window.iptvProfils = {sources: []};',
  ''
].join('\n');

var AVEC_SOURCE = [
  "'use strict';",
  'window.iptvProfils = {',
  '  sources: [',
  "    {id: 'p1', nom: 'Portail', url: 'http://kdfgh.com:8080', username: 'tjubfkkz', password: '789966423'}",
  '  ]',
  '};',
  ''
].join('\n');

harness.describe('paquets : lecture du format et sources déclarées', function () {
  harness.it('un paquet publiable ne déclare aucune source, un paquet d essai en déclare une', function () {
    assert.equal(ipk.sourcesDeclarees(NEUTRE).length, 0);
    assert.deepEqual(ipk.sourcesDeclarees(AVEC_SOURCE).join(','), 'p1');
    assert.equal(ipk.sourcesDeclarees('').length, 0);
  });

  harness.it('une source citée en commentaire n est pas une source déclarée', function () {
    var commentaire = [
      '/**',
      ' * window.iptvProfils = {sources: [{id: \'p9\', username: \'x\'}];',
      ' */',
      '// window.iptvProfils = {sources: [{id: \'p9\'}];',
      'window.iptvProfils = {sources: []};'
    ].join('\n');
    assert.equal(ipk.sourcesDeclarees(commentaire).length, 0);
    assert.equal(ipk.sourcesDeclarees(ipk.sansCommentaires(commentaire)).length, 0);
  });

  harness.it('lecture d un .ipk fabriqué ici : ar, tar, gzip et profils.js retrouvés', function () {
    var dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-ipk-'));
    var fichier = ipkSynthetique(dossier, AVEC_SOURCE);

    var noms = ipk.contenuDeIpk(fichier).map(function (entree) {
      return entree.nom;
    });
    assert.ok(noms.indexOf('usr/palm/applications/com.test.app/index.html') !== -1, 'index.html lu : ' + noms.join(', '));
    assert.ok(noms.indexOf('usr/palm/services/com.test.app.service/services.json') !== -1, 'service lu');
    assert.ok(ipk.profils(fichier).indexOf("id: 'p1'") !== -1, 'profils.js lu');
    assert.equal(ipk.sourcesDeclarees(ipk.profils(fichier)).join(','), 'p1');
    assert.ok(ipk.contient(fichier, '789966423'), 'identifiant retrouvé dans le paquet');
    assert.ok(!ipk.contient(fichier, 'motif-absent-xyz'), 'motif absent non trouvé');
  });

  harness.it('le contrôle de publication refuse un .ipk d essai et accepte une livraison propre', function () {
    var dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-ipk-'));
    var refus = require(path.join(ROOT, 'tools', 'publish-release')).refusIpk;

    var sale = ipkSynthetique(dossier, AVEC_SOURCE);
    assert.ok(refus(sale).length > 0, 'paquet avec identifiants refusé');

    var propre = ipkSynthetique(dossier, NEUTRE, 'livraison-propre.ipk');
    assert.equal(refus(propre).length, 0, 'paquet sans source accepté');
  });

  harness.it('les paquets présents sur la machine sont conformes à leur rôle', function () {
    var version = JSON.parse(fs.readFileSync(path.join(ROOT, 'appinfo.json'), 'utf8')).version;

    // livraison publiable
    var publique = path.join(ROOT, 'dist', version, 'com.ouagkamel.app.iptvplayer_' + version + '_all.ipk');
    if (fs.existsSync(publique)) {
      var declarees = ipk.sourcesDeclarees(ipk.profils(publique));
      assert.equal(declarees.length, 0, 'la livraison publique ne declare aucune source (' + declarees + ')');
    }

    // paquet d'essai : hors depot, mais s'il est là il doit porter la source preconfiguree
    var essai = path.join(ROOT, 'release', 'local', 'com.ouagkamel.app.iptvplayer_' + version + '_all.ipk');
    if (fs.existsSync(essai)) {
      assert.equal(ipk.sourcesDeclarees(ipk.profils(essai)).length, 1, 'le paquet d essai porte sa source');
      assert.ok(
        require(path.join(ROOT, 'tools', 'publish-release')).refusIpk(essai).length > 0,
        'le paquet d essai serait refuse par la publication'
      );
    }
  });
});
