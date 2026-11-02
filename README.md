# Lecteur IPTV — LG webOS TV 6+

Lecteur IPTV destiné aux téléviseurs **LG webOS 6 et suivants**, entièrement pilotable à la
télécommande. L'application lit **uniquement les sources fournies par l'utilisateur** : elle ne
fournit, ne découvre, ne partage et ne vend ni playlist, ni identifiant, ni flux audiovisuel.

Ce dépôt implémente la spécification `docs/SPEC-v1.3.md` **par incréments** (§1.4) :

| Incrément | Contenu | État |
|---|---|---|
| Socle | contrats `§15.1`, crypto d'index `§15.3`, index/recherche `§15.2`, machines d'état `§15.5`, outillage CI | **livré (étape 1)** |
| Service | client HTTP `§2.5`, parseur JSON incrémental, DB8 `§2.4`, adaptateur Xtream `§5.1`, import reprenable `§15.5`, protocole LS2 `§15.4`, diagnostic local | **livré (étape 2)** |
| V1-A | Xtream (profil, test) + Live TV (catégories, chaînes) + lecteur + `resolveStream()` + diagnostic local | **livré (étape 3)** : service complet + **interface Enact** (`ui/`) — qualification lecteur (§0B) à faire sur TV |
| V1-B | EPG, favoris, reprise, VOD (grille, fiche, recherche indexée, saut alphabétique) | **partiellement livré en pré-release 0.1.19** — catégories, grille virtualisée et fiches VOD; import VOD séparé dans Réglages. Recherche, saut alphabétique, favoris, reprise et EPG restent hors périmètre; aucun essai TV VOD n'est consigné |
| V1-C | Séries (saisons, épisodes) + navigation globale persistante | à venir |
| V1-D | M3U (second moteur, identité `logicalKey`/`variantKey`), gros catalogues, index chiffré, reprise d'import | à venir |

L'état réel de chaque brique, les écarts et ce qui reste **à valider sur téléviseur** sont tenus à
jour dans `docs/PLAN.md` et `docs/JOURNAL.md`.

