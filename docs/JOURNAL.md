# Journal d'exécution

## 2026-10-08 — Écran noir du simulateur : le chargeur de langues d'Enact (0.1.9)

**Ce qui a été observé** (simulateur webOS, paquet 0.1.8, application prête puis page noire) :

```
[iptv-ui] application prete (pont LS2 : PalmServiceBridge)
main.js:2 DOMException: Failed to execute 'send' on 'XMLHttpRequest':
  Failed to load 'file:///.../app/node_modules/ilib/locale/ilibmanifest.json'
```

**Cause racine, reconstituée puis reproduite hors navigateur.** Enact charge des données de langue au
premier `$L()` d'un composant Sandstone (`Header`, `useScroll`, `MediaPlayer`…), et il le fait en
**synchrone** :

| Étape | Appel |
|---|---|
| 1 | `$L('…')` → `toIString()` |
| 2 | `toIString()` → `createResBundle()` (`@enact/i18n/src/resBundle.js`) → `new ilib.ResBundle` (`sync: true` par défaut) |
| 3 | `ResBundle` → `IString.loadPlurals()` → `Utils.loadData({sync: true})` |
| 4 | `Utils._callLoadData()` → `EnyoLoader.loadFiles(paths, sync=true)` |
| 5 | `loadFiles` → `loadManifestsSync()` → `_loadManifest()` → `XMLHttpRequest` **synchrone** |

