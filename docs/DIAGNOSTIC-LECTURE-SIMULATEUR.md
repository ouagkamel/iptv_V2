# Diagnostic — « lecture impossible (MediaError 4) » : la chaîne, le portail et l'application sont hors de cause

**Date** : 2026-10-11 · **Entrée de journal** : D-45 · **Version testée** : 0.1.15 (canal 159335)

## 1. Ce qui est prouvé, hors TV, sur le portail

Sonde `tmp/probe-flux.js`, `tmp/sonde-entetes.js`, `tmp/sonde-ua.js`, `tmp/sonde-edge.js` (identifiants et jetons jamais journalisés) :

| Objet | Résultat |
| --- | --- |
| Playlist `…/live/<id>.m3u8` | HTTP 302 → hôte d'edge, puis **200 `application/x-mpegURL`**, 525 o, version 3, 6 segments de 10 s, **sans clé**, chemins absolus `/hls/<jeton>/<id>_<n>.ts` |
| Segment HLS complet | 3 911 904 o, `video/mp2t`, **200 sans redirection** depuis l'hôte d'edge |
| Conteneur / codec (ffprobe) | **MPEG-TS**, vidéo **H.264 High @ L3.1 — 1280×720 — 25 i/s — yuv420p**, audio **AAC HE-AAC 48 kHz stéréo**, débit ≈ 3,1 Mb/s, **aucune erreur de décodage** |
| PMT du flux (sonde corrigée) | **H.264 (type 0x1b) + AAC-ADTS (type 0x0f)** — conforme |
| Agent utilisateur | **Réponse identique** pour le service, un UA webOS 6, un UA webOS 4, VLC et Chrome : playlist 525 o / 6 segments, flux H.264+AAC |
| `Range` | Ignoré (200 complet) sur un jeton frais ; un 555 transitoire a été vu sur un jeton épuisé — non reproductible |
| En-têtes du flux direct | `video/mp2t`, `connection: close`, **sans `Content-Length`** (direct) |

**Conclusion 1 — le portail, le conteneur, le codec et le transport ne sont pas la cause.** Le portail sert exactement le même flux sain à la TV qu'à la sonde.

## 2. Ce que fait un moteur Chromium (banc local, Chromium 156, `tmp/bench-lecteur.js`)

| Essai | Résultat |
| --- | --- |
| `canPlayType('application/vnd.apple.mpegurl')` | `"maybe"` |
| `canPlayType('video/mp2t')` | `""` (**vide**) |
| `MediaSource` / `avc1+mp4a` | disponible / supporté |
| `<video>` natif sur `.m3u8` | **lecture** (image 1280×720, segments `…_467.ts`, `470`, `471` demandés et servis en 200) |
| `<video>` natif sur `.ts` | **MediaError 4** — exactement la capture utilisateur |
| hls.js sous MSE sur `.m3u8` | **lecture** (30 s de flux, fragments `…_475.ts`, `476`…, **0 erreur**) |

## 3. Pourquoi le simulateur refuse les deux formats

- LG documente : « **the video and audio specifications are different from actual TV devices** » pour le simulateur, et webOS TV 26 = **Chromium 132**.
- Chromium n'a de **lecteur HLS intégré** que depuis la version **124** (actif par défaut), et **aucun démultiplexeur MPEG-TS**.
- Dans le journal réseau de l'utilisateur, pendant les deux essais HLS : **la playlist est demandée (302 → 200, 777 o) puis rien — aucun segment n'est jamais demandé**. Un moteur qui saurait lire le HLS demanderait les segments. Un moteur qui ne le sait pas lit la playlist, la rejette, et rend MediaError 4.
- Pour le `.ts` : le moteur télécharge 1,1 Mo (560 Kio observés) **puis** rend MediaError 4 — comportement d'un moteur qui ne sait pas démultiplexer le MPEG-TS.

**Conclusion 2 — dans le simulateur, aucune des deux voies natives ne peut réussir, quelle que soit l'application** : ce n'est ni un défaut de l'app, ni du portail, ni du flux. La 0A (« go/no-go TV réelle ») reste, comme prévu par la spécification, la seule mesure valable pour le média.

## 4. Où lire la preuve dans l'application

**Réglages → bouton « Page de diagnostic (0A) »** → section environnement → ligne **« formats de flux déclarés »** (réponse de `canPlayType` pour HLS et TS sur l'appareil de test), plus l'ordre d'essai appliqué par le lecteur.

## 5. Options

| # | Option | Effet | Coût |
| --- | --- | --- | --- |
| A | **0A sur TV réelle** (0.1.15 inchangée) | Aligné sur la spécification : la TV (Chromium 132 + chaîne média native) lit HLS/TS nativement | Aucun code ; suppose une TV LG disponible |
| B | **Repli MSE (hls.js) après échec des voies natives** | Fait lire la chaîne **dans le simulateur** (prouvé au §2) et partout où le natif manque ; la `<video>` reste unique, alimentée par MSE | `hls.js` vendu au paquet (619 692 o, ≈ 180 Ko compressé, **Apache 2.0**, aucune requête réseau supplémentaire) ; marche bornée après hls et ts dans `surErreurMedia` |
| C | **A + B** | Développement testable sans TV, mesure 0A conservée | A + B |

Dans tous les cas, l'ordre d'essai reste : **HLS natif → TS natif → (option B) MSE**, jamais de boucle,
et le message d'échec continue de nommer ce qui a été essayé.

**Décision prise (2026-10-11)** : les options **A et B** — le repli MSE est livré en 0.1.16
(`docs/RELEASE-0.1.16.md`, JOURNAL D-45), et la 0A sur TV réelle est planifiée. Le repli n'est
engagé que si la plateforme expose MSE pour le H.264/AAC et que les deux conteneurs natifs ont
échoué ; sur la TV, le chemin natif reste celui qui lit. Preuve de lecture avec le fichier du
paquet : injection du script en 28 ms, hls.js 1.7.3, direct 159335 en 1280×720, 0 erreur.

Le même fichier est vérifiable **sur l'appareil** : *Réglages → Page de diagnostic (0A)* →
bouton **« Tester le repli MSE »** (fichier présent dans le paquet, `Hls.isSupported()`), et la ligne
« formats de flux déclarés » indique désormais aussi le support MSE.
