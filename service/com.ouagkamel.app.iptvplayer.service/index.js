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

var main = require('./lib/service/main');

if (typeof main.bootstrap !== 'function') {
  console.error('[iptv] lib/service/main.js incomplet : executer `npm run build:service`');
} else {
  main.bootstrap();
}
