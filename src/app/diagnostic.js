'use strict';

/**
 * Coquille de diagnostic de la phase 0A — **page de test**, pas l'interface du produit.
 *
 * Elle n'utilise que les API webOS présentes sur la TV (`webOS.service.request`, `webOS.deviceInfo`)
 * — fournies par `webos-bridge.js`, embarqué dans le paquet (la bibliothèque `webOSTV.js` du SDK LG
 * n'est **pas** copiée dans le dépôt ; son absence dans le paquet a produit un
 * `net::ERR_FILE_NOT_FOUND` dans la console de la TV et laissait `window.webOS` vide) —
 * et les onze commandes du service. Son but : prouver sur un téléviseur réel que le service est
 * joignable en LS2, que ses commandes non publiques répondent, que DB8 est accessible avec les
 * bonnes permissions et que le répertoire privé du service est inscriptible.
 *
 * Ce qu'elle ne fait pas : aucune URL de flux persistée, aucun identifiant journalisé, aucun appel
 * direct au réseau (tout passe par le service). L'interface Enact de V1-A remplacera cette page.
 */

var SERVICE = 'luna://com.ouagkamel.app.iptvplayer.service';
var derniereJobId = null;
/** Dernière action de l'utilisateur, pour la relancer après une autorisation (§8.2). */
var relancerDerniereAction = function () { journal('aucune action a relancer', 'ko'); };

function el(id) {
  return document.getElementById(id);
}

function journal(message, nature) {
  var ligne = document.createElement('div');
  ligne.className = 'ligne' + (nature ? ' ' + nature : '');
  var heure = new Date().toISOString().slice(11, 19);
  ligne.textContent = heure + '  ' + message;
  var zone = el('journal');
  zone.appendChild(ligne);
  zone.scrollTop = zone.scrollHeight;
}

