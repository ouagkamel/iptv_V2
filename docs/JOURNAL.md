# Journal d'exécution

## 2026-09-28 — Correctifs après premier essai TV + validation sur portail réel (0.1.1)

**Ce qui a été observé sur la TV** : la page de diagnostic appelait le service et recevait
`{"returnValue":false,"errorCode":-1,"errorText":"Service does not exist:
com.ouagkamel.app.iptvplayer.service."}`. Le paquet installé (`0.1.0`) contenait bien le service, son
manifeste et ses onze commandes : le défaut était dans le **démarrage**, pas dans l'empaquetage.

**Défauts corrigés** (chacun avec son test de non-régression) :

| Réf. | Défaut | Cause réelle | Correctif |
|---|---|---|---|
| **D-09** | « Service does not exist » sur la TV | Le service démarrait derrière `if (require.main === module)` : lancé par la plateforme comme module `require()`, le garde était faux et le service ne s'enregistrait jamais auprès du hub LS2 (FAQ LG, Q7 : le hub ne connaît que les services qui se sont enregistrés) | `bootstrap(options?)` exporté et **démarrage au chargement** ; le `main` du paquet est un `index.js` en JavaScript brut qui appelle `bootstrap()` sans dépendance ; deux tests rejouent les **deux** modes de chargement (`node index.js` et `require()`) |
| **D-10** | `testProfile` en échec sur le portail réel | Le portail exige un en-tête `User-Agent` : sans lui, réponse HTTP **461** (« CDN PROXY SERVICE »), avec n'importe quelle valeur, réponse normale | `DEFAULT_USER_AGENT` (`IPTVPlayer/0.1.1 (webOS TV; …)`) appliqué par défaut, surchargeable par requête et **par profil** (persisté en DB8) |
| **D-11** | Réponse vide alors que le corps est annoncé | Le flux décompressé (gzip) était résolu avant la fin de `zlib` : `response.end` arrive avant la dernière écriture du décompresseur | `finalize()` attend `decompressor.on('end')` |
| **D-12** | `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined` | Le `lookup` épinglé renvoyait une chaîne ; Node ≥ 18 interroge `lookup` avec `{all:true}` et attend un **tableau** | forme renvoyée selon `options.all` (chaîne sur Node 8), type `PinnedLookup`, message d'erreur enrichi du code brut |
| **D-13** | Import/essai refusé sur un portail HTTP clair | Aucun moyen de consentir au « HTTP clair » pour un hôte donné hors saisie d'identifiants | `acceptInsecureHost(hôte, profil?)` + `sessionAcceptedHosts` : le consentement est par hôte, mémorisé pour la session, y compris sans profil |
| **D-14** | Résolution d'une référence **linéaire** (mesure : 61 616 lectures de blocs pour un seul détail) | `findOrdinalByProviderId` balayait les secteurs `records.bin` à la recherche de l'empreinte | nouveau fichier d'index `iptv/index/v1/refs:hash16+ordinal4` (20 octets par entrée, trié à la fin de l'import) et **recherche binaire** ; repli compatible pour un index publié sans ce fichier ; 6 tests (dont comptage des lectures) |
| **D-15** | Page **réelle** refusée par le contrôle de sûreté (« reponse refusee par le controle de surete ») | Une URL de logo légitime (`https://images.pluto.tv/channels/64bab8ba5dc1660008969b5a/colorLogoPNG.png`) contient une suite de plus de 40 caractères de classe base64 : la règle « segment base64 long » croyait à un secret | la règle s'applique désormais **hors URL** (les URL de catalogue sont des données ; les secrets portés par une URL restent couverts par `userinfo`, `identifiant en requete` et `URL de flux`) ; 2 tests, dont un rejouant le logo réel |

**Validation sur le portail réel** (hors TV, service embarqué piloté par ses onze commandes LS2, via
le nouveau `npm run verify:portal`) :

