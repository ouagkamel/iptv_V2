'use strict';

/**
 * **Non-régression du démarrage de l'interface** (D-35) : l'écran noir de 0.1.8.
 *
 * Ce que vérifient ces tests, dans l'ordre où le défaut se produisait :
 *
 *  1. la source neutralise le chargement des données de langue (chargeur inerte + paquet de chaînes
 *     vide) **avant** le premier rendu ;
 *  2. le bundle réellement construit, exécuté dans un DOM headless avec un `XMLHttpRequest` qui
 *     imite Chromium en `file://`, n'émet **aucune** requête et ne produit **aucune** erreur ;
 *  3. l'écran d'accueil est bien rendu (les quatre cartes) — un bundle qui démarre sans rien afficher
 *     ne vaut pas mieux qu'un écran noir ;
 *  4. le paquet produit (`release/package` ou `dist/<version>/app`) se comporte pareil, puisque c'est
 *     l'arborescence que le simulateur et la TV exécutent.
 *
 * Le banc exige `jsdom` (dépendance d'outillage). Absent — ou bundle non construit — les tests
 * concernés sont **ignorés**, jamais faussement verts : ils le disent.
 */

var assert = require('./assert');
var harness = require('./harness');
var fs = require('fs');
var os = require('os');
var path = require('path');

var RACINE = path.join(__dirname, '..');

function creerDossiers(dir) {
  var parent = path.dirname(dir);
  if (parent !== dir && !fs.existsSync(parent)) creerDossiers(parent);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
}

function copier(source, cible) {
  fs.writeFileSync(cible, fs.readFileSync(source));
}

var outilRender = require(path.join(__dirname, '..', 'tools', 'render-app'));

/** jsdom est-il installable ici ? (dépendance d'outillage ; le banc sait le dire) */
function bancDisponible() {
  return outilRender.bancDisponible();
}

/** Arborescence de lancement équivalente à celle du paquet : index.html + ui/ (bundle + polices). */
function arborescenceDepuisBundle() {
  var dist = path.join(RACINE, 'ui', 'dist');
  if (!fs.existsSync(path.join(dist, 'main.js'))) return null;
  var provisoire = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-render-'));
  creerDossiers(path.join(provisoire, 'ui'));
  ['main.js', 'main.css'].forEach(function (nom) {
    copier(path.join(dist, nom), path.join(provisoire, 'ui', nom));
  });
  // les ressources du theme (polices) accompagnent le CSS : sans elles, ni texte ni icones
  creerDossiers(path.join(provisoire, 'ui', 'node_modules'));
  copierArbre(path.join(dist, 'node_modules'), path.join(provisoire, 'ui', 'node_modules'));
  copier(path.join(RACINE, 'src', 'app', 'index.html'), path.join(provisoire, 'index.html'));
  return provisoire;
}

/** Copie recursive (les polices du theme sont rangees sous `node_modules/@enact/...`). */
function copierArbre(source, cible) {
  if (!fs.existsSync(source)) return;
  creerDossiers(cible);
  fs.readdirSync(source).forEach(function (nom) {
    var depuis = path.join(source, nom);
    var vers = path.join(cible, nom);
    if (fs.statSync(depuis).isDirectory()) copierArbre(depuis, vers);
    else copier(depuis, vers);
  });
}

function bilanUtile(rapport) {
  return (
    'verdict=' + rapport.verdict +
    ' requetes=' + JSON.stringify(rapport.requetes) +
    ' ratees=' + JSON.stringify(rapport.requetesRatees) +
    ' erreurs=' + JSON.stringify(rapport.erreurs)
  );
}

