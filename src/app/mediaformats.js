'use strict';

/* eslint-disable no-var -- fichier ES5 volontaire : chargé tel quel par la page de diagnostic et par
   l'interface Enact, sans transpilation */
/* global self -- `self` est la racine de navigation du navigateur et du worker (jamais `window` seul) */

/**
 * **Formats de flux réellement déclarés par le lecteur média de la plateforme** (0B).
 *
 * Pourquoi ce fichier existe : le lecteur demandait toujours `requestedFormat: 'auto'`, et le service
 * répondait — par défaut — une URL **MPEG-TS progressive** (`.ts`). Sur le téléviseur, le pipeline
 * média annonce lui-même ce qu'il sait lire (`HTMLMediaElement.canPlayType`) : l'ignorer revenait à
 * choisir le format à pile ou face, et un conteneur refusé donnait un `MediaError 4` (« format non
 * pris en charge ») alors que le flux, lui, était bien servi (302 → 200).
 *
 * Règles appliquées ici :
 *  - **HLS d'abord** quand la plateforme le déclare : direct adaptatif, segments courts, reprise
 *    propre ; c'est le format de référence de la 0B pour le direct ;
 *  - **MPEG-TS** dès qu'il est le seul déclaré, et de toute façon **essayé ensuite** : `canPlayType`
 *    est un avis, pas une garantie ;
 *  - un format n'est jamais demandé deux fois de suite sans re-résolution, et l'échec des deux est
 *    **dit** avec la liste exacte des formats essayés (§0B : consigner le cas non supporté) ;
 *  - **voie MSE en dernier recours** (`mseSupport`) : certains moteurs n'ont ni lecteur HLS intégré
 *    ni démultiplexeur MPEG-TS — c'est le cas d'un Chromium sans HLS natif, donc du simulateur — et
 *    aucun des deux conteneurs natifs n'y peut réussir. Le repli n'est proposé que là, après les
 *    deux échecs, jamais sur le chemin par défaut (§422), et son nom figure dans le message d'échec.
 *
 * Le module est utilisable tel quel dans la page (`window.iptvMedia`), dans l'interface et sous Node
 * pour les tests (`module.exports`), sans dépendance.
 */

