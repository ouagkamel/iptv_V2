'use strict';

/**
 * Point d'entrée du service (`main` de `package.json`) — **volontairement en JavaScript brut** :
 * c'est le fichier que la plateforme charge, il doit rester lisible et sans dépendance.
 *
 * Le démarrage se fait **au chargement du module**, jamais derrière un test
 * `require.main === module` : webOS peut charger ce fichier par `require()` depuis son propre
 * chargeur, auquel cas `require.main` ne désigne pas ce module — le service ne s'enregistrerait
 * alors jamais auprès du hub LS2, qui répondrait « Service does not exist » à tout appel.
 *
 * Le service s'enregistre sous le nom `com.ouagkamel.app.iptvplayer.service`, exactement celui
 * déclaré dans `services.json` et utilisé par l'application.
 */

// Premiere ligne executee : elle doit apparaitre dans `ares-log -d tv -u <service>`. Si elle
// n'apparait pas, le processus n'a jamais demarre (enregistrement du service cote plateforme) ;
// si elle apparait et que rien ne suit, le chargement ci-dessous a echoue et la cause est affichee.
console.log('[iptv] demarrage du service com.ouagkamel.app.iptvplayer.service (node ' + process.version + ')');

var main;
try {
  main = require('./lib/service/main');
} catch (erreur) {
  console.error('[iptv] chargement du service impossible : ' + (erreur && erreur.message));
  throw erreur;
}

if (typeof main.bootstrap !== 'function') {
  console.error('[iptv] lib/service/main.js incomplet : executer `npm run build:service`');
} else {
  var instance = main.bootstrap();
  console.log(
    instance
      ? '[iptv] service enregistre aupres du hub LS2 : 11 commandes'
      : '[iptv] service NON enregistre : voir les lignes precedentes'
  );
}