/** Masque les secrets avant affichage : la page ne montre jamais une URL complète par défaut. */
function assainir(valeur) {
  var texte = typeof valeur === 'string' ? valeur : JSON.stringify(valeur, null, 2);
  if (el('afficherurl').checked) return texte;
  return texte
    .replace(/(https?:\/\/)[^\s"']*:[^\s"']*@/g, '$1***:***@')
    .replace(/([?&](?:username|password|token|user|pass)=)[^&\s"']*/gi, '$1***');
}

function format() {
  return window.iptvFormat || { texteErreur: String, texteReponse: function (v) { return String(v); } };
}

/**
 * Affichage d'une réponse. Le verdict est lu **aussi** dans `data.ok` : `testProfile` répond
 * `returnValue: true` avec un verdict métier dans `data` (compte expiré, identifiants refusés…).
 * Sans cela, la ligne du journal restait verte alors que le compte était inutilisable.
 */
function afficher(titre, charge) {
  var texte = assainir(charge);
  el('sortie').textContent = '// ' + titre + '\n' + texte;
  var verdict = charge && charge.data && charge.data.ok;
  var echec = (charge && charge.returnValue === false) || verdict === false;
  var resume = '';
  if (echec) {
    var premiere = charge && charge.data && charge.data.errors && charge.data.errors[0];
    resume = ' : ' + (charge.error ? format().texteErreur(charge) : premiere ? premiere.code + ' — ' + premiere.message : 'echec');
  } else if (verdict === true) {
    resume = ' : ok';
  }
  journal(titre + resume, echec ? 'ko' : 'ok');
}

/**
 * Erreur affichée **telle quelle** : l'enveloppe du service (§15.4) porte `code`, `message` et
 * `hint` ; le bus porte `errorText`. La page ne reformule rien, sinon un défaut devient illisible
 * (c'est ce qui produisait « [object Object] » à l'écran).
 */
function afficherErreur(titre, erreur) {
  var detail = format().texteErreur(erreur);
  var json = '';
  try {
    json = '\n\n' + assainir(erreur);
  } catch (_erreur) {
    json = '';
  }
  el('sortie').textContent = '// ' + titre + '\n' + detail + json;
  journal(titre + ' : ' + detail, 'ko');
}

/**
 * Appel LS2. Un seul chemin : `webOS.service.request` — fourni par la plateforme quand elle
 * l'injecte, sinon par `webos-bridge.js` embarqué (pont `PalmServiceBridge`). La page n'a donc
 * jamais besoin d'un fichier absent du paquet.
 *
 * `options.abonnement` : la réponse peut arriver plusieurs fois (`importPlaylist`) ; `onFailure` est
 * appelé pour toute réponse `returnValue: false`, avec le message brut du bus — c'est ce message qui
 * est affiché tel quel, jamais reformulé, pour que le diagnostic sur la TV soit exploitable.
 */
function appeler(commande, parametres, options) {
  options = options || {};
  var charge = parametres || {};
  return new Promise(function (resolve, reject) {
    var api = window.webOS && window.webOS.service ? window.webOS.service : null;
    if (!api || typeof api.request !== 'function') {
      reject(new Error('aucun pont LS2 disponible : cette page doit s’exécuter sur la TV (ou le simulateur LG)'));
      return;
    }
    var fourni = false;
    api.request(SERVICE, {
      method: commande,
      parameters: charge,
      subscribe: options.abonnement === true,
      onSuccess: function (reponse) {
        if (options.aChaqueReponse) options.aChaqueReponse(reponse);
        // la promesse se règle sur la première réponse (comme `onSuccess` de la bibliothèque LG) ;
        // en abonnement, les réponses suivantes passent par `aChaqueReponse`
        if (!fourni) {
          fourni = true;
          resolve(reponse);
        }
      },
      onFailure: function (erreur) {
        if (options.aChaqueReponse) options.aChaqueReponse(erreur);
        if (!fourni) {
          fourni = true;
          reject(erreur);
        }
      }
    });
  });
}

/** Message brut d'une réponse ou d'une erreur LS2, sans reformulation. */
function texteBrut(valeur) {
  return format().texteErreur(valeur);
}

/** L'environnement réel de la page : c'est ce tableau qui dit s'il manque un pont ou un fichier. */
function environnement() {
  var pont = window.webOS && window.webOS.__pont ? window.webOS.__pont : null;
  return {
    adresse: String(window.location.href),
    agent: navigator.userAgent,
    pont: pont ? pont.chemin : window.webOS && window.webOS.service && window.webOS.service.request ? 'fourni (inconnu)' : 'aucun',
    bridgeBasNiveau: typeof window.PalmServiceBridge === 'function',
    palmSystem: !!(window.PalmSystem || window.palmSystem),
    service: SERVICE,
    // le simulateur webOS n'enregistre pas les services déclarés par un .ipk : il faut les ajouter
    // à la main (File > Add Service). Le reconnaître évite de chercher un défaut côté paquet.
    simulateur: /simulator|emulator/i.test(navigator.userAgent),
    versionPage: '0.1.13'
  };
}

function afficherEnvironnement(details) {
  var env = environnement();
  var zone = el('pont');
  var lignes = [
    '<b>pont LS2</b> : ' + env.pont + (env.bridgeBasNiveau ? ' (PalmServiceBridge présent)' : ' (PalmServiceBridge absent)'),
    '<b>PalmSystem</b> : ' + (env.palmSystem ? 'présent' : 'absent'),
    '<b>service appelé</b> : ' + env.service,
    '<b>page</b> : ' + env.adresse,
    '<b>agent</b> : ' + env.agent +
      (env.simulateur ? ' <b>(simulateur)</b> — le service doit y être ajouté à la main (File &gt; Add Service)' : '')
  ];
  if (details) lignes.push('<b>appareil</b> : ' + details);
  zone.innerHTML = lignes.join('<br>');
}

/** Bannière rouge : cause lue dans le message brut du bus, plus les gestes à faire sur la TV. */
function banniere(titre, texte, gestes, action) {
  el('banniere-titre').textContent = titre;
  var html = '<div style="font-size:15px;line-height:1.5">' + texte + '</div>';
  if (gestes && gestes.length) {
    html += '<ol>' + gestes.map(function (g) { return '<li>' + g + '</li>'; }).join('') + '</ol>';
  }
  if (action && action.libelle) {
    // bouton d'action : « Relancer » après avoir confirmé une autorisation, par exemple
    html += '<div class="rang" style="margin-top:10px"><button id="banniere-action" class="principal">' +
      action.libelle + '</button></div>';
  }
  el('banniere-texte').innerHTML = html;
  el('banniere').className = 'banniere visible';
  if (action && action.libelle) {
    el('banniere-action').onclick = function () {
      masquerBanniere();
      action.action();
    };
  }
}

function masquerBanniere() {
  el('banniere').className = 'banniere';
}

/**
 * Appel de contrôle au démarrage : la première chose que la TV doit prouver. Si le bus répond
 * « Service does not exist », le hub ne connaît pas le service : la bannière donne alors la
 * séquence exacte à exécuter depuis le poste de développement.
 */
function controleInitial() {
  journal('appel de contrôle : diagnostics');
  return appeler('diagnostics', {})
    .then(function (reponse) {
      masquerBanniere();
      afficher('diagnostics (contrôle initial)', reponse);
      var db = reponse && reponse.data && reponse.data.db;
      if (db && typeof db.sonde === 'string' && db.sonde.indexOf('echec') === 0) {
        // « DB8 répond » ne veut pas dire « DB8 sait répondre à *cette* requête » : sans index, une
        // recherche par profil ne renvoie rien, et la clé maître (donc le catalogue) semblerait perdue.
        banniere(
          'Base locale (DB8) : requêtes indexées en échec',
          'Le service joint la base, mais la sonde d’écriture/relecture échoue : <code>' + db.sonde + '</code>. ' +
            'Les profils et le catalogue ne peuvent pas être relus tant que ce point n’est pas réglé.',
          [
            'Vérifier la version installée : <code>ares-install --device tv --listfull</code> — la sonde ' +
              'n’existe qu’à partir de <code>0.1.11</code>.',
            'Si la réponse cite <code>no index for query</code> : le paquet est le bon, mais la base garde ' +
              'd’anciens kinds sans index. Réimporter la source une fois (Réglages → Importer) régularise la base.',
            'Consigner le message exact dans <code>docs/PHASE-0.md</code> §0A avant toute autre manipulation.'
          ]
        );
      }
      if (db && db.ok === false) {
        var cause = String(db.erreur || '');
        var nomService = db.service ? String(db.service) : '(aucun)';
        var conseils = [
          'Nom de service de base essayé : <code>' + nomService + '</code>. Le client essaie ' +
            '<code>com.palm.db</code> (référence LG, téléviseurs et simulateur) puis ' +
            '<code>com.webos.service.db</code> (webOS OSE).'
        ];
        if (/service does not exist/i.test(cause)) {
          conseils.push(
            'Aucun de ces noms ne répond : relever la liste des services actifs (sur TV : ' +
              '<code>ls-monitor -l</code>) et consigner les noms contenant « db » dans ' +
              '<code>docs/PHASE-0.md</code> §0A.'
          );
        }
        if (/permission denied/i.test(cause)) {
          conseils.push(
            'Refus d’ACG : l’application doit déclarer <code>database.operation</code> et ' +
              '<code>database.management</code> dans <code>requiredPermissions</code> (appinfo.json).'
          );
        }
        conseils.push(
          'Sur simulateur : la base fait partie de l’image ; si elle ne répond toujours pas, ' +
            '<em>Action → Database Reset</em> puis redémarrage du simulateur.'
        );
        conseils.push('Consigner le message exact dans <code>docs/PHASE-0.md</code> §0A.');
        banniere('Base locale (DB8) injoignable', 'Le service répond, mais la base DB8 ne l’est pas : <code>' + db.erreur + '</code>. Sans elle, les profils, les favoris et l’état des imports ne peuvent pas être enregistrés.', conseils);
      }
      return true;
    })
    .catch(function (erreur) {
      var brut = texteBrut(erreur);
      if (/service does not exist/i.test(brut)) {
        banniere(
          'Le hub LS2 ne connaît pas le service',
          'Réponse brute du bus : <code>' + brut + '</code> — le paquet installé contient le service ' +
          '(dossier <code>usr/palm/services/com.ouagkamel.app.iptvplayer.service</code>), mais la TV ne ' +
          'l’a pas enregistré. Trois gestes, dans cet ordre :',
          [
            'Vérifier la version réellement installée : <code>ares-install --device tv --listfull</code> ' +
            '(il faut <code>' + environnement().versionPage + '</code> ou plus : les versions 0.1.0 à 0.1.1 ' +
            'démarraient le service derrière <code>require.main === module</code>, et celles d’avant 0.1.2 ' +
            'chargeaient un <code>webOSTV.js</code> absent du paquet).',
            'Désinstaller puis réinstaller, puis <b>redémarrer la TV</b> : l’enregistrement des services ' +
            'est relu au démarrage — <code>ares-install -d tv -r com.ouagkamel.app.iptvplayer</code> puis ' +
            '<code>ares-install -d tv com.ouagkamel.app.iptvplayer_0.1.2_all.ipk</code>.',
            'Démarrer le service explicitement et lire son journal : ' +
            '<code>ares-inspect -d tv -s com.ouagkamel.app.iptvplayer.service -o</code> — s’il démarre, ' +
            'la console du service s’ouvre ; sinon le message d’erreur indique pourquoi.',
            '<b>Sur le simulateur webOS</b> : un <code>.ipk</code> n’y enregistre <b>jamais</b> le service. ' +
            'Ajoutez-le à la main — <i>File &gt; Add Service</i> → dossier <code>service/com.ouagkamel.app.iptvplayer.service</code> ' +
            'du pack simulateur (il doit être sous votre dossier personnel) — puis démarrez-le dans ' +
            '<i>Tools &gt; Service List</i>, et lancez l’application depuis son dossier (<i>File &gt; Launch App</i>).'
          ]
        );
      } else {
        banniere('Le service répond une erreur', 'Réponse brute : <code>' + brut + '</code>', []);
      }
      afficherErreur('diagnostics (contrôle initial)', erreur);
      return false;
    });
}

/**
 * Témoin : un service **du système**. S'il répond, le pont de l'application fonctionne et le défaut
 * est propre au service de l'application ; s'il échoue aussi, aucun appel LS2 ne sort de la page.
 */
function temoinBus() {
  journal('témoin : luna://com.webos.service.tv.systemproperty/getSystemInfo');
  return new Promise(function (resolve) {
    var api = window.webOS && window.webOS.service ? window.webOS.service : null;
    if (!api || typeof api.request !== 'function') {
      afficherErreur('témoin du bus', 'aucun pont LS2 : la page ne peut pas appeler le bus');
      resolve(false);
      return;
    }
    api.request('luna://com.webos.service.tv.systemproperty', {
      method: 'getSystemInfo',
      parameters: { keys: ['modelName', 'sdkVersion', 'firmwareVersion', 'boardType'] },
      onSuccess: function (reponse) {
        afficher('témoin du bus (réponse du système)', reponse);
        resolve(true);
      },
      onFailure: function (erreur) {
        afficherErreur('témoin du bus', erreur);
        resolve(false);
      }
    });
  });
}

/** Choix mémorisés par hôte : éviter de redemander la même autorisation à chaque essai. */
function cleHote(hote) {
  return 'iptv.httpclair.' + String(hote || '').toLowerCase();
}

function hoteDeURL(url) {
  var correspondance = /^https?:\/\/([^/:]+)/i.exec(String(url || ''));
  return correspondance ? correspondance[1].toLowerCase() : '';
}

/**
 * Consentements transmis au service :
 *  - `persistSecrets` : la case « Mémoriser ce profil sur ce téléviseur » (§8.2) ;
 *  - `insecureHttp` : l'autorisation explicite d'un portail en HTTP clair (§8.2), **nécessaire**
 *    pour que le service accepte l'hôte — sans elle, tout appel répond `security/insecureScheme`.
 */
function consentementDuFormulaire() {
  return {
    persistSecrets: el('memoriser').checked,
    insecureHttp: el('httpclair').checked
  };
}

/** Reconnaît la demande d'autorisation HTTP clair et coche la case (l'utilisateur reste libre). */
function traiterConsentement(reponse) {
  var hote = window.iptvFormat ? window.iptvFormat.hoteACOnfirmer(reponse) : null;
  if (hote === null) return false;
  if (!el('httpclair').checked) el('httpclair').checked = true;
  if (hote) {
    try { window.localStorage.setItem(cleHote(hote), '1'); } catch (_erreur) { /* stockage refusé : sans conséquence */ }
  }
  banniere(
    'Portail en HTTP clair : autorisation requise',
    'Ce portail (' + (hote ? '<b>' + hote + '</b>' : 'cet hôte') + ') est servi en <b>HTTP</b> : les identifiants et ' +
      'les flux circulent <b>sans chiffrement</b> sur le réseau. La case <i>« Portail en HTTP clair : j\'autorise »</i> ' +
      'vient d\'être cochée : relancez l\'action pour confirmer. Le service enregistre cette autorisation ' +
      '<b>une fois par hôte et par profil</b>.',
    ['Si le portail propose HTTPS, préférez-le : l\'autorisation n\'est alors plus nécessaire.'],
    { libelle: 'Relancer', action: relancerDerniereAction }
  );
  return true;
}

/** Sources préconfigurées fournies par `profils.js` (le fichier local remplace celui du dépôt). */
function sourcesPreconfigurees() {
  var paquet = window.iptvProfils;
  return paquet && paquet.sources && paquet.sources.length ? paquet.sources : [];
}

/**
 * Remplit le formulaire à partir d'une source préconfigurée : c'est ce qui permet de ne rien
 * ressaisir sur la TV ou dans le simulateur — la source choisie porte déjà l'adresse, le profil et
 * les identifiants.
 */
function appliquerSource(source) {
  var champs = format().champsDepuisSource ? format().champsDepuisSource(source) : null;
  if (!champs) return;
  if (champs.profileId) el('profil').value = champs.profileId;
  el('url').value = champs.url;
  el('utilisateur').value = champs.username;
  el('motdepasse').value = champs.password;
  if (champs.autoriserHttp) el('httpclair').checked = true;
  // Le libellé de chaque champ nomme la source utilisée : on voit d'un coup d'œil que l'adresse,
  // le profil et les identifiants appartiennent au **compte de test** et non à une saisie manuelle.
  ['profil', 'url', 'utilisateur', 'motdepasse'].forEach(function (champ) {
    var etiquette = el('etiquette-' + champ);
    if (etiquette) etiquette.textContent = champs.etiquettes[champ];
  });
  journal('source préconfigurée : ' + champs.nom);
}

/** Remplit la liste déroulante et, s'il n'y a qu'une source, la sélectionne d'emblée. */
function initialiserSources() {
  var sources = sourcesPreconfigurees();
  var liste = el('source');
  if (!liste) return;
  sources.forEach(function (source, index) {
    var option = document.createElement('option');
    option.value = String(index);
    option.textContent = source.nom || source.url || 'source ' + (index + 1);
    liste.appendChild(option);
  });
  if (sources.length) {
    el('aide-source').innerHTML = sources.length + ' source(s) préconfigurée(s) disponible(s) : ' +
      'le choix remplit l\'adresse, le profil et les identifiants.';
    liste.value = '0';
    appliquerSource(sources[0]);
  }
  liste.onchange = function () {
    if (liste.value === '') { journal('saisie manuelle'); return; }
    appliquerSource(sources[Number(liste.value)]);
  };
}

function identifiants() {
  return {
    username: el('utilisateur').value,
    password: el('motdepasse').value
  };
}

function profilDepuisFormulaire() {
  return {
    profileId: el('profil').value || 'p1',
    baseUrl: el('url').value
  };
}

document.addEventListener('DOMContentLoaded', function () {
  afficherEnvironnement(null);
  if (window.webOS && typeof window.webOS.deviceInfo === 'function') {
    window.webOS.deviceInfo(function (info) {
      info = info || {};
      afficherEnvironnement(
        'modèle ' + (info.modelName || '?') + ' · webOS ' + (info.version || info.firmwareVersion || '?') +
        ' · SDK ' + (info.sdkVersion || '?')
      );
    });
  }

  // L'hôte déjà autorisé lors d'un essai précédent est proposé coché : la confirmation reste visible.
  var hotePrecedent = hoteDeURL(el('url').value);
  try {
    if (hotePrecedent && window.localStorage.getItem(cleHote(hotePrecedent)) === '1') el('httpclair').checked = true;
  } catch (_erreur) { /* stockage refusé : sans conséquence */ }

  initialiserSources();

  el('btn-temoin').onclick = function () { temoinBus(); };
  el('btn-environnement').onclick = function () {
    afficherEnvironnement(null);
    journal('environnement actualisé');
  };

  controleInitial();

  el('btn-test').onclick = function () {
    relancerDerniereAction = function () { el('btn-test').onclick(); };
    var profil = profilDepuisFormulaire();
    var secrets = identifiants();
    journal('testProfile ' + profil.baseUrl);
    appeler('testProfile', {
      profileId: profil.profileId,
      kind: 'xtream',
      baseUrl: profil.baseUrl,
      username: secrets.username,
      password: secrets.password,
      lanAllowed: false,
      consent: consentementDuFormulaire()
    })
      .then(function (reponse) {
        afficher('testProfile', reponse);
        traiterConsentement(reponse);
      })
      .catch(function (erreur) {
        afficherErreur('testProfile', erreur);
        traiterConsentement(erreur);
      });
  };

  el('btn-import').onclick = function () {
    relancerDerniereAction = function () { el('btn-import').onclick(); };
    var profil = profilDepuisFormulaire();
    var secrets = identifiants();
    journal('importPlaylist ' + profil.profileId);
    appeler('importPlaylist', {
      profileId: profil.profileId,
      kind: 'xtream',
      contentType: el('contenu').value,
      source: { url: profil.baseUrl, credentials: secrets },
      consent: consentementDuFormulaire()
    }, {
      abonnement: true,
      aChaqueReponse: function (reponse) {
        if (reponse && reponse.data && reponse.data.jobId) derniereJobId = reponse.data.jobId;
        afficher('importPlaylist (progression)', reponse);
      }
    })
      .then(function (reponse) {
        if (reponse && reponse.data && reponse.data.jobId) derniereJobId = reponse.data.jobId;
        afficher('importPlaylist (demarrage)', reponse);
      })
      .catch(function (erreur) {
        afficherErreur('importPlaylist', erreur);
        traiterConsentement(erreur);
      });
  };

  el('btn-annuler').onclick = function () {
    if (!derniereJobId) { journal('aucun job en cours connu', 'ko'); return; }
    appeler('cancelOperation', { jobId: derniereJobId })
      .then(function (reponse) { afficher('cancelOperation', reponse); })
      .catch(function (erreur) { afficherErreur('cancelOperation', erreur); });
  };

  el('btn-job').onclick = function () {
    if (!derniereJobId) { journal('aucun job connu : lancez un import', 'ko'); return; }
    appeler('getImportJob', { jobId: derniereJobId })
      .then(function (reponse) { afficher('getImportJob', reponse); })
      .catch(function (erreur) { afficherErreur('getImportJob', erreur); });
  };

  el('btn-page').onclick = function () {
    var profil = profilDepuisFormulaire();
    appeler('getPage', { profileId: profil.profileId, contentType: el('contenu').value, order: 'source' })
      .then(function (reponse) { afficher('getPage', reponse); })
      .catch(function (erreur) { afficherErreur('getPage', erreur); });
  };

  el('btn-tranches').onclick = function () {
    var profil = profilDepuisFormulaire();
    appeler('getBuckets', { profileId: profil.profileId, contentType: el('contenu').value })
      .then(function (reponse) { afficher('getBuckets', reponse); })
      .catch(function (erreur) { afficherErreur('getBuckets', erreur); });
  };

  el('btn-recherche').onclick = function () {
    var profil = profilDepuisFormulaire();
    var requete = window.prompt('Préfixe recherché :', 'chaine');
    if (!requete) return;
    appeler('search', { profileId: profil.profileId, contentType: el('contenu').value, query: requete })
      .then(function (reponse) { afficher('search « ' + requete + ' »', reponse); })
      .catch(function (erreur) { afficherErreur('search', erreur); });
  };

  el('btn-detail').onclick = function () {
    var profil = profilDepuisFormulaire();
    appeler('getDetails', {
      profileId: profil.profileId,
      contentType: el('contenu').value,
      ref: { contentType: el('contenu').value, providerId: el('flux').value }
    })
      .then(function (reponse) { afficher('getDetails', reponse); })
      .catch(function (erreur) { afficherErreur('getDetails', erreur); });
  };

  el('btn-resoudre').onclick = function () {
    var profil = profilDepuisFormulaire();
    journal('resolveStream ' + el('flux').value);
    appeler('resolveStream', {
      profileId: profil.profileId,
      ref: { contentType: el('contenu').value, providerId: el('flux').value },
      requestedFormat: 'auto'
    })
      .then(function (reponse) {
        var url = reponse && reponse.data ? reponse.data.url : undefined;
        afficher('resolveStream' + (url ? ' (hôte : ' + hoteSeul(url) + ')' : ''), reponse);
      })
      .catch(function (erreur) { afficherErreur('resolveStream', erreur); });
  };

  el('btn-diagnostic').onclick = function () {
    appeler('diagnostics', { scope: 'local' })
      .then(function (reponse) { afficher('diagnostics', reponse); })
      .catch(function (erreur) { afficherErreur('diagnostics', erreur); });
  };

  el('btn-supprimer').onclick = function () {
    var profil = profilDepuisFormulaire();
    if (!window.confirm('Supprimer le profil ' + profil.profileId + ' et son index ?')) return;
    appeler('deleteProfile', { profileId: profil.profileId })
      .then(function (reponse) { afficher('deleteProfile', reponse); })
      .catch(function (erreur) { afficherErreur('deleteProfile', erreur); });
  };

  journal('page prête — service ' + SERVICE);
  journal('connectez la TV en mode développeur (clé + ares-install) avant les appels');
});

function hoteSeul(url) {
  var correspondance = /^https?:\/\/([^/?#]+)/i.exec(url || '');
  return correspondance ? correspondance[1].replace(/^[^@]*@/, '') : '?';
}