En `file://`, un XHR synchrone vers un fichier **absent** lève une exception (Chromium), et cette
exception remonte au milieu d'un rendu React : l'arbre est démonté, **l'écran reste noir**. Le paquet
0.1.8 ne contenait aucune donnée iLib (option `ILIB_ASSET_EMIT=false`) donc rien à lire : le
`ilibmanifest.json` manquait, et le commentaire qui affirmait que `ILIB_NO_ASSETS` évitait les
requêtes au démarrage **était faux** (rien, à l'exécution, ne lit cette constante dans Enact 3.4.9).

| Réf. | Constat | Correctif |
|---|---|---|
| **D-34** | Aucun moyen de reproduire un défaut d'interface sans le simulateur : « ça marche ici » ne voulait rien dire | `tools/render-app.js` : banc **headless** (jsdom) qui exécute le paquet réel (`index.html`, `profils.js`, `ui/main.js`) avec un `XMLHttpRequest` imitant Chromium en `file://` — fichier présent : statut 0 + corps ; fichier absent : exception. Il rapporte requêtes, requêtes ratées, erreurs et DOM rendu |
| **D-35** | Écran noir : `$L()` déclenchait un chargement **synchrone** de données de langue, introuvables dans le paquet | `ui/src/services/sansLocales.js`, appelé avant tout rendu : **chargeur inerte** (`ilib.setLoaderCallback`) — toute demande de données reçoit « rien », aucun XHR n'est émis — et **paquet de chaînes vide** (`setResBundle`) — `$L()` renvoie la chaîne source, comme Enact le fait pour une traduction absente. Conséquence assumée : les libellés internes de Sandstone restent en anglais ; ceux de l'application sont écrits en français dans le code |
| **D-36** | Un test qui se contente de « ça compile » ne protège pas du défaut | `tests/render.test.js` : la source neutralise i18n avant le rendu, aucun module de `ui/src` ne demande de fichier de langue, et le **bundle réel** exécuté dans le banc n'émet **aucune requête**, ne produit **aucune erreur** et rend bien les quatre cartes. Contre-épreuve faite : correctif retiré → le test échoue (`195 OK, 1 échec`) |

**Contrôles du tour** : `npm test` → **196 tests, 0 échec** (Node 20 **et** Node 8.12) ;
`lint:node812`, `check:deps`, `typecheck` OK ; banc headless sur le paquet : `requetes: []`,
`erreurs: []`, accueil rendu (« IPTV V2 | Live TV | Films | Séries | Réglages »), source
préconfigurée lue depuis `profils.js`.


## 2026-10-07 (suite 2) — Interface Enact (V1-A), libellés de champs et paquet 0.1.8

**Étape 3 : l'interface Enact est écrite et se construit.** `ui/` contient un projet Enact autonome
(`@enact/cli` 3.0.8, `@enact/core|ui|spotlight|i18n|webos` 3.4.9, `@enact/sandstone` 1.4.6,
React 17.0.2, `.browserslistrc` `chrome 79`) :

| Pièce | Rôle |
|---|---|
| `ui/src/services/ls2.js` | enveloppe promesses/abonnement de `webOS.service.request` (les écrans ne parlent jamais au bus) |
| `ui/src/services/service.js` | les **douze commandes** LS2, réponse normalisée `{ok, data, error{code,message,retryable,hint}, indexVersion, brut}` |
| `ui/src/services/profils.js` | sources préconfigurées lues dans `window.iptvProfils` (mêmes règles que la page) |
| `ui/src/views/{Accueil,Live,Vod,Series,Reglages,Lecteur}.js` | quatre cartes, catégories + chaînes paginées par curseur, réglages + consentement HTTP clair, lecteur `<video>` unique alimenté par `resolveStream()` |
| `ui/src/App/App.js` | pile `Panels` accueil → contenu (`TabLayout` 4 onglets, Spotlight) → lecteur, Retour par `onBack` |

**Ce qui a dû être tranché** (chaîne de build ancienne, cible webOS 6) :

| Réf. | Constat | Décision |
|---|---|---|
| **D-29** | `@enact/cli` n'a **pas** de commande `build` (seulement `pack`, `serve`, `lint`, …) et, sous Node ≥ 17, `enact pack` échoue sur `error:0308010C:digital envelope routines::unsupported` (webpack 4 calcule des empreintes `md4`, refusées par OpenSSL 3) | `tools/build-ui.js` lance `enact pack -p` et **ajoute `--openssl-legacy-provider` uniquement sur Node ≥ 17** (jamais sur les Node qui ne connaissent pas l'option) |
| **D-30** | Le plugin iLib copiait **82 Mio** de locales dans `dist/` : aucun sens pour un `.ipk` de TV | `ILIB_ASSET_EMIT=false` : bundle de **~1,15 Mio** (`main.js` 947 007 o, `main.css` 205 654 o) qui déclare `ILIB_NO_ASSETS` — l'interface n'affiche que du texte français en dur et n'appelle aucune API de localisation |
| **D-31** | L'interface Enact doit devenir l'entrée de l'application, mais la page de diagnostic reste le poste de contrôle de la phase 0A | `src/app/index.html` devient la **coquille de l'interface** (charge `profils.js` puis `ui/main.js`) ; la page de diagnostic déménage en `src/app/diagnostic.html`, joignable depuis *Réglages* → « Page de diagnostic (0A) », avec un lien retour |
| **D-32** | Le compte de test était prérempli mais les champs ne disaient pas **d'où** venait la valeur | chaque champ porte le libellé de la source : « Nom d'utilisateur — Portail de test (Xtream) », etc. (`format.champsDepuisSource` → `etiquettes`, appliqué par `diagnostic.js` et par l'écran Réglages). Les champs restent **préremplis avec les données** (demande explicite : rien à ressaisir) |

**Deux pièges de configuration corrigés au passage** : les écrans Enact sont écrits sans fonction
anonyme dans les props JSX et sans `var` (la chaîne Enact refuse les avertissements de style), et les
fichiers ES5 volontaires de la page (`format.js`, `webos-bridge.js`) portent un
`/* eslint-disable no-var */` justifié — la construction passe donc **sans aucun avertissement**.
`getCategories` (douzième commande, indispensable au panneau des catégories) est livrée avec ses
tests.

**Emballage** : `npm run pack:webos` construit maintenant le service **et** l'interface ;
`tools/make-package.js` refuse de paqueter si `ui/dist/main.js` manque et dépose le bundle sous
`ui/` dans le paquet. La livraison contient donc : `index.html` (interface), `diagnostic.html`
(page de contrôle), `ui/main.js` + `ui/main.css`, `webos-bridge.js`, `format.js`, `profils.js`,
`assets/`, et le service compilé.

**État des tests** : `npm test` → **192 tests, 0 échec** (Node 20 et Node 8.12), dont **7 nouveaux**
spécifiques à l'interface (coquille, douze commandes, quatre sections + Retour, pagination par
curseur du Live, lecteur `<video>` unique + `resolveStream`, consentement HTTP clair, outillage de
construction). La CI (`.github/workflows/ci.yml`) installe désormais les dépendances de l'interface
et la construit (`npm --prefix ui ci` puis `npm run build:ui`).

