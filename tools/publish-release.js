#!/usr/bin/env node
'use strict';

/**
 * Publication des livraisons sur GitHub — **outil de maintenance**, jamais exécuté par la CI.
 *
 *   node tools/publish-release.js create v0.1.4-phase0a 0.1.4 docs/RELEASE-0.1.4.md
 *   node tools/publish-release.js annotate v0.1.3-phase0a mention.txt
 *
 * Le jeton n'est **jamais** écrit dans le dépôt : il est lu dans `GITHUB_TOKEN`, ou dans le fichier
 * désigné par `GITHUB_TOKEN_FILE`, ou dans le premier des fichiers usuels présents sous
 * `~/uploads/` (`token.txt`, `ghtok.txt`) — tous hors dépôt. Rien de ce que l'outil affiche ne le
 * contient, et aucune commande ne l'écrit sur disque.
 *
 * Pièces jointes d'une version `X` (celles qui existent) : l'`.ipk`, l'archive `dist/X.zip`, le pack
 * `dist/X-simulateur.zip` et `dist/X/SHA256SUMS.txt`.
 */

var fs = require('fs');
var https = require('https');
var os = require('os');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var REPO = process.env.GITHUB_REPO || 'ouagkamel/iptv_V2';

/** Un chemin relatif est résolu depuis la racine du dépôt ; un chemin absolu est pris tel quel. */
function lire(chemin) {
  return fs.readFileSync(path.isAbsolute(chemin) ? chemin : path.join(ROOT, chemin), 'utf8');
}

function jeton() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  var candidats = [];
  if (process.env.GITHUB_TOKEN_FILE) candidats.push(process.env.GITHUB_TOKEN_FILE);
  candidats.push(path.join(os.homedir(), 'uploads', 'token.txt'));
  candidats.push(path.join(os.homedir(), 'uploads', 'ghtok.txt'));
  for (var index = 0; index < candidats.length; index += 1) {
    if (fs.existsSync(candidats[index])) return fs.readFileSync(candidats[index], 'utf8').trim();
  }
  console.error('Jeton GitHub introuvable : renseigner GITHUB_TOKEN ou GITHUB_TOKEN_FILE.');
  process.exit(2);
}

/** Un appel d'API : corps JSON facultatif, réponse analysée. */
function appel(method, chemin, corps) {
  return new Promise(function (resolve, reject) {
    var charge = corps === undefined ? null : Buffer.from(JSON.stringify(corps), 'utf8');
    var url = chemin.indexOf('https://') === 0 ? chemin : 'https://api.github.com' + chemin;
    var cible = new URL(url);
    var requete = https.request(
      {
        method: method,
        hostname: cible.hostname,
        path: cible.pathname + cible.search,
        headers: {
          Authorization: 'token ' + jeton(),
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'iptv-v2-release',
          'Content-Length': charge ? charge.length : 0
        }
      },
      function (reponse) {
        var morceaux = '';
        reponse.on('data', function (bloc) {
          morceaux += bloc.toString('utf8');
        });
        reponse.on('end', function () {
          var donnees = null;
          try {
            donnees = morceaux ? JSON.parse(morceaux) : {};
          } catch (_erreur) {
            donnees = { brut: morceaux };
          }
          if (reponse.statusCode >= 400) {
            reject(new Error(method + ' ' + cible.pathname + ' -> HTTP ' + reponse.statusCode + ' : ' + JSON.stringify(donnees).slice(0, 300)));
            return;
          }
          resolve(donnees);
        });
      }
    );
    requete.on('error', reject);
    if (charge) requete.write(charge);
    requete.end();
  });
}

/** Téléversement d'une pièce jointe (flux binaire, pas d'encodage JSON). */
function televerser(uploadUrl, fichier) {
  return new Promise(function (resolve, reject) {
    var nom = path.basename(fichier);
    var cible = new URL(uploadUrl.split('{')[0] + '?name=' + encodeURIComponent(nom));
    var contenu = fs.readFileSync(fichier);
    var requete = https.request(
      {
        method: 'POST',
        hostname: cible.hostname,
        path: cible.pathname + cible.search,
        headers: {
          Authorization: 'token ' + jeton(),
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/octet-stream',
          'User-Agent': 'iptv-v2-release',
          'Content-Length': contenu.length
        }
      },
      function (reponse) {
        var morceaux = '';
        reponse.on('data', function (bloc) {
          morceaux += bloc.toString('utf8');
        });
        reponse.on('end', function () {
          if (reponse.statusCode >= 400) {
            reject(new Error('televersement ' + nom + ' -> HTTP ' + reponse.statusCode + ' : ' + morceaux.slice(0, 200)));
            return;
          }
          var resultat = JSON.parse(morceaux);
          console.log('  piece jointe : ' + nom + ' (' + resultat.size + ' octets)');
          resolve(resultat);
        });
      }
    );
    requete.on('error', reject);
    requete.write(contenu);
    requete.end();
  });
}

/**
 * Refus de publier une livraison qui embarque des **sources préconfigurées avec identifiants** :
 * `dist/<version>/app/profils.js` les déclare. Les dépôts et les publications GitHub sont publics ;
 * une telle archive exposerait le compte. Reconstruire sans elles pour publier :
 *
 *   IPTV_SANS_SOURCES=1 npm run dist
 */
/** Retire commentaires de bloc et de ligne (voir `tools/ipk.js`) : le fichier du dépôt
 * **documente** une source en commentaire, ce qui n'est pas une source déclarée. */
function sansCommentaires(source) {
  return require('./ipk').sansCommentaires(source);
}

