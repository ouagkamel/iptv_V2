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
import installerLangueSansDonnees from './services/sansLocales';
import ThemeDecorator from '@enact/sandstone/ThemeDecorator';
import App from './App/App';

// avant tout rendu : aucune donnee de langue ne sera demandee (voir services/sansLocales.js)
installerLangueSansDonnees();

// Le theme Sandstone est applique **ici** : c'est lui qui pose la police, la couleur du texte et le
// fond de l'application, monte le Spotlight (navigation a la telecommande), la FloatingLayer (popups)
// et la resolution independence. Sans lui, l'arbre se rend mais le texte reste noir sur fond noir.
const Application = ThemeDecorator(App);

ReactDOM.render(<Application />, document.getElementById('root'), function () {
  console.log('[iptv-ui] application prete (pont LS2 : ' + (window.webOS && window.webOS.__pont ? window.webOS.__pont.chemin : 'inconnu') + ')');
});