**Version 0.1.8** (interface + libellés) : publiée en `v0.1.8-phase0a` sans source préconfigurée,
avec le pack simulateur. L'essai **sur téléviseur** (phase 0A) reste le critère bloquant.

## 2026-10-07 (suite) — Source préconfigurée et publication 0.1.7

**Déblocage** : après génération d'un **nouveau jeton**, les écritures GitHub repassent
(témoin d'écriture HTTP 201) ; les commits en attente ont été poussés (`d1f9ef2..20a9499`), la
publication `v0.1.7-phase0a` créée, et les publications `v0.1.5`/`v0.1.4` annotées « remplacée ».

| Réf. | Constat | Correctif |
|---|---|---|
| **D-28** | Il fallait ressaisir adresse, identifiant de profil, nom d'utilisateur et mot de passe à chaque essai — sur simulateur comme sur TV | **source préconfigurée** : `secrets.local/profils.js` (local, `gitignore`) remplace `src/app/profils.js` à l'empaquetage ; la page propose alors la source dans une liste (*Source préconfigurée*), remplit les champs, coche l'autorisation HTTP clair si l'adresse est en `http://`, et il ne reste qu'à cliquer **Tester la source** puis **Importer (live)** |

Garde-fous ajoutés : `IPTV_SANS_SOURCES=1 npm run dist` construit une livraison **sans** source ;
`tools/publish-release.js` **refuse de publier** une livraison qui embarque des sources
(`dist/<version>/app/profils.js` déclare une liste non vide) — vérifié dans les deux sens : refus
explicite sur le build avec source, publication acceptée sur le build propre. Le fichier versionné
`src/app/profils.js` ne contient **aucune** source (liste vide) et documente le mécanisme ; un test
vérifie que **aucun fichier suivi par git** ne contient un identifiant de `secrets.local`.

**Livraison** : version **0.1.7** — `npm test` → **183 tests, 0 échec** (Node 20 et Node 8.12) ;
publication **`v0.1.7-phase0a`** avec l'`.ipk` pour la TV (236 076 o, sha256 `3f1868a2…62a9`),
`0.1.7-simulateur.zip` (263 446 o, sha256 `7774d7ec…0ba8`), `0.1.7.zip` (769 082 o, sha256
`f820301c…2384`) et `SHA256SUMS.txt` (12 170 o, sha256 `1f68c167…526f`) — quatre pièces jointes
**sans identifiants**, re-téléchargées depuis l'URL publique et comparées octet à octet. La source
préconfigurée, elle, reste **locale** (`release/local/0.1.7-simulateur-source.zip`, hors dépôt) : y
publier des identifiants les exposerait sur un dépôt public.

## 2026-10-07 — HTTP clair et cause réelle des échecs (0.1.6) ; écritures GitHub bloquées

**Ce qui a été observé** : « Tester la source » répond `security/insecurescheme` et « Importer »
répond `internal/unexpected`. Les deux ont **la même cause** : l'autorisation « portail en HTTP
clair » (§8.2) — le portail de contrôle est en `http://`.

| Réf. | Défaut | Cause réelle | Correctif |
|---|---|---|---|
| **D-26** | Le refus `security/insecureScheme` n'était actionnable nulle part : aucun contrôle correspondant dans la page, aucun hôte à confirmer, et l'import partait quand même pour échouer plus loin | Le service exigeait `consent.insecureHttp` mais ne disait ni **où** ni **pour quel hôte**, et seul le chemin du test de source portait l'information (dans `warnings`, pas dans l'erreur) | `security/insecureScheme` porte désormais `hint: hote:<hôte>` au **test** comme à l'**import** ; l'import **refuse immédiatement** (aucun job lancé) ; la page porte la case « Portail en HTTP clair : j'autorise », la coche automatiquement sur demande du service, affiche un bandeau d'explication avec bouton **Relancer**, et mémorise le choix par hôte (`localStorage`) |
| **D-27** | `importPlaylist` répondait `internal/unexpected — « import interrompu avant la bascule »` pour **n'importe quel** échec | `outcome.error` est une **forme sérialisée** (`toShape()`), pas une instance : le test `instanceof AppError` était donc toujours faux et la cause était remplacée par un message générique | la forme est relue et reconstituée en erreur typée (`code`, `message`, `hint`) : `auth/*`, `network/*`, `security/*` remontent tels quels à l'appelant et au journal |

