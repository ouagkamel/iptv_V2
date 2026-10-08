#!/usr/bin/env node
'use strict';

/**
 * Livraison **d'essai** : l'application avec la source préconfigurée de `secrets.local/profils.js`
 * (hors dépôt). Destinée au banc d'essai (TV réelle, simulateur) — **jamais publiée**.
 *
 * Ce que le script fait, dans l'ordre :
 *  1. l'interface est reconstruite (`npm run build:ui`) puis l'application empaquetée
 *     (`tools/make-package.js`), ce qui intègre `secrets.local/profils.js` en remplacement de
 *     `src/app/profils.js` ;
 *  2. le pack simulateur est assemblé (`tools/stage-simulator.js`) ;
 *  3. les deux artefacts sont recopiés dans `release/local/` — dossier **hors publication**.
 *
 * `release/` est ignoré par git et `tools/publish-release.js` refuse toute archive qui embarque une
 * source : un paquet d'essai ne peut donc pas partir par erreur sur GitHub. Le rappel est répété en
 * fin d'exécution.
 *
 * Résultat :
 *   release/local/<id>_<version>_all.ipk        (paquet à installer sur la TV)
 *   release/local/<version>-simulateur-source.zip
 */

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var RELEASE = path.join(ROOT, 'release');
var LOCAL = path.join(RELEASE, 'local');
var SECRETS = path.join(ROOT, 'secrets.local', 'profils.js');

function creerDossiers(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
}

function executer(script, environnement) {
  var env = {};
  Object.keys(process.env).forEach(function (cle) {
    env[cle] = process.env[cle];
  });
  Object.keys(environnement || {}).forEach(function (cle) {
    env[cle] = environnement[cle];
  });
  var resultat = childProcess.spawnSync(process.execPath, [path.join(__dirname, script)], {
    stdio: 'inherit',
    cwd: ROOT,
    env: env
  });
  if (resultat.status !== 0) {
    console.error('[local] ' + script + ' a echoue (code ' + resultat.status + ')');
    process.exit(1);
  }
}

/** Feuille de route de l'essai, ecrite a cote des paquets (voir docs/PHASE-0.md pour le detail). */
function modeDEmploi(version, ipk, zip, tailleIpk, tailleZip) {
  return [
    'ESSAI SUR TV REELLE — paquets du banc d essai (version ' + version + ')',
    '='.repeat(64),
    '',
    'Ces deux fichiers portent la SOURCE PRECONFIGUREE de secrets.local/profils.js (adresse du',
    'portail et identifiants du compte de test). Ils ne doivent JAMAIS etre publies, pousses ni',
    'partages : ce sont des paquets d essai personnels.',
    '',
    '',
    '0. CE QUI CHANGE DANS CETTE VERSION (0.1.9)',
    '------------------------------------------',
    'Ecran noir du simulateur corrige : Enact demandait ses fichiers de langue EN SYNCHRONE au',
    'premier $L() d un composant Sandstone ; le paquet n en contenait aucun, l exception remontait',
    'au milieu du rendu React et l arbre etait demonte (page noire). Le chargement est desormais',
    'neutralise avant tout rendu (ui/src/services/sansLocales.js) ; verifie par un banc headless',
    'qui execute le paquet reel (tools/render-app.js). Attendu ici : l accueil a quatre cartes',
    's affiche. Si la page reste noire, la version installee n est pas la 0.1.9 : la verifier avec',
    '`ares-install --device tv --listfull` avant tout autre diagnostic.',
    '',
    '  release/local/' + ipk + '  ' + tailleIpk + '  -> TV',
    '  release/local/' + zip + '  ' + tailleZip + '  -> simulateur',
    '',
    '1. INSTALLER SUR LA TV (mode developpeur active)',
    '-----------------------------------------------',
    '  npm i -g @webosose/ares-cli',
    '  ares-setup-device --add tv --info "host=<IP de la TV>" --passphrase',
    '  ares-device  --device tv --system-info',
    '  ares-install --device tv release/local/' + ipk,
    '  ares-launch  --device tv com.ouagkamel.app.iptvplayer',
    '',
    'Le mode developpeur expire au bout de 1000 heures : s il est tombe, `ares-install` repond',
    '« connection refused » — reactiver « Developer Mode » sur la TV avant de conclure a un bug.',
    'Journal, dans un second terminal :  ares-log --device tv --follow',
    'Attendu : « [iptv] demarrage du service ... (node v8.12.x) » puis « ... 12 commandes ».',
    '',
    '2. PARCOURS A FAIRE DANS L APPLICATION',
    '--------------------------------------',
    '  1. Accueil : quatre cartes (Live TV, Films, Series, Reglages).',
    '  2. Reglages : champs DEJA REMPLIS, libelle ou entree citant le portail de test.',
    '  3. « Tester la source »  -> etat du compte et date d echeance.',
    '  4. « Importer (live) »   -> progression jusqu a « termine » + nombre d entree(s).',
    '  5. Live TV               -> categories, puis chaines.',
    '  6. OK sur une chaine     -> le lecteur s ouvre (image et son : partie 0B).',
    '  7. Touche Retour         -> lecteur ferme, retour a l accueil, puis sortie.',
    '  8. Reglages -> « Page de diagnostic (0A) » : meme chaine d operations avec la reponse',
    '     BRUTE du service, si un ecran reste vide.',
    '',
    'Verifie ce jour-la : installation, demarrage du service, enregistrement aupres du hub LS2,',
    'DB8 et stockage prive, permissions, TLS, index chiffre, enchainement des ecrans. C est le',
    'critere bloquant de la phase 0A (docs/PHASE-0.md).',
    '',
    '3. SI QUELQUE CHOSE NE VA PAS',
    '-----------------------------',
    '  « Service does not exist » -> desinstaller, reinstaller, redemarrer la TV :',
    '        ares-install --device tv -r com.ouagkamel.app.iptvplayer',
    '        ares-install --device tv release/local/' + ipk,
    '        ares-inspect --device tv -s com.ouagkamel.app.iptvplayer.service -o',
    '  Ecran vide                 -> Reglages -> « Page de diagnostic (0A) ».',
    '  « insecurescheme »         -> normal en http:// : autoriser l hote dans la boite qui',
    '                                s affiche, puis relancer.',
    '  Journaux : ares-log --device tv --lines 400',
    '',
    '4. SIMULATEUR (hors televiseur)',
    '-------------------------------',
    'Extraire ' + zip + ' dans un dossier PERSONNEL (~/iptv-simulateur), puis :',
    '  1. File > Add Service   -> service/com.ouagkamel.app.iptvplayer.service',
    '  2. Tools > Service List -> demarrer le service',
    '  3. File > Launch App    -> app/',
    'Sans l etape 1, tout appel repond « Service does not exist » : le simulateur n enregistre pas',
    'les services d un .ipk. Il ne prouve ni les permissions reelles, ni le pipeline media, ni les',
    'performances de la TV.',
    '',
    '5. RECONSTRUIRE',
    '---------------',
    '  ARES_PACKAGE=$(command -v ares-package) npm run dist:local',
    '',
    'Le script reconstruit l interface, empaquette l application avec la source, assemble le pack',
    'simulateur et recopie le tout ici. Il refuse de tourner avec IPTV_SANS_SOURCES=1 — cette',
    'cible-la existe justement pour construire SANS source, ce que la publication exige.',
    ''
  ].join('\n');
}

