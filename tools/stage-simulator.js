#!/usr/bin/env node
'use strict';

/**
 * Prépare le **pack pour le simulateur webOS** — `release/simulator/`.
 *
 * Le simulateur ne fonctionne pas comme un téléviseur : il **n'installe pas** un `.ipk`. L'application
 * se lance depuis un **dossier** (menu *File > Launch App*) et le service doit être **ajouté
 * explicitement** (menu *File > Add Service*) puis démarré (*Tools > Service List*). Un service
 * déclaré seulement dans un `.ipk` n'est donc jamais enregistré auprès du bus du simulateur : toute
 * requête se termine par « Service does not exist », même si l'application, elle, tourne.
 *
 * Ce script produit donc deux dossiers-là, à sélectionner tels quels :
 *
 *   release/simulator/
 *     app/                                    → *File > Launch App* (racine de l'application)
 *     service/<id de service>/                → *File > Add Service* (racine du service)
 *     LISEZ-MOI-SIMULATEUR.txt
 *
 * La documentation LG précise que le dossier du service doit se trouver **sous le répertoire de
 * l'utilisateur** : c'est pourquoi le `LISEZ-MOI` demande d'extraire l'archive dans le dossier
 * personnel plutôt que dans `/tmp`.
 */

var childProcess = require('child_process');
var fs = require('fs');
var path = require('path');

var outilDist = require('./make-dist');

var ROOT = path.join(__dirname, '..');
var RELEASE = path.join(ROOT, 'release');
var INSPECTION = path.join(RELEASE, 'package');
var CIBLE = path.join(RELEASE, 'simulator');

/** Refus explicite : lève (jamais `process.exit` depuis une fonction appelée par les tests). */
function refuser(message) {
  throw new Error('[simulateur] ' + message);
}

function removeTree(cible) {
  if (!fs.existsSync(cible)) return;
  fs.readdirSync(cible).forEach(function (nom) {
    var complet = path.join(cible, nom);
    if (fs.statSync(complet).isDirectory()) removeTree(complet);
    else fs.unlinkSync(complet);
  });
  fs.rmdirSync(cible);
}

var LISEZ_MOI = [
  'Pack pour le SIMULATEUR webOS TV',
  '=================================',
  '',
  'Le simulateur n\'installe pas de .ipk : l\'application se lance depuis un dossier et le service',
  'doit etre ajoute explicitement. Sans cette etape, tous les appels repondent',
  '« Service does not exist: <id du service> », meme si l\'application tourne.',
  '',
  '1) Extraire ce dossier dans votre dossier personnel (obligatoire pour le service) :',
  '       unzip <version>-simulateur.zip -d ~/iptv-simulateur',
  '',
  '2) Ajouter le service (une fois par session du simulateur) :',
  '       menu File > Add Service  ->  choisir  ~/iptv-simulateur/service/<id du service>',
  '       (la racine du service est le dossier qui contient package.json)',
  '   puis Tools > Service List  ->  cliquer sur le service pour le DEMARRER.',
  '',
  '3) Lancer l\'application :',
  '       menu File > Launch App   ->  choisir  ~/iptv-simulateur/app',
  '   (ou : ares-launch -s <version webOS> ~/iptv-simulateur/app)',
  '',
  '4) L interface s ouvre sur l accueil a quatre cartes. Si un ecran reste vide :',
  '   Reglages -> « Page de diagnostic (0A) », ou « Temoin du bus LS2 » doit repondre (le pont',
  '   fonctionne) et « Diagnostic du service » afficher db.ok, runtime.node, roots et indexes.',
  '',
  '5) Portail en HTTP clair : l\'activer en un clic.',
  '   Un portail http:// (et non https://) est refuse tant que son autorisation n\'est pas donnee',
  '   (§8.2 de la specification). La page le dit : la case « Portail en HTTP clair : j\'autorise »',
  '   se coche d\'elle-meme, un bandeau explique le risque et propose « Relancer ». Le service',
  '   enregistre cette autorisation une seule fois par hote et par profil.',
  '',
  'Correspondance des dossiers :',
  '       app/                       -> APP_DIR          (File > Launch App)',
  '       service/<id du service>/    -> SERVICE_DIR      (File > Add Service)',
  '',
  'Sur un televiseur, en revanche, c\'est le .ipk qui s\'installe (ares-install) : la procedure',
  'complete est dans docs/PHASE-0.md, section 0A.',
  ''
].join('\n');

/** Copie le contenu empaqueté sous la forme attendue par le simulateur (app/ + service/ + LISEZ-MOI). */
function preparerPackSimulateur(inspection, cible) {
  if (!fs.existsSync(path.join(inspection, 'appinfo.json'))) {
    refuser('contenu empaquete introuvable : ' + inspection);
  }
  removeTree(cible);
  outilDist.copierArborescence(inspection, cible);
  fs.writeFileSync(path.join(cible, 'LISEZ-MOI-SIMULATEUR.txt'), LISEZ_MOI, 'utf8');
  return cible;
}

function main() {
  try {
    if (!fs.existsSync(INSPECTION)) {
      var paquetage = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'make-package.js')], { stdio: 'inherit' });
      if (paquetage.status !== 0) refuser('empaquetage impossible (voir les messages ci-dessus)');
    }
    preparerPackSimulateur(INSPECTION, CIBLE);

    var appinfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'appinfo.json'), 'utf8'));
    console.log('[simulateur] dossier : ' + path.relative(ROOT, CIBLE));
    console.log('[simulateur] application : ' + path.relative(ROOT, path.join(CIBLE, 'app')) + '  (File > Launch App)');
    console.log('[simulateur] service     : ' + path.relative(ROOT, path.join(CIBLE, 'service', appinfo.id + '.service')) + '  (File > Add Service)');
  } catch (erreur) {
    console.error(String(erreur && erreur.message ? erreur.message : erreur));
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { CIBLE: CIBLE, LISEZ_MOI: LISEZ_MOI, preparerPackSimulateur: preparerPackSimulateur };
