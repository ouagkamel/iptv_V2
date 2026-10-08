'use strict';

/**
 * Lecture d'un `.ipk` **sans outil externe** : un `.ipk` webOS est une archive `ar` contenant
 * `data.tar.gz`, qui contient l'application (`app/`) et le service.
 *
 * Raison d'être de ce module : la vérification qui compte n'est pas « le dossier `dist/` est propre »
 * mais « **ce fichier-là**, celui qui part sur GitHub, est propre ». On lit donc le paquet lui-même.
 *
 * Aucune dépendance : `ar` et `tar` sont relus à la main (en lecture seule) pour que le contrôle
 * fonctionne là où la publication se fait, sans `tar` ni `ar` installés.
 */

var fs = require('fs');
var zlib = require('zlib');

/** Décompose une archive `ar` en une liste `{nom, donnees}`. */
function lireAr(donnees) {
  if (donnees.length < 8 || donnees.slice(0, 8).toString('latin1') !== '!<arch>\n') return null;
  var membres = [];
  var position = 8;
  while (position + 60 <= donnees.length) {
    var entete = donnees.slice(position, position + 60);
    var nom = entete.slice(0, 16).toString('latin1').replace(/\0/g, '').trim().replace(/\/$/, '');
    var taille = parseInt(
      entete.slice(48, 58).toString('latin1').replace(/\0/g, '').trim(),
      10
    );
    if (!entete.slice(58, 60).toString('latin1').match(/^`\n$/) || !isFinite(taille)) break;
    var debut = position + 60;
    membres.push({ nom: nom, donnees: donnees.slice(debut, debut + taille) });
    position = debut + taille + (taille % 2); // les membres sont alignes sur deux octets
  }
  return membres;
}

/** Decompose une archive `tar` en une liste `{nom, donnees}`. */
function lireTar(donnees) {
  var fichiers = [];
  var position = 0;
  var nomLong = null;
  while (position + 512 <= donnees.length) {
    var entete = donnees.slice(position, position + 512);
    var vide = true;
    for (var i = 0; i < 512 && vide; i++) if (entete[i] !== 0) vide = false;
    if (vide) break;

    var nom = entete.slice(0, 100).toString('latin1').replace(/\0[\s\S]*$/, '');
    var taille = parseInt(
      entete.slice(124, 136).toString('latin1').replace(/\0[\s\S]*$/, '').trim() || '0',
      8
    );
    var type = entete.slice(156, 157).toString('latin1');
    var prefixe = entete.slice(345, 500).toString('latin1').replace(/\0[\s\S]*$/, '');
    if (!isFinite(taille)) break;

    var debut = position + 512;
    var contenu = donnees.slice(debut, debut + taille);

    if (type === 'L') {
      nomLong = contenu.toString('latin1').replace(/\0[\s\S]*$/, ''); // nom long GNU
    } else if (type === 'x' || type === 'g') {
      // en-tete pax : ignore
    } else {
      var complet = nomLong || (prefixe && nom ? prefixe + '/' + nom : nom);
      nomLong = null;
      if (complet) fichiers.push({ nom: complet.replace(/^\.\//, ''), donnees: contenu });
    }
    position = debut + Math.ceil(taille / 512) * 512;
  }
  return fichiers;
}

/** Contenu de tous les fichiers portes par un `.ipk` (payload decompresse), plus la liste des noms. */
function contenuDeIpk(chemin) {
  var brut = fs.readFileSync(chemin);
  var membres = lireAr(brut);
  if (!membres) membres = [{ nom: chemin, donnees: brut }]; // `data.tar.gz` seule (tests)

  var fichiers = [];
  membres.forEach(function (membre) {
    var donnees = membre.donnees;
    if (donnees.length > 2 && donnees[0] === 0x1f && donnees[1] === 0x8b) {
      try {
        donnees = zlib.gunzipSync(donnees);
      } catch (erreur) {
        return;
      }
    }
    if (donnees.length < 512) return;
    if (donnees.slice(257, 262).toString('latin1') !== 'ustar' && donnees.slice(0, 100).indexOf(0) === -1) {
      return; // ni tar ustar, ni entete tar plausible
    }
    lireTar(donnees).forEach(function (fichier) {
      fichiers.push({ nom: fichier.nom, donnees: fichier.donnees });
    });
  });
  return fichiers;
}

/** Contenu de `app/profils.js` (sources preconfigurees de l'application), ou `null`. */
function profils(chemin) {
  var trouve = contenuDeIpk(chemin).filter(function (fichier) {
    return /(^|\/)profils\.js$/.test(fichier.nom);
  })[0];
  return trouve ? trouve.donnees.toString('utf8') : null;
}

/** Recherche un texte (identifiant, hote, mot de passe) partout dans le paquet. */
function contient(chemin, motif) {
  if (fs.readFileSync(chemin).indexOf(motif) !== -1) return true;
  return contenuDeIpk(chemin).some(function (fichier) {
    return fichier.donnees.indexOf(motif) !== -1;
  });
}

/** Retire commentaires de bloc et de ligne : un fichier peut **documenter** une source en
 * commentaire (c'est le cas de `src/app/profils.js`), ce qui ne doit pas etre pris pour une source
 * reellement declaree. */
function sansCommentaires(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Identifiants des sources reellement declarees par un `profils.js` : `[]` si aucune. */
function sourcesDeclarees(contenu) {
  if (!contenu) return [];
  var declaration = /window\.iptvProfils\s*=([\s\S]*?);/.exec(sansCommentaires(contenu));
  if (!declaration) return [];
  var liste = /sources\s*:\s*\[([\s\S]*?)\]/.exec(declaration[1]);
  if (!liste || liste[1].trim() === '') return [];
  var ids = [];
  var motif = /id\s*:\s*['"]([^'"]+)['"]/g;
  var trouve;
  while ((trouve = motif.exec(liste[1])) !== null) ids.push(trouve[1]);
  return ids.length > 0 ? ids : ['<sans id>'];
}

module.exports = {
  sansCommentaires: sansCommentaires,
  sourcesDeclarees: sourcesDeclarees,
  contenuDeIpk: contenuDeIpk,
  profils: profils,
  contient: contient,
  lireAr: lireAr,
  lireTar: lireTar
};