**Ce que la page fait maintenant** : un portail `http://` s'autorise en **un clic** (case + bandeau
+ Relancer), l'autorisation est enregistrée par hôte et par profil, et tout échec affiche son code
réel (`auth/expired`, `auth/invalidCredentials`, `network/http`, `security/insecureScheme`…).

**Validation sur portail réel (compte de test neuf)** : `npm run verify:portal` → **CONTROLE
REUSSI** — compte `Active` (échéance 05/11/2026), formats `m3u8`/`ts`, import live **5 659 entrées en
1,6 s** (1 858 527 octets), page de 200 objets, 27 tranches, tri/recherche, détail sans secret
(mode `derived`), `resolveStream` → **302** → `HTTP 200 video/mp2t`, **lecture réelle de 1 051 643
octets**, MPEG-TS vérifié (`0x47` tous les 188 octets). Le portail précédent, lui, a **expiré** en
cours de session (il répondait `Expired` puis HTTP 451) : le service le dit maintenant explicitement
au lieu d'une cascade d'erreurs réseau.

**Tests** : **178, 0 échec** sur Node 20 **et** Node 8.12 (nouveaux : refus immédiat sans job, import
abouti après confirmation, cause réelle d'un échec d'import, extraction de l'hôte à confirmer,
présence de la case dans la page et du consentement dans les appels).

**Livraison** : version **0.1.6** construite (`dist/0.1.6/`, `dist/0.1.6.zip` 763 728 o,
`dist/0.1.6-simulateur.zip` 261 402 o, `.ipk` 234 700 o, sha256 `3b4c4d1a…7952`),
`docs/RELEASE-0.1.6.md` prêt.