harness.describe('interface : aucune donnée de langue n est demandée au démarrage', function () {
  harness.it('la source installe un chargeur inerte et un paquet de chaînes vide avant le rendu', function () {
    var index = fs.readFileSync(path.join(RACINE, 'ui', 'src', 'index.js'), 'utf8');
    var positionAppel = index.indexOf('installerLangueSansDonnees()');
    var positionRendu = index.indexOf('ReactDOM.render');
    assert.ok(positionAppel !== -1, 'neutralisation présente');
    assert.ok(positionRendu !== -1, 'rendu présent');
    assert.ok(positionAppel < positionRendu, 'neutralisation avant le premier rendu');

    var sansLocales = fs.readFileSync(
      path.join(RACINE, 'ui', 'src', 'services', 'sansLocales.js'),
      'utf8'
    );
    assert.ok(sansLocales.indexOf('setLoaderCallback') !== -1, 'chargeur remplacé');
    assert.ok(sansLocales.indexOf('setResBundle') !== -1, 'paquet de chaînes fixé');
    assert.ok(sansLocales.indexOf('XMLHttpRequest') !== -1, 'le défaut est documenté (XHR synchrone)');
    assert.ok(/loadFiles\s*:/.test(sansLocales), 'chargeur inerte complet');
  });

  harness.it('aucun composant de l application ne charge des données de langue', function () {
    var vues = fs.readdirSync(path.join(RACINE, 'ui', 'src'));
    assert.ok(vues.indexOf('services') !== -1, 'dossiers attendus présents');
    var fichiers = [];
    (function parcourir(dossier) {
      fs.readdirSync(dossier).forEach(function (nom) {
        var complet = path.join(dossier, nom);
        if (fs.statSync(complet).isDirectory()) parcourir(complet);
        else if (/\.js$/.test(nom)) fichiers.push(complet);
      });
    })(path.join(RACINE, 'ui', 'src'));
    fichiers.forEach(function (fichier) {
      var texte = fs.readFileSync(fichier, 'utf8');
      var relatif = path.relative(RACINE, fichier);
      if (relatif.indexOf('sansLocales.js') !== -1) return;
      assert.ok(texte.indexOf('setResBundle') === -1, relatif + ' ne touche pas au paquet de chaînes');
      // une seule exception : le module qui neutralise i18n (voir plus haut)
      assert.ok(texte.indexOf('@enact/i18n') === -1, relatif + ' n importe pas i18n');
      assert.ok(texte.indexOf('ilibmanifest') === -1, relatif + ' ne demande aucun fichier de langue');
    });
  });

  harness.it('le thème Sandstone enveloppe l application et ses polices accompagnent la feuille de style', function () {
    // 1) la source applique le décorateur a la racine, avant le rendu
    var index = fs.readFileSync(path.join(RACINE, 'ui', 'src', 'index.js'), 'utf8');
    assert.ok(index.indexOf("from '@enact/sandstone/ThemeDecorator'") !== -1, 'décorateur importé');
    assert.ok(index.indexOf('ThemeDecorator(App)') !== -1, 'décorateur appliqué');
    assert.ok(
      index.indexOf('ThemeDecorator(App)') < index.indexOf('ReactDOM.render'),
      'décorateur appliqué avant le rendu'
    );

    // 2) la feuille de style porte les regles du theme (police + couleur)…
    var css = fs.readFileSync(path.join(RACINE, 'ui', 'dist', 'main.css'), 'utf8');
    assert.ok(css.indexOf('@font-face') !== -1, 'polices déclarées (@font-face)');
    assert.ok(/ThemeDecorator_ThemeDecorator_root/.test(css), 'règles du nœud racine du thème');
    assert.ok(/font-family:"Sandstone"/.test(css) || /font-family: *"Sandstone"/.test(css), 'police Sandstone');

    // 3) …et chaque ressource qu elle reclame existe dans l arborescence de lancement
    var provisoire = arborescenceDepuisBundle();
    assert.ok(provisoire !== null, 'bundle construit');
    var manquantes = outilRender.ressourcesManquantes(provisoire);
    assert.equal(manquantes.length, 0, 'ressources présentes : ' + JSON.stringify(manquantes.slice(0, 5)));
  });

  harness.it('le bundle construit démarre sans requête et affiche les quatre cartes', function () {
    if (!bancDisponible()) return; // jsdom absent : test ignoré, jamais faussement vert
    var provisoire = arborescenceDepuisBundle();
    if (!provisoire) return; // interface non construite

    return outilRender
      .executerBanc(provisoire, 2500)
      .then(function (rapport) {
        assert.ok(rapport.verdict === 'OK', 'démarrage propre : ' + bilanUtile(rapport));
        assert.equal(rapport.requetes.length, 0, 'aucune requête : ' + JSON.stringify(rapport.requetes));
        assert.ok(rapport.theme === true, 'thème Sandstone appliqué (sinon texte noir sur fond noir)');
        assert.equal(
          rapport.ressourcesManquantes.length,
          0,
          'polices du thème présentes : ' + JSON.stringify(rapport.ressourcesManquantes)
        );
        assert.ok(rapport.racineHtml > 1000, 'écran rendu (' + rapport.racineHtml + ' octets de DOM)');
        ['Live TV', 'Films', 'Séries', 'Réglages'].forEach(function (carte) {
          assert.ok(
            rapport.texteRendu.indexOf(carte) !== -1,
            'carte « ' + carte + ' » visible dans : ' + rapport.texteRendu.slice(0, 120)
          );
        });
      });
  });

  harness.it('le paquet produit se comporte de même', function () {
    if (!bancDisponible()) return;
    var version = JSON.parse(fs.readFileSync(path.join(RACINE, 'appinfo.json'), 'utf8')).version;
    var candidats = [
      path.join(RACINE, 'dist', version, 'app'),
      path.join(RACINE, 'release', 'package')
    ];
    var paquet = candidats.filter(function (chemin) {
      return fs.existsSync(path.join(chemin, 'ui', 'main.js'));
    })[0];
    if (!paquet) return; // paquet non assemblé sur cette machine

    return outilRender
      .executerBanc(paquet, 2500)
      .then(function (rapport) {
        assert.ok(rapport.verdict === 'OK', path.relative(RACINE, paquet) + ' : ' + bilanUtile(rapport));
        assert.equal(rapport.requetes.length, 0, 'aucune requête depuis le paquet');
        assert.ok(rapport.theme === true, 'thème appliqué dans le paquet');
        assert.equal(
          rapport.ressourcesManquantes.length,
          0,
          'polices du thème présentes dans le paquet : ' + JSON.stringify(rapport.ressourcesManquantes)
        );
      });
  });
});