function main() {
  if (process.env.IPTV_SANS_SOURCES === '1') {
    console.error('[local] IPTV_SANS_SOURCES=1 : cette cible sert justement a embarquer la source');
    process.exit(1);
  }
  if (!fs.existsSync(SECRETS)) {
    console.error(
      '[local] secrets.local/profils.js absent : rien a embarquer.\n' +
        '  Ce fichier (hors depot) declare window.iptvProfils = {sources: [{id, nom, url, username, password}]}.\n' +
        '  Voir docs/PHASE-0.md, « Source preconfiguree ».'
    );
    process.exit(1);
  }

  creerDossiers(LOCAL);
  // le `.ipk` d'essai est ecrit **directement** dans `release/local/` : il ne peut plus ecraser le
  // paquet publiable de `release/` (c'est ainsi qu'un paquet d'essai a ete publie une fois).
  executer('build-ui.js');
  executer('make-package.js', { IPTV_SORTIE: path.relative(ROOT, LOCAL) });
  executer('stage-simulator.js');

  var appinfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'appinfo.json'), 'utf8'));
  var version = appinfo.version;
  var ipk = fs
    .readdirSync(LOCAL)
    .filter(function (nom) {
      return /\.ipk$/.test(nom) && nom.indexOf('_' + version + '_') !== -1;
    })
    .sort()[0];
  if (!ipk) {
    console.error('[local] paquet ' + version + ' introuvable dans release/local/');
    process.exit(1);
  }

  var cibleIpk = path.join(LOCAL, ipk);

  // Contrôle positif : un paquet d'essai **doit** porter la source préconfigurée, sinon l'utilisateur
  // retrouverait un écran vide en croyant tester la livraison d'essai.
  var declare = require('./ipk').profils(cibleIpk) || '';
  if (!/sources\s*:\s*\[\s*\{/.test(declare)) {
    console.error(
      '[local] ' + ipk + ' ne contient pas de source preconfiguree :\n' +
        '  verifier secrets.local/profils.js (window.iptvProfils = {sources: [{id, nom, url, ...}]})'
    );
    process.exit(2);
  }
  console.log('[local] source preconfiguree : presente dans le paquet d essai');

  // nettoyage d'un eventuel reste d'une execution anterieure dans release/
  var reste = path.join(RELEASE, ipk);
  if (fs.existsSync(reste)) {
    fs.unlinkSync(reste);
    console.log('[local] retire de release/ : ' + ipk + ' (un paquet d essai ne reste pas la ou la publication prend ses pieces)');
  }

  var zip = path.join(LOCAL, version + '-simulateur-source.zip');
  if (fs.existsSync(zip)) fs.unlinkSync(zip);
  var archive = childProcess.spawnSync('zip', ['-qr', zip, '.'], {
    cwd: path.join(RELEASE, 'simulator'),
    stdio: 'inherit'
  });
  if (archive.status !== 0 || !fs.existsSync(zip)) {
    console.error('[local] zip du simulateur impossible (outil `zip` absent ?)');
    process.exit(1);
  }

  var octets = function (fichier) {
    return fs.statSync(fichier).size + ' octets';
  };

  // mode d emploi ecrit a cote des paquets : il part avec eux sur une cle USB, un partage reseau,
  // n importe ou — c est la feuille de route de l essai, pas une note interne.
  var fiche = path.join(LOCAL, 'LISEZ-MOI-ESSAI.txt');
  fs.writeFileSync(fiche, modeDEmploi(version, ipk, path.basename(zip), octets(cibleIpk), octets(zip)), 'utf8');
  console.log('[local] mode d emploi : ' + path.relative(ROOT, fiche));

  console.log('[local] paquet d essai : ' + path.relative(ROOT, cibleIpk) + ' (' + octets(cibleIpk) + ')');
  console.log('[local] simulateur     : ' + path.relative(ROOT, zip) + ' (' + octets(zip) + ')');
  console.log('[local] installation   : ares-install --device tv ' + path.relative(ROOT, cibleIpk));
  console.log('[local] rappel : ces fichiers portent la source d essai — ne pas publier');
}

main();