(function (racine) {
  /** MIME officiels des deux conteneurs de la 0B. */
  var MIME = {
    hls: 'application/vnd.apple.mpegurl',
    ts: 'video/mp2t'
  };

  /** Variantes de `canPlayType` pour HLS : les deux libellés circulent. */
  var MIME_HLS_ALT = 'application/x-mpegURL';

  /**
   * Ce qu'une voie **MSE** saurait lire : le H.264/AAC du direct Xtream, en MP4 fragmenté. C'est la
   * seule chose que le repli `hls.js` demande à la plateforme — un flux HEVC ou AC-3 ne l'obtiendra
   * pas ici, et c'est voulu : on ne promet que ce qui est mesuré.
   */
  var MIME_MSE = 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';

  /**
   * Ce que la plateforme **déclare** savoir lire : `''` (non), `'maybe'`, `'probably'`.
   * `canPlayType` absent (banc jsdom, navigateur minimal) n'est pas une erreur : on renvoie des
   * chaînes vides, et l'ordre par défaut s'applique.
   */
  function support(canPlayType) {
    var jouer = typeof canPlayType === 'function' ? canPlayType : null;
    if (!jouer) return { hls: '', ts: '' };
    var hls = '';
    var ts = '';
    try {
      hls = jouer(MIME.hls) || jouer(MIME_HLS_ALT) || '';
      ts = jouer(MIME.ts) || '';
    } catch (_erreur) {
      // un canPlayType capricieux ne doit pas empêcher la lecture : on repart de l'ordre par défaut
      return { hls: '', ts: '' };
    }
    return { hls: String(hls), ts: String(ts) };
  }

  /**
   * Formats à essayer, **dans l'ordre**. HLS est demandé en premier sauf si la plateforme ne déclare
   * que le MPEG-TS ; dans tous les cas l'autre format suit, en dernier recours borné.
   */
  function candidats(canPlayType) {
    var declare = support(canPlayType);
    if (declare.ts && !declare.hls) return ['ts', 'hls'];
    return ['hls', 'ts'];
  }

  /** L'autre format d'une paire, ou `''` si l'entrée n'est pas un format connu. */
  function autre(format) {
    if (format === 'hls') return 'ts';
    if (format === 'ts') return 'hls';
    return '';
  }

  /** MIME d'un format, à titre indicatif (repli de `StreamResolution.preferredMime`). */
  function mimeDe(format) {
    return MIME[format] || '';
  }

  /**
   * La plateforme expose-t-elle une voie **MSE** pour le H.264/AAC (repli `hls.js`) ?
   *
   * `window.MediaSource` suffit à l'annoncer : un moteur qui l'expose sait lire un flux segmenté
   * poussé par `SourceBuffer`. `isTypeSupported` est interrogé quand il existe — une plateforme qui
   * répond non pour le H.264/AAC ne doit pas recevoir un repli voué à l'échec (le message final
   * nomme alors seulement les formats natifs, et dit pourquoi MSE a été écarté).
   */
  function mseSupport(mediateur) {
    var source = mediateur && mediateur.MediaSource;
    if (!source) return false;
    if (typeof source.isTypeSupported !== 'function') return true;
    try {
      return !!source.isTypeSupported(MIME_MSE);
    } catch (_erreur) {
      return false;
    }
  }

  /**
   * L'URL est-elle une **playlist HLS** ? Le repli `hls.js` lit une playlist, jamais un flux
   * MPEG-TS brut : le dire ici évite de lancer une tentative perdue d'avance. L'extension est
   * cherchée avant les paramètres et le fragment (`?…`, `#…`), en minuscules.
   */
  function estHls(url) {
    var texte = String(url || '').split('#')[0].split('?')[0].toLowerCase();
    return texte.slice(-5) === '.m3u8';
  }

  /** Nom porté au message d'échec pour la voie MSE (le repli se nomme comme il se lit). */
  var LIBELLE_MSE = 'mse';

  /**
   * Nature d'une `MediaError` : `@param code` est `HTMLMediaElement.error.code`
   * (1 ABORTED, 2 NETWORK, 3 DECODE, 4 SRC_NOT_SUPPORTED).
   */
  function nature(code) {
    if (code === 4) return 'format non pris en charge par ce lecteur';
    if (code === 3) return 'flux illisible (decodage)';
    if (code === 2) return 'flux interrompu ou expire';
    if (code === 1) return 'lecture interrompue';
    // Aucun code du tout : ce n'est pas une MediaError du `<video>` mais la fin de toutes les voies
    // (repli compris). Le dire ainsi évite un « MediaError 0 » qui ne veut rien dire pour personne.
    if (!code) return 'aucune voie de lecture n’a abouti';
    return 'lecture impossible';
  }

  /**
   * Message d'échec de lecture : la nature de l'erreur **et** les formats réellement essayés. Sans
   * cette liste, un échec de format ne se distingue pas d'une URL expirée (§0B : consigner le cas).
   */
  function messageErreurMedia(code, formatsEssayes) {
    var liste = (formatsEssayes && formatsEssayes.length ? formatsEssayes : []).join(', ');
    var tete = code ? 'lecture impossible (MediaError ' + code + ') — ' + nature(code) : 'lecture impossible — ' + nature(0);
    return tete + (liste ? ' ; formats essayés : ' + liste : '');
  }

  /**
   * Résumé des formats déclarés, pour la page de diagnostic (preuve à consigner en 0B).
   *
   * `@param mediateur` (`window` en pratique) n'est lu que pour la voie MSE : son absence ne change
   * rien d'autre, ce qui permet d'appeler `resume(canPlayType)` comme avant.
   */
  function resume(canPlayType, mediateur) {
    var declare = support(canPlayType);
    function libelle(valeur) {
      if (!valeur) return 'non';
      return valeur;
    }
    var texte =
      'HLS (' + MIME.hls + ') : ' + libelle(declare.hls) +
      ' ; MPEG-TS (' + MIME.ts + ') : ' + libelle(declare.ts) +
      ' ; MSE (repli hls.js) : ' + (mseSupport(mediateur) ? 'oui' : 'non');
    return texte;
  }

  var api = {
    MIME: MIME,
    MIME_MSE: MIME_MSE,
    LIBELLE_MSE: LIBELLE_MSE,
    support: support,
    candidats: candidats,
    autre: autre,
    mimeDe: mimeDe,
    mseSupport: mseSupport,
    estHls: estHls,
    nature: nature,
    messageErreurMedia: messageErreurMedia,
    resume: resume
  };

  racine.iptvMedia = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : this);