| Étape | Résultat |
|---|---|
| `testProfile` | `ok` en 0,6 s — compte `Active`, expiration au 30/09/2026, `max_connections: 1`, formats `["m3u8","ts"]` |
| `importPlaylist` (live) | `done` — **5 299 chaînes** en 1,1 s (10 messages d'abonnement, phases `downloading → parsing → writing → validating → swapping → done`) |
| index publié | `records` 664 blocs / `payload` 68 / `title` 6 / `buckets` 1 / `groups` 3 / **`refs` 26** ; 5 299 entrées, état `valid` |
| `getPage` / `getBuckets` / `search` | 200 objets en 9 ms (plafond §15.2 respecté), 27 tranches alphabétiques, recherche bornée sans parcours linéaire |
| résolution de référence | **500 / 500** identifiants résolus et cohérents en 118 ms (0,24 ms par référence, détail inclus) — contre un balayage complet auparavant |
| `getDetails` | 400 octets, `streamRef` opaque (`v1:0:7e8d475e`), `streamMode: derived`, **aucun motif interdit** (contrôle du service lui-même) |
| `resolveStream` | 1 ms — `derived`, `video/mp2t` |
| lecture réelle du flux | 302 → CDN, puis **HTTP 200 `video/mp2t`**, 1 053 059 octets lus, synchronisation `0x47` tous les 188 octets |
| `diagnostics` | runtime, racines embarquées (121 certificats), index publiés, capacités — sans secret |

**À retenir pour la suite** : le portail répond **407** (chaîne absente de l'abonnement) ou **405**
(identifiant invalide) au niveau du CDN, après redirection — c'est un refus **par chaîne**, pas une
erreur du lecteur ; V1-A doit le présenter comme « chaîne non disponible dans l'abonnement ». Le flux
est servi par un hôte CDN distinct (adresse IP) après redirection : le pipeline média du téléviseur
suit cette redirection, l'application ne doit ni épingler ni réécrire l'URL résolue.

**Livraison** : version **0.1.1**, `npm run dist` → `dist/0.1.1/` + `dist/0.1.1.zip`, publication
`v0.1.1-phase0a` (l'`.ipk` et l'archive), `npm test` → **149 tests, 0 échec**.

## 2026-09-28 — Paquet de diagnostic (phase 0A)

**Périmètre livré** : l'interface Enact n'existe pas encore (étape 3), mais le socle peut déjà être
éprouvé sur un téléviseur. Le dépôt fournit donc :

- `src/app/` — page web minimale, sans dépendance, télécommandable : appareil (`webOS.deviceInfo`),
  test de source, import avec progression par abonnement, page/tranches/recherche/détail,
  résolution de flux (URL masquée par défaut), diagnostic, suppression de profil. Deux ponts LS2
  acceptés (`webOS.service.request` ou `PalmServiceBridge`) ; les identifiants ne quittent pas la TV
  et ne sont jamais journalisés ;
- `src/app/assets/` — icônes 80/130 et fond d'écran, produits par script (aucune ressource
  distante : le paquet doit fonctionner hors ligne) ;
- `tools/make-package.js` — prépare l'arborescence (application + service compilé), appelle
  `ares-package` (outillage LG, seul juge du format `.ipk`), puis copie le résultat dans `release/`
  avec une version dépaquetée pour inspection ;
- scripts `npm run pack:webos` / `pack:app` ; `release/` est ignoré par git.

**Vérification** : `ares-package` réussit ; le `.ipk` (221 474 octets) contient
`usr/palm/applications/com.ouagkamel.app.iptvplayer/` (page + visuels) et
`usr/palm/services/com.ouagkamel.app.iptvplayer.service/` (`services.json`, `package.json`, `lib/`
compilé, `assets/roots.pem`) ; les trois membres `debian-binary`, `control.tar.gz`, `data.tar.gz`
sont présents. Ce qui reste à faire **sur la TV** est listé dans `docs/PHASE-0.md` §0A (séquence en
huit étapes avec la preuve attendue à chacune).

**Livraison** : `npm run dist` assemble `dist/<version>/` (l'`.ipk`, le contenu dépaqueté
`app/` + `service/`, `SHA256SUMS.txt`, `LISEZ-MOI.txt`) et l'archive `dist/<version>.zip`.

**Publication GitHub** : release `v0.1.0-phase0a` (pré-version) avec trois pièces jointes —
`com.ouagkamel.app.iptvplayer_0.1.0_all.ipk` (221 474 o, sha256 `290fa4bc…`), `0.1.0.zip`
(470 864 o) et `SHA256SUMS.txt` — téléchargées ensuite depuis l'URL publique et comparées octet à
octet à la construction locale.

**Ce que ce paquet ne prouve pas** : le lecteur `<video>` (0B), les écrans Enact, le D-pad complet
sur quatre écrans (ils n'existent pas encore) — la page de diagnostic remplace seulement le socle
applicatif et le service.

## 2026-09-28 — Étape 2 : service (réseau, DB8, Xtream, import reprenable, LS2)

**Périmètre livré** :

- **client HTTP du service (§2.5)** : redirections bornées à 5 avec schéma/hôte/port revalidés à
  chaque saut, en-têtes sensibles retirés au changement d'origine, DNS résolu puis **épinglé**
  (adresses privées, loopback, link-local, CGNAT refusées), bundle de racines publiques embarqué
  (`assets/roots.pem`, 121 certificats, option `ca` seule — `rejectUnauthorized` jamais désactivé),
  décompression gzip/deflate locale, plafonds octets + plafond fil, pause/reprise du flux ;
- **parseur JSON incrémental** : analyse au fil de l'eau du tableau racine (mémoire bornée), JSON
  tronqué refusé (`provider/badResponse`), racine tableau livrée élément par élément ;
- **DB8 (§2.4, §15.1)** : `Db8Client` + kinds **versionnés** par ID d'application, dépôts profils,
  clé maître (32 o, base64, kind dédié), `ImportJob`, consentements, favoris et reprises ;
  `deleteProfile` efface le profil, ses données et **détruit la clé maître** ; `redactProfile`
  n'expose jamais identifiant ni adresse porteuse de secret ; `FakeDb8Bus` permet les tests sans TV ;
- **adaptateur Xtream (§5.1)** : validation runtime de chaque champ (`user_info`, catégories, flux,
  séries), appel « tous les flux » par défaut avec **repli par catégorie** documenté, URLs de
  lecture construites pour live/VOD/épisode, `direct_source` classé selon la présence
  d'identifiants, aucune URL dans les journaux (forme « hôte + chemin masqué ») ;
- **import reprenable (§2.4, §15.5)** : job persistant (`downloading → parsing → writing →
  validating → swapping → done`), points de reprise sérialisés, `entriesRead` = entrées **indexées**,
  validation stricte `entryCount === entries − skipped` avant bascule, échec = staging conservé
  scellé et index en place, annulation coopérative ;
- **couche LS2 (§2.6, §15.4)** : les onze commandes du manifeste, enveloppe unique
  `{ returnValue, indexVersion?, data?, error? }`, plafonds (≤ 200 objets, ≤ 256 Kio, détail ≤ 32 Kio,
  `resolveStream` ≤ 8 Kio), contrôle anti-fuite avant envoi, une seule souscription et une seule
  opération lourde par profil (`catalog/busy`), diagnostic local sans secret.

**Vérification** : `npm test` → **137 tests, 0 échec** (dont 16 nouveaux sur la couche LS2 :
commandes du manifeste, refus d'identifiants sans second essai, phases persistées, `catalog/busy`,
annulation, pagination sans URL, `streamRef` opaque, `resolveStream` seule voie vers une URL,
`deleteProfile`, diagnostic) ; `npm run lint:node812` → OK (source **et** artefact) ;
`npm run check:deps` → OK.

### Décisions et écarts (suite)

| Réf. | Décision | Motif | Statut |
|---|---|---|---|
| **D-06** | Un import interrompu **redémarre à sa source** avec un staging neuf ; le staging conservé est scellé et inspectable (`CatalogIndexWriter.inspectStaging`) mais on n'y **ajoute** pas d'enregistrements | Ajouter après un bloc scellé obligerait à réutiliser le couple (clé, nonce) du dernier bloc ou à aligner chaque enregistrement de 512 o sur des blocs de 4096 — les deux sont exclus par le format du §15.3 et par le NIST SP 800-38D. La reprise reste exacte parce que la source est relue (les N premières entrées déjà indexées sont ignorées de façon déterministe) | testé (échec → staging conservé → reprise → index identique à un import complet, empreintes comparées) — à confirmer par l'auteur de la spec |
| **D-07** | `importPlaylist` importe **un** type de contenu par appel (`contentType`, défaut `live`) | `done` est terminal dans la machine d'état du §15.5 : un même job ne peut pas recommencer un cycle `downloading → …` sans sortir du contrat. L'application enchaîne les types au rythme des incréments (live en V1-A, vod en V1-B, séries en V1-C) | testé (job live et job vod indépendants, versions d'index séparées) |
| **D-08** | `testProfile` renvoie un **verdict** (`{ ok, errors[] }`) même quand les identifiants sont refusés | C'est la forme imposée par la table du §15.4 ; un échec d'appel LS2 y ajouterait une couche d'erreur redondante. Le mot de passe n'est jamais renvoyé ni journalisé | testé |

### Points restés ouverts (conformément au §15.6)

- seuils mémoire exacts du service (RSS, taille de lot de parsing) : après mesures 0D ;
- `searchIndexKind` par défaut : `title` retenu provisoirement ; `title+tokens` dépend du budget disque ;
- seuil de longueur du « segment porteur d'identifiant » : valeur par défaut **24 caractères**,
  exposée dans `urltools.DEFAULT_CREDENTIAL_SEGMENT_MIN_LENGTH` et couverte par un test
  d'acceptation (les URL de CDN publiques ne doivent pas être classées secrètes).

### Prochaine étape (étape 3)

1. Interface Enact 3.4.9 / Sandstone 1.4.6 + Spotlight : accueil, profils, Live TV (catégories,
   chaînes), lecteur natif `<video>` alimenté par `resolveStream()`, réglages et diagnostic ;
2. machine d'état du lecteur câblée sur le média réel (coalescence 400 ms, message unique après
   10–15 s, re-résolution unique) ;
3. `README` de développement de l'interface et budgets de démarrage (Chromium 79 / webOS 6).

## 2026-09-28 — Étape 1 : socle et contrats

**Périmètre livré** (voir `docs/PLAN.md` pour la traçabilité complète) :

- dépôt initialisé, manifeste §2.6 (`appinfo.json`, `services.json` avec `commands` non publiques),
  configuration TypeScript à **deux cibles** : service `ES2017`/CommonJS pour Node 8.12, interface
  `ES2019` séparée ;
- contrats §15.1 transposés en TypeScript (`src/contracts/types.ts`), codes d'erreur §7.2/§15.4
  avec assainissement des messages (`src/contracts/errors.ts`) ;
- crypto d'index §15.3 : HKDF-SHA256 écrit à la main (vecteurs RFC 5869 en CI), dérivation
  `masterKey → indexKey → nonce`, AAD liée au contexte, format par blocs de 4096 à offsets fixes,
  lecture à accès aléatoire tenant **un seul bloc en clair** en mémoire ;
- index §15.2 : secteurs fixes de 128 octets, `payload.bin` pour les charges lourdes, index de
  titres épars + table dense, tranches alphabétiques calculées à l'indexation, dictionnaire de
  groupes avec plages d'ordinaux, manifeste non secret, bascule atomique et rétention ;
- recherche indexée : recherche binaire sur l'index épars puis balayage borné à la page, avec
  compteurs instrumentés prouvant l'absence de parcours linéaire ;
- machines d'état §15.5 (lecteur et import) et coalescence de zapping testables sans TV ;
- normalisation partagée §9.3, scripts/tranches §9.1, marquage d'hôtes §5.2, analyse
  `hasCredential` §5.2/§15.6 ;
- outillage : harnais de test sans dépendance exécutable sur Node 8.12, contrôle d'API interdites
  (`tools/node812-compat.js`) portant sur la source **et** l'artefact compilé, contrôle de
  dépendances (`tools/deps-audit.js`), CI à deux cibles (Node 20 pour l'outillage, Node 8.12 pour
  l'artefact).

**Envoi sur GitHub** : commit initial poussé sur `main`, puis workflow activé dans
`.github/workflows/ci.yml` après mise à jour des droits du jeton. Premier passage : **succès des deux
tâches**, dont `Tests sur la cible Node 8.12` avec `node: v8.12.0`, contrôle d'API interdites OK et
**77 tests, 0 échec** sur la cible réelle du service. Aucun secret n'est présent dans le dépôt.

**Résultat** : `npm test` → **77 tests, 0 échec** ; `npm run lint:node812` → OK ;
`npm run check:deps` → OK (zéro dépendance d'exécution).

### Décisions et écarts

| Réf. | Décision | Motif | Statut |
|---|---|---|---|
| **D-01** | `fileKind` ajouté au **sel** de dérivation de clé (l'AAD reste celle du §15.3) | Sans lui, `records.bin` et `payload.bin` d'un même `(profil, version, type)` partageraient clé **et** nonces : réintroduction du défaut P0 au niveau inter-fichiers | testé (clés et nonces distincts, bloc déplacé rejeté) — à confirmer par l'auteur de la spec |
| **D-02** | Index de titres = `prefix8` normatif **+** extension de 8 octets **+** table dense d'ordinaux | Le seul index épars du §15.2 ne permet ni de *marcher* dans l'ordre alphabétique, ni de discriminer des titres partageant leurs 8 premiers octets (balayage quasi linéaire) | testé ; budgets à mesurer en 0D |
| **D-03** | Charges lourdes dans `payload.bin`, offsets relatifs dans le secteur | Réalise explicitement les `payloadOffset`/`payloadLength` du §15.2 ; une page de liste ne lit jamais une charge lourde | testé |
| **D-04** | Charge courte ajustée par coupes successives (résumé puis logo) avec avertissement d'import | Garantit qu'une entrée « ventrue » ne casse pas l'indexation tout en gardant la page bornée en octets | testé |
| **D-05** | `payload.bin` chiffré avec le même format de blocs mais un `fileKind` distinct | Voir D-01 ; le manifeste reste le seul fichier en clair | testé |

### Points restés ouverts (conformément au §15.6)

- seuils mémoire exacts du service (RSS, taille de lot de parsing) : après mesures 0D ;
- `searchIndexKind` par défaut : `title` retenu provisoirement ; `title+tokens` dépend du budget disque ;
- seuil de longueur du « segment porteur d'identifiant » : valeur par défaut **24 caractères**,
  exposée dans `urltools.DEFAULT_CREDENTIAL_SEGMENT_MIN_LENGTH` et couverte par un test
  d'acceptation (les URL de CDN publiques ne doivent pas être classées secrètes).

### Prochaine étape (étape 2)

1. Service LS2 §15.4 : `testProfile`, `getPage`, `search`, `getBuckets`, `getDetails`,
   `resolveStream`, `diagnostics`, enveloppe unique, plafonds objets/octets, aucune URL vers l'UI ;
2. adaptateur Xtream (`player_api.php`, appel « tous les flux » avant le découpage par catégorie),
   client HTTP du service (§2.5 : redirects bornés, schémas revalidés, IP épinglée, bundle de
   racines embarqué) ;
3. persistance DB8 (profils, préférences, `ImportJob`, clé maître) et pipeline d'import Xtream
   reprenable ;
4. diagnostic local sans secret.
