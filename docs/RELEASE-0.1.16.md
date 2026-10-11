# 0.1.16 — « MediaError 4 » : le portail, le codec et l'application étaient hors de cause ; la voie de secours MSE (D-45)

**Date** : 2026-10-11 · **Base** : 0.1.15 · **Canal de mesure** : portail Xtream de test, direct 159335

## Ce que la version précédente laissait croire

En 0.1.15, les deux conteneurs étaient essayés puis refusés : « lecture impossible (MediaError 4) —
format non pris en charge par ce lecteur ; formats essayés : hls, ts », alors que le journal réseau
montrait `159335.m3u8` **et** `159335.ts` servis en 302 → 200. Le diagnostic « ordre des formats »
était donc clos, mais la lecture ne fonctionnait toujours pas.

## Ce que les mesures ont établi

| Objet mesuré | Résultat | Où |
| --- | --- | --- |
| Codec du flux | **H.264 High @ L3.1, 1280×720, 25 i/s, yuv420p + AAC HE-AAC 48 kHz**, MPEG-TS ≈ 3,1 Mb/s, **0 erreur de décodage** | ffprobe sur segment complet (3 911 904 o) |
| PMT du flux | H.264 (type 0x1b) + AAC-ADTS (type 0x0f), PMT pid 4096 | sonde MPEG-TS corrigée (`pointer_field`) |
| Playlist HLS | 200 `application/x-mpegURL`, 525 o, 6 segments de 10 s, sans clé, chemins absolus | sonde HTTP |
| Agent utilisateur | **réponse identique** pour le service, un UA webOS 6, un UA webOS 4, VLC, Chrome | sonde 5 UA |
| Segment HLS depuis l'hôte final | 200 `video/mp2t`, aucune redirection, 3,9 Mo | sonde HTTP |
| Moteur Chromium de bureau (banc) | HLS natif : lecture ; `.ts` natif : **MediaError 4** ; hls.js/MSE : **lecture** | Chromium 156, `bench-lecteur.js`, `bench-mse.js` |

**Conclusion** : le portail sert un flux sain et conforme à tout le monde ; ce qui refuse, c'est le
moteur média de l'appareil de test — un **Chromium sans lecteur HLS intégré** (Chromium n'a de
lecteur HLS intégré que depuis la version 124 et n'a jamais eu de démultiplexeur MPEG-TS) et sans
démultiplexeur MPEG-TS. C'est le cas du **simulateur** (webOS TV 26 = Chromium 132, et LG documente
que « les spécifications vidéo/audio du simulateur diffèrent des vraies TV »). Détail du dossier :
`docs/DIAGNOSTIC-LECTURE-SIMULATEUR.md`.

## Ce que fait 0.1.16

Le lecteur garde **exactement** son ordre d'essai natif — HLS natif, puis MPEG-TS natif — et ajoute
une **quatrième marche bornée** : si les deux échouent *et* que la plateforme expose MSE pour le
H.264/AAC, `hls.js` est chargé **à la demande** et alimente le **même** `<video>` par MSE.

| Réf. | Décision | Motif |
| --- | --- | --- |
| **D-45a** | `hls.min.js` **vendu dans le paquet**, jamais importé par le bundle : injecté par `<script src="vendor/hls.min.js">` au moment de l'échec | La spécification (§422) interdit HLS.js sur le **chemin par défaut** ; un `import` statique l'aurait chargé à chaque démarrage, même sur une TV qui n'en a pas besoin. Sur TV, le fichier reste sur le disque, jamais exécuté |
| **D-45b** | La voie MSE n'est proposée que si `MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')` est vrai | On ne propose pas un repli voué à l'échec : un moteur sans H.264/AAC en MP4 fragmenté ne l'obtiendra pas |
| **D-45c** | Le repli n'est engagé qu'après **les deux** conteneurs natifs, **une** fois, jamais en boucle | Même règle que D-44c ; le message d'échec nomme désormais `hls, ts, mse` |
| **D-45d** | `hls.js` ne lit qu'une **playlist** : le repli exige une URL `.m3u8` (`estHls`) | Un flux MPEG-TS brut n'est pas une playlist ; mieux vaut dire pourquoi le repli est impossible que le tenter à vide |
| **D-45e** | L'instance `hls.js` est détruite au zapping, à la sortie, au réessai | §4.6 : aucun décodeur ne survit au changement de chaîne ; le `<video>` reste **unique** |
| **D-45f** | Diagnostic : ligne MSE (support déclaré) + bouton **« Tester le repli MSE »** (fichier présent dans le paquet, `Hls.isSupported()`) | La 0A doit pouvoir dire, sur l'appareil, si le repli est disponible — sans lancer de flux |
| **D-45g** | L'échec du repli affiche la cause `hls.js` (type/détails) sous le message normalisé | Un échec réseau, manifeste ou média ne se diagnostiquent pas de la même façon |

**Écart assumé et traçable** : la spécification (§422) range « toute bibliothèque MSE » dans les
évolutions *après mesure/prototype ciblé*. La mesure est faite (bancs ci-dessus) et le besoin est
identifié (l'appareil de test de la 0A est le simulateur) ; le repli est donc livré **hors du chemin
par défaut**, borné, et **désactivable en un point** : sans `MediaSource` sur l'appareil, il n'est
jamais engagé. Licence Apache 2.0 respectée : notice de l'auteur + texte complet embarqués
(`src/app/vendor/hls.js.LICENSE.txt`).

## Fichiers

- `src/app/vendor/hls.min.js` (619 692 o, hls.js **1.7.3**, Apache 2.0), `hls.js.LICENSE.txt`, `LISEZ-MOI.txt`
- `ui/src/services/hls.js` — chargeur à la demande (injection unique, échecs nommés)
- `ui/src/views/Lecteur.js` — quatrième marche MSE, `<video>` unique, instance détruite au changement
- `src/app/mediaformats.js` — `mseSupport`, `estHls`, `LIBELLE_MSE`, `MIME_MSE`, résumé enrichi, message sans code (`aucune voie de lecture n'a abouti`)
- `src/app/diagnostic.js` / `diagnostic.html` — ligne MSE + bouton « Tester le repli MSE »
- `tests/hls.test.js` (nouveau, 6 cas), `tests/mediaformats.test.js` (+4 cas), `tests/package.test.js` (+2 assertions de paquet)

## Contrôles

- `npm run verify` (lint Node 8.12, `check:deps`, typecheck, tests) : **254 tests, 0 échec** — dont
  l'exécution sous **Node 8.12** réelle : 254/254.
- `npx enact pack` : compilation **sans avertissement** (bundle 968 676 o).
- Paquet : `hls.min.js` présent **une fois** dans l'`.ipk`, octet pour octet identique au dépôt, avec
  sa licence (contrôlé dans les tests).
- Preuve de lecture avec **le fichier du paquet** : injection du script en 28 ms, hls.js 1.7.3,
  lecture du direct 159335 (1280×720, 0 erreur, segments servis par l'hôte d'edge).
- Zéro identifiant du compte de test dans l'ipk et dans les deux archives.

## Ce qui reste (0A, TV réelle)

À exécuter sur la TV LG webOS 6+ : lecture d'une chaîne (attendu : **voie native**, HLS), zapping,
sortie/reprise, puis la page de diagnostic (formats déclarés + « Tester le repli MSE »). Le repli
n'a pas vocation à s'activer sur la TV : il doit rester la sécurité du simulateur et des appareils
dont le moteur média ne sait pas lire le direct.