function verifierSansSecrets(version) {
  var profils = path.join(ROOT, 'dist', version, 'app', 'profils.js');
  if (!fs.existsSync(profils)) return;
  var declarees = require('./ipk').sourcesDeclarees(fs.readFileSync(profils, 'utf8'));
  if (declarees.length > 0) {
    console.error(
      'Publication refusee : dist/' + version + '/app/profils.js declare ' + declarees.length +
        ' source(s) preconfiguree(s) (' + declarees.join(', ') + ').\n' +
        'Reconstruire une livraison publiable : IPTV_SANS_SOURCES=1 npm run dist'
    );
    process.exit(3);
  }
}

/**
 * Contrôle des **pièces réellement téléversées**, paquet par paquet : c'est le fichier qui part sur
 * GitHub qui est ouvert, pas le dossier dont il est censé venir. Un `.ipk` qui déclare des sources
 * préconfigurées (identifiants de compte) est refusé — sans exception, quel que soit son emplacement.
 *
 * Le 0.1.9 a été publié une fois avec le paquet d'essai parce que la publication prenait l'`.ipk`
 * dans `release/`, où le pack d'essai venait d'écraser celui de la livraison : la vérification
 * portait sur `dist/` et le fichier téléversé venait d'ailleurs. Les pièces viennent maintenant de
 * `dist/<version>/`, et le contenu est relu **dans l'archive**.
 */
/** Motifs de refus d'un `.ipk`, sans effet de bord : `[]` si le paquet est publiable. */
function refusIpk(chemin) {
  var ipk = require('./ipk');
  var contenu = ipk.profils(chemin);
  var declarees = ipk.sourcesDeclarees(contenu);
  var refus = [];

  if (declarees.length > 0) {
    refus.push('il declare ' + declarees.length + ' source(s) preconfiguree(s) : ' + declarees.join(', '));
  }
  var local = path.join(ROOT, 'secrets.local', 'profils.js');
  if (fs.existsSync(local)) {
    var identifiants = fs.readFileSync(local, 'utf8');
    [/'http:\/\/([^':]+)/, /username:\s*'([^']+)'/, /password:\s*'([^']+)'/].forEach(function (motif) {
      var trouve = motif.exec(identifiants);
      if (trouve && ipk.contient(chemin, trouve[1])) {
        refus.push('il contient un identifiant du compte de test (motif de ' + trouve[1].length + ' caracteres)');
      }
    });
  }

  return refus;
}

/** Applique le refus : la publication s'arrete (code 3) avant tout televersement. */
function verifierIpkSansIdentifiants(chemin) {
  var refus = refusIpk(chemin);
  if (refus.length > 0) {
    console.error(
      'Publication refusee : ' + path.relative(ROOT, chemin) + '\n' +
        '  - ' + refus.join('\n  - ') + '\n' +
        'Reconstruire une livraison publiable : IPTV_SANS_SOURCES=1 npm run dist'
    );
    process.exit(3);
  }
  console.log('  controle : ' + path.basename(chemin) + ' sans identifiants');
}

function piecesJointes(version) {
  return [
    path.join(ROOT, 'dist', version, 'com.ouagkamel.app.iptvplayer_' + version + '_all.ipk'),
    path.join(ROOT, 'dist', version + '.zip'),
    path.join(ROOT, 'dist', version + '-simulateur.zip'),
    path.join(ROOT, 'dist', version, 'SHA256SUMS.txt')
  ].filter(function (fichier) {
    return fs.existsSync(fichier);
  });
}

function creer(balise, version, notes) {
  verifierSansSecrets(version);
  piecesJointes(version).filter(function (f) { return /\.ipk$/.test(f); }).forEach(verifierIpkSansIdentifiants);
  var corps = lire(notes);
  return appel('POST', '/repos/' + REPO + '/releases', {
    tag_name: balise,
    target_commitish: 'main',
    name: balise + ' — paquet de diagnostic (phase 0A)',
    body: corps,
    draft: false,
    prerelease: true
  }).then(function (release) {
    console.log('release creee : ' + release.id + ' ' + release.tag_name);
    return piecesJointes(version).reduce(function (chaine, fichier) {
      return chaine.then(function () {
        return televerser(release.upload_url, fichier);
      });
    }, Promise.resolve()).then(function () {
      return appel('GET', '/repos/' + REPO + '/releases/' + release.id);
    });
  }).then(function (release) {
    release.assets.forEach(function (actif) {
      console.log('  actif : ' + actif.name + ' (' + actif.size + ' octets)');
    });
  });
}

function annoter(balise, fichier) {
  var mention = lire(fichier).trim();
  return appel('GET', '/repos/' + REPO + '/releases/tags/' + balise).then(function (release) {
    var corps = release.body || '';
    if (corps.indexOf(mention) !== -1) {
      console.log('mention deja presente : ' + balise);
      return null;
    }
    return appel('PATCH', '/repos/' + REPO + '/releases/' + release.id, { body: mention + '\n\n' + corps }).then(function () {
      console.log('release annotee : ' + balise);
    });
  });
}

function main() {
  var action = process.argv[2];
  var suite;
  if (action === 'create') {
    suite = creer(process.argv[3], process.argv[4], process.argv[5]);
  } else if (action === 'annotate') {
    suite = annoter(process.argv[3], process.argv[4]);
  } else {
    console.error('usage : create <balise> <version> <notes.md> | annotate <balise> <mention.txt>');
    process.exit(2);
  }
  suite.catch(function (erreur) {
    console.error(String(erreur && erreur.message ? erreur.message : erreur));
    process.exit(1);
  });
}

if (require.main === module) main();

module.exports = { piecesJointes: piecesJointes, refusIpk: refusIpk };