**Dernière pré-release publiée :** 0.1.19 — VOD, grille et fiches ([tag `v0.1.19-vod`](https://github.com/ouagkamel/iptv_V2/tree/v0.1.19-vod); [release GitHub](https://github.com/ouagkamel/iptv_V2/releases/tag/v0.1.19-vod); [notes](docs/RELEASE-0.1.19.md)). L'artefact est destiné à l'essai manuel; ni import fournisseur ni test TV VOD n'ont été effectués ici.

## Choix techniques (imposés par la spécification §2 et §14)

- **Enact 3.4.9 + Sandstone 1.4.6** (dernière branche couvrant webOS 6.0), `@enact/spotlight` pour le
  5-way, **TypeScript** compilé.
- **Service JS webOS** (Node.js 8.12 embarqué, cible ES2017) : réseau fournisseur, parsing par lots,
  index catalogue compact **chiffré au repos** (AES-256-GCM, dérivation `§15.3`) dans le répertoire
  privé du service.
- **DB8** pour profils, préférences, favoris, reprises et `ImportJob` — jamais le catalogue.
- **`<video>` HTML natif** unique, alimenté exclusivement par `resolveStream()` (l'URL de flux est
  une donnée de session, jamais persistée par l'interface).
- **Zéro dépendance d'exécution** côté service (§2.3) : HKDF-SHA256 et le format de fichier chiffré
  sont implémentés dans le dépôt, testés par vecteurs RFC 5869.

## Paquetage webOS

```
/                                  # APP_DIR  (appinfo.json, index.html, ui/main.js, diagnostic.html)
service/<id-de-service>/           # SERVICE_DIR (package.json, services.json, lib/ compilé)
ui/                                # interface Enact : source de l'application (hors paquet livré)
```

L'application a **deux pages** : `index.html` porte l'interface Enact (accueil à quatre cartes,
Live TV, tranche VOD autorisée — grille et fiches —, réglages, lecteur) et `diagnostic.html` reste la page de contrôle de la phase 0A, joignable
depuis *Réglages* → « Page de diagnostic (0A) ». En 0.1.18, le `profils.js` versionné fournit le
profil de test par défaut; `secrets.local/profils.js` peut le remplacer pour un essai local. Une
livraison sans source doit être construite avec `IPTV_SANS_SOURCES=1 npm run dist` : le paquet est
alors neutralisé, et `tools/publish-release.js` refuse toute archive qui déclare des sources.

```bash
npm ci                  # outillage de développement
npm --prefix ui ci      # dépendances de l'interface (react, @enact/*)
npm run build           # compile le service (ES2017/Node 8.12) puis l'interface
npm test                # tests unitaires + contrats (node, sans dépendance)
npm run lint:node812    # interdit toute API absente de Node 8.12
npm run check:deps      # refuse une dépendance d'exécution non justifiée
npm run build:ui        # construit l'interface Enact (Enact + Sandstone) dans ui/dist
npm run dist:local      # paquet d'essai préconfiguré dans release/local/ (nécessite ares-cli)
IPTV_SANS_SOURCES=1 npm run dist  # livraison publiable sans profil préconfiguré
```

Installation en mode développeur :

```bash
npm i -g @webosose/ares-cli      # outillage LG (ares-package, ares-install, ares-launch)
IPTV_SANS_SOURCES=1 npm run dist # compile le paquet public sans source dans dist/<version>/
ares-install --device tv dist/0.1.19/com.ouagkamel.app.iptvplayer_0.1.19_all.ipk

# Pour l'essai local avec les champs préremplis (ne pas publier cet IPK) :
npm run dist:local
ares-install --device tv release/local/com.ouagkamel.app.iptvplayer_0.1.19_all.ipk
```

**Dernière publication binaire GitHub (pré-release VOD)** :
[`v0.1.19-vod`](https://github.com/ouagkamel/iptv_V2/releases/tag/v0.1.19-vod), avec l'`.ipk`,
`0.1.19.zip`, le pack simulateur et `SHA256SUMS.txt`. Le paquet public est neutralisé (sans profil
préconfiguré); le profil de test versionné dans le dépôt n'est pas embarqué dans ces pièces.

`IPTV_SANS_SOURCES=1 npm run dist` produit la **livraison téléchargeable publiable** : `dist/<version>/`
contient l'`.ipk` sans source préconfigurée, le contenu du paquet dépaqueté, `SHA256SUMS.txt` et un
`LISEZ-MOI.txt` ; `dist/<version>.zip` est l'archive prête à joindre à une publication GitHub.
`npm run dist:local` fabrique séparément le paquet d'essai avec le profil prérempli dans
`release/local/`; ne pas joindre ces artefacts à une publication.

La pré-release 0.1.19 contient le **service complet**, l'**interface Enact V1-A**, la tranche VOD
autorisée (catégories, grille et fiches) et la **page de diagnostic** télécommandable. Aucun import
fournisseur ni essai VOD sur TV réelle n'a été effectué pour cette publication; elle n'est ni une
qualification média 0B ni une certification LG. Les vérifications à faire **sur la TV** sont dans
`docs/ESSAI-0A.md` (dont le parcours VOD) et `docs/ESSAI-0B.md`.

Avant la TV, un portail réel peut être éprouvé **hors appareil** avec le service tel qu'il sera
embarqué (mêmes commandes, mêmes enveloppes, mêmes contrôles) :

```bash
IPTV_HOST=portail.example:8080 IPTV_USER=... IPTV_PASS=... npm run verify:portal
```

Le contrôle enchaîne `testProfile`, `importPlaylist` (progression par abonnement), `getPage`,
`getBuckets`, `search`, `getDetails`, `resolveStream` puis **lit le flux résolu** (redirections
suivies, en-tête `video/mp2t`, synchronisation MPEG-TS). Aucun identifiant n'est journalisé et rien
n'est écrit dans le dépôt ; il n'est pas inclus dans `npm test` (réseau requis).

> **CI** : `.github/workflows/ci.yml` s'exécute à chaque envoi. Deux cibles : l'outillage et la
> compilation sur Node 20, puis l'artefact du service testé sur **Node 8.12.0** — la version
> réellement embarquée par webOS 6. Un test qui échoue seulement en 8.12 est un bug de cible, pas
> un test à désactiver.

## Le service en trois phrases

Le service est la seule partie qui touche au réseau, au disque et à DB8. `importPlaylist` construit
un index chiffré par type de contenu et le publie par bascule atomique ; l'interface ne reçoit
jamais d'URL — elle demande une page (`getPage`), une recherche (`search`) ou une tranche
alphabétique (`getBuckets`), puis une résolution de flux (`resolveStream`) juste avant la lecture.
Tous les appels partagent la même enveloppe `{ returnValue, indexVersion?, data?, error? }`, bornée
en objets **et** en octets, et le diagnostic local ne contient jamais un identifiant ni une adresse
de portail complète.

## Sécurité et vie privée

- Les identifiants saisis ou importés à l'exécution ne sont pas journalisés ni renvoyés à l'interface;
  l'index est chiffré par blocs de taille fixe, et la clé maître vit dans DB8 app-aware (§8.2, §15.3).
- Exception explicitement demandée pour 0.1.18 : le profil de test de `src/app/profils.js` est
  versionné en clair dans le dépôt public. Il doit être considéré comme public; ne pas y mettre de
  compte privé ou de production. Pour une publication, construire explicitement avec
  `IPTV_SANS_SOURCES=1`; le contrôle de publication refuse les paquets qui embarquent une source.
- L'index protège contre une autre application et une lecture non privilégiée des fichiers — **pas**
  contre un appareil rooté ni un attaquant privilégié (§8.1). Cette limite est affichée dans la page
  « À propos ».
- Marquage et refus des URL de flux privées/loopback (§5.2) avant toute affectation de `video.src`.

## Conformité

L'utilisateur doit posséder ou être autorisé à utiliser les sources qu'il configure. L'application
ne contourne ni DRM, ni abonnement, ni restriction régionale. Le contrôle de distribution LG
(phase 0, §12) reste non résolu : cette pré-release destinée à un essai manuel n'est ni une
autorisation de distribution large ni une certification. Obtenir la réponse écrite de LG avant toute
distribution de production.