**Blocage externe** : **toutes les écritures GitHub du compte échouent en HTTP 500** — création de
publication, téléversement d'actifs, `git push`, création de ticket, écriture d'un blob témoin — sur
les **trois** dépôts du compte, alors que les lectures passent et que le jeton présente
`permissions: {admin, push, maintain: true}`. GitHub se déclare « All Systems Operational ».
Vérifié aussi par un second jeton (fourni par l'utilisateur) : même résultat. C'est donc un blocage
**côté compte** (ou incident GitHub non annoncé), pas une question de droits : la publication de
`v0.1.6-phase0a` est **prête mais différée**.

## 2026-10-01 — Simulateur : le service répond, deux défauts de plus (0.1.5)

**Ce qui a été observé** : la page parle enfin au service (plus de « Service does not exist »), mais
au premier import elle affiche `[object Object]` et rien n'aboutit. Le compte de test utilisé pour la
validation est, lui, arrivé à échéance (le portail répond `status: Expired` puis **HTTP 451** à tous
les appels) : la validation sur portail réel devra être rejouée avec un abonnement à jour.

**Défauts trouvés et corrigés** :

| Réf. | Défaut | Cause réelle | Correctif |
|---|---|---|---|
| **D-23** | Le premier import échoue toujours sur un appareil neuf (« profil inconnu ») | **Aucune commande LS2 ne crée de profil** : `importPlaylist` exigeait un profil enregistré, que rien ne pouvait créer — le simulateur comme un téléviseur après effacement ne pouvaient donc jamais importer | `importPlaylist` **crée le profil au premier import** (`kind`, `source.url` sont déjà dans sa charge utile), répond `profilCree: true`, et refuse avec un message explicite si aucune adresse n'est fournie ; test dédié (création, puis second import sans nouvelle création) |
| **D-24** | `[object Object]` à l'écran dès qu'une commande échoue | La page ne connaissait que les erreurs **du bus** (`errorText`) et pas l'enveloppe **du service** (§15.4 : `error.code`/`error.message`) ; elle affichait aussi « ok » en vert alors que `testProfile` renvoyait `data.ok: false` (compte expiré) | nouveau `src/app/format.js` (testable, partagé) : `code — message (indication) [réessayable]`, message brut du bus conservé, JSON affiché en complément ; la ligne du journal suit désormais le **verdict métier** (`data.ok`) et affiche le premier code d'erreur |
| **D-25** | Compte expiré : l'utilisateur voyait une cascade d'erreurs réseau | L'import ne vérifiait pas l'état du compte avant de lancer les appels fournisseur ; chaque appel échouait et le message parlait de réseau | **contrôle préalable** dans `importPlaylist` : un refus non réessayable de type `auth/*` interrompt l'import avec `auth/expired` ou `auth/invalidCredentials` et l'indication de vérifier l'abonnement ; `diagnostics` sonde DB8 (`db.ok`, nombre de profils) sans jamais échouer globalement, et la page ouvre une bannière si la base est inaccessible |

**Ce que la page affiche maintenant** (mêmes boutons, mêmes commandes) :

- verdict de `testProfile` : `Active` / `Expired` avec `expiresAt`, formats et limite de connexions ;
- échec d'import : `auth/expired — portail : abonnement expire (verifier l abonnement …)`, jamais
  `[object Object]` ;
- `diagnostics` : `db.ok`, nombre de profils, index publiés, racines embarquées, runtime.

**Livraison** : version **0.1.5** — `npm test` → **171 tests, 0 échec** (Node 20 et Node 8.12) ;
`npm run dist` → `dist/0.1.5/`, `dist/0.1.5.zip` (757 383 o), `dist/0.1.5-simulateur.zip`
(259 179 o) ; publication **`v0.1.5-phase0a`** (identifiant `398424098`) avec quatre pièces jointes,
re-téléchargées et comparées octet à octet :

| Fichier | Taille | sha256 |
|---|---|---|
| `com.ouagkamel.app.iptvplayer_0.1.5_all.ipk` | 232 806 o | `108bacd27b9b2b8e73f89bf4bc83ce28c64d2ab9995c0afd80ec6cc1f33581ba` |
| `0.1.5-simulateur.zip` | 259 179 o | `5cfe154d6883636b1cdba0b00b5655c1e1590165294f6e087da79208b757208e` |
| `0.1.5.zip` | 757 383 o | `1aedf77c26acda0436193a5dd4774eea8ca9ec295b99b14cddb57253b6c00cdd` |
| `SHA256SUMS.txt` | 11 997 o | `ebd3ba954433d63e53ac36824ef52d39b1025edc8e04d5513ee27d055e8e665d` |

CI sur `490d891` : **2/2 tâches vertes** (Node 20 et Node 8.12, 171 tests). `docs/RELEASE-0.1.5.md` porte le texte publié ; les publications 0.1.4 et
antérieures portent leur mention « remplacée ».

**État de la validation sur portail réel** : interrompue — le compte de test est arrivé à échéance
(`Expired`, puis **HTTP 451** sur tous les appels `player_api.php`). Le pipeline reste validé par les
tests hors ligne et par les essais précédents ; la reprise de 0C demande un abonnement à jour.

## 2026-09-30 — Simulateur webOS : pourquoi le service n'y est pas « connu » (0.1.4)

**Ce qui a été observé** : l'erreur persiste (`Service does not exist:
com.ouagkamel.app.iptvplayer.service`) — mais l'essai se fait **sur le simulateur webOS**, pas sur la
TV. Ce n'est pas un défaut du paquet : le simulateur fonctionne autrement.

| Réf. | Constat | Correctif |
|---|---|---|
| **D-21** | Le **simulateur n'installe pas de `.ipk`** : il lance une application depuis un **dossier** (*File > Launch App*) et n'accepte un service que s'il est **ajouté explicitement** (*File > Add Service*), puis démarré (*Tools > Service List*). Un service déclaré seulement dans un paquet n'est donc jamais enregistré auprès du bus du simulateur : toute requête répond « Service does not exist », alors que l'application, elle, tourne | `npm run stage:simulator` produit `release/simulator/` avec les **deux racines à sélectionner** (`app/`, `service/<id>/`) et un `LISEZ-MOI-SIMULATEUR.txt` ; `npm run dist` l'ajoute à `dist/<version>/simulateur/` et produit `dist/<version>-simulateur.zip` (archive **à plat**, pour que le mode d'emploi « extraire dans un dossier personnel » soit exact) ; section « Simulateur webOS » de `docs/PHASE-0.md` |
| **D-22** | Hors téléviseur, `/media/internal` n'existe pas : le service répondait « répertoire indisponible » à chaque commande | `resolveStorageRoot()` : on tente le chemin du téléviseur, sinon **repli** sur un répertoire temporaire (`iptv-webos-<app id>`), journalisé au démarrage. L'enregistrement auprès du bus, lui, n'en dépend jamais — un service qui ne s'enregistre pas est précisément le défaut « Service does not exist » |

La page de diagnostic affiche désormais si elle tourne **sur un simulateur** (agent) et, dans le cas
« Service does not exist », la bannière rappelle la procédure du simulateur en plus de celle de la TV.

**Vérification** : `npm test` → **161 tests, 0 échec** (Node 20 et Node 8.12), dont quatre nouveaux :
structure du pack simulateur (racine d'application avec `appinfo.json` et son `main`, racine de
service avec `package.json`/`services.json` cohérents, mode d'emploi citant les deux menus) et repli
du répertoire de travail. Validation du pipeline complet sur le portail réel rejouée hors TV :
connexion, 59/60/44 catégories, import de **5 299 chaînes en 1,2 s**, page de 200 objets, tranches,
recherche, détail sans secret, `resolveStream`, puis **lecture réelle du flux** (302 → `HTTP 200
video/mp2t`, `0x47` tous les 188 octets).

**Livraison** : version **0.1.4** — `dist/0.1.4/` + `dist/0.1.4.zip` + **`dist/0.1.4-simulateur.zip`**,
publication **`v0.1.4-phase0a`** (pré-version, identifiant `398420309`) : quatre pièces jointes —
`com.ouagkamel.app.iptvplayer_0.1.4_all.ipk` (230 260 o, sha256 `1b7f53e3…9cbc`) pour la TV,
`0.1.4-simulateur.zip` (255 900 o, sha256 `450dc8f2…7949`) pour le simulateur, `0.1.4.zip` (783 722 o)
et `SHA256SUMS.txt` — toutes re-téléchargées depuis l'URL publique et comparées octet à octet.
`tools/publish-release.js` (outil de maintenance, jeton lu hors dépôt) crée la publication, les
pièces jointes et la mention « version remplacée » ; `docs/RELEASE-0.1.4.md` porte le texte publié.

## 2026-09-28 — Deuxième essai TV : pont LS2 absent du paquet (0.1.2)

**Ce qui a été observé sur la TV** : même réponse `Service does not exist`, et dans la console de la
page : `Failed to load resource: net::ERR_FILE_NOT_FOUND webOSTV.js`.

**Défaut trouvé (défaut réel, indépendant du premier)** : `src/app/index.html` chargeait
`webOSTV.js` — la bibliothèque du SDK LG — qui n'était **pas** dans le paquet. Console en erreur,
`window.webOS` vide : la page n'avait plus aucun pont LS2, et il fallait un repli silencieux sur
`PalmServiceBridge`. La documentation LG est explicite : cette bibliothèque **doit être incluse dans
l'application** pour appeler un service webOS.

| Réf. | Défaut | Correctif |
|---|---|---|
| **D-17** | `net::ERR_FILE_NOT_FOUND webOSTV.js`, `window.webOS` absent | `src/app/webos-bridge.js` : pont maison, sans dépendance, qui fournit `webOS.service.request` (sur `PalmServiceBridge`), `webOS.deviceInfo`, `webOS.platformBack` et un état `webOS.__pont` ; il **ne remplace jamais** un `webOS` fourni par la plateforme. La page ne référence plus aucun fichier externe ; un test vérifie que **toute ressource citée par la page existe dans le paquet** (c'est exactement la classe de défaut qui vient d'être rencontrée) |
| **D-18** | Risque gratuit côté enregistrement | `services.json` et `package.json` du service réécrits en **ASCII pur** (descriptions sans accents) : le hub lit ce fichier pour enregistrer le service, un parseur qui ne suppose pas l'UTF-8 n'y verrait plus du JSON valide — soit exactement le symptôme « Service does not exist ». Test de non-régression sur les deux fichiers |

**La page de diagnostic devient auto-explicative** : au chargement elle affiche l'environnement réel
(pont retenu, présence de `PalmServiceBridge`/`PalmSystem`, nom du service appelé, agent) puis exécute
un **appel de contrôle** ; si le bus répond « Service does not exist », une bannière donne la
séquence exacte à exécuter depuis le poste de développement. Un bouton **Témoin du bus LS2**
interroge un service *du système* : s'il répond, le pont fonctionne et le défaut est propre au
service de l'application ; s'il échoue, aucun appel ne sort de la page. Le message brut du bus est
toujours affiché tel quel, jamais reformulé.

**Séquence à exécuter sur la TV** (elle est aussi affichée par la bannière) :

```bash
ares-install --device tv --listfull                                  # version réellement installée
ares-install --device tv -r com.ouagkamel.app.iptvplayer             # désinstallation complète
ares-install --device tv com.ouagkamel.app.iptvplayer_0.1.2_all.ipk  # réinstallation
# redémarrer la TV (le hub relit ses services au démarrage), puis :
ares-inspect --device tv -s com.ouagkamel.app.iptvplayer.service -o   # démarre le service et ouvre sa console
```

**Deux défauts de plus, trouvés en relisant la livraison** (ils auraient fait perdre un aller-retour
supplémentaire sur la TV) :

| Réf. | Défaut | Correctif |
|---|---|---|
| **D-19** | `dist/<version>/app/` était assemblé à partir d'une **liste de noms écrite à la main** (`appinfo.json`, `index.html`, `diagnostic.js`) : `webos-bridge.js` manquait donc dans l'archive `dist/`, alors qu'il était bien dans l'`.ipk` | la copie prend désormais **tout** le contenu empaqueté (aucune liste), et le test recrée une arborescence avec un fichier inconnu du script pour vérifier qu'il est copié ; les outils ne construisent plus rien quand on les `require()` depuis un test |
| **D-20** | Un fichier vidé par accident (`diagnostic.js`, 0 octet) passait tous les contrôles : la page se serait ouverte vide | test « les scripts de la page sont non vides et analysables » (`> 500 octets` **et** analyse `vm.Script`) ; le point d'entrée du service journalise désormais au chargement (`[iptv] demarrage du service … (node v8.12.x)` puis `[iptv] service enregistre … 11 commandes`), ce qui rend le diagnostic possible à distance avec `ares-log --device tv --follow` |

Les outils (`tools/*.js`) sont maintenant contrôlés eux aussi par `npm run lint:node812` : c'est ce
qui a révélé que `fs.mkdirSync(dir, {recursive:true})` (Node 10.12) y traînait — et comme les tests
les exécutent, le défaut aurait échoué sur la tâche Node 8.12.

**Livraison** : version **0.1.3** (0.1.2 avait une archive `dist/` incomplète),
`npm test` → **157 tests, 0 échec** (Node 20 et Node 8.12), `npm run dist` → `dist/0.1.3/` +
`dist/0.1.3.zip`, publication **`v0.1.3-phase0a`** — pré-version, identifiant `398407077`,
trois pièces jointes (texte de publication conservé dans `docs/RELEASE-0.1.3.md`) :

| Fichier | Taille | sha256 |
|---|---|---|
| `com.ouagkamel.app.iptvplayer_0.1.3_all.ipk` | 229 444 o | `ab1ae5da1e96efdc7f7891025faf43f8c045af1e2b496ea336caf3ff5f89b3af` |
| `0.1.3.zip` | 488 111 o | `df09faf8c37452ad37c16990230e1fb62a6dd839ff90928acced460ae7cdb072` |
| `SHA256SUMS.txt` | 5 720 o | `ad3a61793cad7c099941767551a50529bf23138b1934bcaabffa301cf5d07c1f` |

Re-téléchargées depuis l'URL publique et comparées octet à octet ; l'`.ipk` publié a été ouvert et
inspecté (page complète : `index.html`, `webos-bridge.js` 5 601 o, `diagnostic.js` 15 550 o ;
service : `index.js`, `lib/`, `services.json` avec ses onze commandes, `package.json` → `main: index.js`).
Les publications `v0.1.0`, `v0.1.1` et `v0.1.2` portent une mention « remplacée par v0.1.3 ».

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
| **D-16** | CI rouge **seulement** sur la tâche Node 8.12 | Le harnais de test du point d'entrée utilisait `fs.mkdirSync(dir, {recursive:true})`, apparu en Node 10.12 : la suite passait sur Node 20 et échouait sur la cible réelle | création d'arborescence portable dans le harnais **et** `npm run lint:node812` étendu au dossier `tests/` (un défaut de source trop récente dans les tests casse désormais la tâche Node 20, sans attendre la seconde tâche) |
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

**Livraison** : version **0.1.1**, `npm run dist` → `dist/0.1.1/` (`LISEZ-MOI.txt`, `SHA256SUMS.txt`,
`app/`, `service/`, l'`.ipk`) + `dist/0.1.1.zip` (479 388 octets), publication
`v0.1.1-phase0a` — pré-version, identifiant `398392407`, trois pièces jointes :

| Fichier | Taille | sha256 |
|---|---|---|
| `com.ouagkamel.app.iptvplayer_0.1.1_all.ipk` | 225 468 o | `690a9184ac18a0721fd121d0011e3bc3778ea2643e2ee8c259b11b14fd8292a2` |
| `0.1.1.zip` | 479 388 o | `fad5612ade8077085e0104100918ce1d42643994a4ad2dfb010935f3719a0d0d` |
| `SHA256SUMS.txt` | 5 634 o | (sommes des 62 fichiers de `dist/0.1.1/`) |

La validation du portail a été **rejouée sur Node 8.12.0** (`node-v8.12.0-linux-x64`, OpenSSL 1.0.2p :
la pile de webOS 6 et non celle du poste de développement) : `testProfile` ok, import de 5 299 chaînes
en 1,5 s, page de 200 objets, détail sans secret, `resolveStream` puis lecture réelle du flux
(`HTTP 200 video/mp2t`, `0x47` tous les 188 octets), `diagnostics` annonçant `node: 8.12.0` —
`CONTROLE REUSSI`, code de sortie 0. La suite de tests y passe également : **149 tests, 0 échec** en
8.12.0.

Les trois pièces ont été **re-téléchargées depuis l'URL publique** et comparées octet à octet à la
construction locale (`ar t` du paquet téléchargé conforme). La release `v0.1.0-phase0a` est annotée
« version obsolète — ne pas installer ». `npm test` → **149 tests, 0 échec** ; `npm run verify` vert
(Node 8.12 inclus dans la CI).

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
