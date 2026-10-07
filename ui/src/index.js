'use strict';

/**
 * Point d'entrée de l'application V1-A.
 *
 * Le pont LS2 (`webos-bridge.js`) est importé **en premier** : il installe `webOS.service.request`
 * sur `window` avant que les écrans ne l'utilisent, et il n'écrase rien si la plateforme le fournit
 * déjà. Aucun fichier externe n'est chargé (pas de `webOSTV.js`, absent des paquets LG — D-17).
 */

import React from 'react';
import ReactDOM from 'react-dom';

import '../../src/app/webos-bridge.js';
import App from './App/App';

ReactDOM.render(<App />, document.getElementById('root'), function () {
  console.log('[iptv-ui] application prete (pont LS2 : ' + (window.webOS && window.webOS.__pont ? window.webOS.__pont.chemin : 'inconnu') + ')');
});
