# Spécification technique — lecteur IPTV LG webOS TV 6+

**Version :** 1.3 — **Date :** 28 septembre 2026<br>
**Statut :** spécification de conception **et contrats d’implémentation** (§15), à valider sur téléviseurs réels<br>
**Langue de l’interface :** français par défaut, architecture prête pour la localisation<br>
**Révision 1.3 (contrats) :** corrige deux défauts P0 — dérivation de clé AES-GCM (§8.2, §15.3) et identité M3U (§5.3) — et transforme les intentions restantes en contrats exécutables : manifest et capacités webOS (§2.6), `ImportJob` persistant (§15.1), structure d’index et de recherche (§15.2), `streamRef → StreamResolution` (§6.1, §15.1), protocole LS2 et plafonds en octets (§15.4), machine d’état exacte (§15.5), verrouillage des dépendances transitives Node 8.12 (§2.3), navigation globale persistante (§3.1, §4.3), alphabet par stratégie de script (§9.1), EPG et état d’écran normalisés (§4.3, §15.1), découpage de la V1 en incréments (§1.4) et phase 0 en sous-étapes (§12). Détail en annexe B.<br>
**Révision 1.2 :** corrige les points de revue suivants — persistance M3U et consentement (§8.2), cible de compilation du service (§2.3), indexation Xtream (§5.1), clés M3U (§5.3), sonde MIME (§6.1), curseurs versionnés et coût disque (§2.4, §7.2), filtrage des URL de flux (§2.5, §6.1), saut alphabétique et RTL (§4.3, §9.1), trous du lecteur (§4.6), critères statistiques de go/no-go (§11.2, §12), contrôle de distribution en phase 0 (§12), magasin de certificats du Node embarqué (§2.5, §10). Détail en annexe A.

> But : développer un lecteur IPTV webOS clair, utilisable entièrement à la télécommande et réactif sur un téléviseur LG de gamme moyenne. L’application lit uniquement les sources fournies par l’utilisateur. Elle ne fournit ni playlist, ni chaîne, ni compte, ni contenu audiovisuel.

| Framework UI | **Enact 3.4.9 + Sandstone 1.4.6** pour couvrir webOS TV 6.0 | La matrice LG associe précisément webOS 6.0 à cette version. Enact 4 a abandonné le support de la génération TV 2021, donc ne convient pas à la borne minimale demandée. [S02][S03] |
| Langage | **TypeScript**, compilé en JavaScript pour la TV | Types pour les réponses Xtream/M3U/EPG incohérentes, refactorings plus sûrs ; Enact CLI prend en charge TypeScript. [S04] |
| Navigation télécommande | **`@enact/spotlight`**, intégré à Enact/Sandstone | Gestion de focus 5-way, des conteneurs et du mode pointeur ; les composants Sandstone navigables sont déjà intégrés à Spotlight. [S05][S06] |
| Réseau fournisseur | **Service JavaScript webOS** (Node.js 8.12 sur webOS 6) pour réseau/parsing, avec index compact et paginé des catalogues M3U/Xtream dans son répertoire privé | Sa mémoire n’est pas durable et le service peut être arrêté après inactivité ; son stockage de fichiers est distinct de DB8. Le TLS et les certificats du Node embarqué doivent être validés séparément du navigateur et du lecteur. Le service est compilé pour **Node 8.12 / ES2017**, cible distincte de celle de l’interface (§2.3). [S11][S32][S33] |
| Lecture | Élément **HTML `<video>` natif** et pipeline média webOS, URL de flux fournie par le profil | HLS est pris en charge, mais live MPEG-TS progressif, MIME, redirects, codecs et protocoles doivent passer la matrice phase 0 avant d’être annoncés comme compatibles. [S14][S15][S35] |
| Persistance | **DB8** pour profils, favoris, préférences et reprise ; **index catalogue compact sur disque privé du service** ; aucune passphrase obligatoire en V1 | La menace locale est explicitée §8. Les index/caches sont reconstruisibles ; DB8 ne reçoit pas tout le catalogue. Une source **M3U** ne peut pas fonctionner sans conserver ses URL de lecture : le consentement y est un **prérequis affiché**, pas une option, et l’index est chiffré au repos (§8.2). [S17][S19][S29][S33] |

**Prototype et go/no-go obligatoires avant l’UI complète :** tester Enact/Spotlight, LS2 et le stockage sur une TV webOS 6 ; confronter le service et le `<video>` à au moins deux portails Xtream autorisés et deux playlists M3U autorisées, couvrant MPEG-TS progressif, HLS, URL sans extension, redirect inter-hôte, HTTP, HEVC, AC-3/E-AC-3 et 1080i. S’y ajoutent trois vérifications **éliminatoires** : la politique LG pour une application qui lit des playlists fournies par l’utilisateur (§12, phase 0), le magasin de certificats du Node embarqué confronté à une racine récente (§2.5) et l’exécution du service sur un Node 8.12 épinglé (§2.3). Critères initiaux : **30 tentatives indépendantes par combinaison** déclarée supportée avec **≥ 29 premières images** (ou 20/20, §11.2), première image p95 ≤ 15 s **et p50 de zapping ≤ 4 s** (à calibrer) sur réseau de labo stable, aucune fuite de session visible après zapping. Le Simulator webOS 6.0 ne remplace pas le test TV. [S14][S15][S24][S35]

---


### 1.2 Inclus dans la V1

- Gestion locale d’un ou plusieurs profils fournisseur, un profil actif à la fois ; enregistrement des secrets selon le choix de persistance expliqué §8 — pour une source M3U, le consentement de persistance est requis avant tout import (§3.5).
- Live TV, catégories, chaînes, favoris et informations EPG courant/suivant.
- VOD, catégories, affiches/posters, recherche globale, saut alphabétique, fiche courte et lecture.
- Séries, catégories, recherche globale, saut alphabétique, fiche série, sélection de saison, liste d’épisodes et lecture.

- Fourniture, découverte, partage ou vente de playlists, identifiants ou chaînes.
- Contournement d’un DRM, d’un abonnement, d’une restriction régionale ou d’un contrôle d’accès.
- **Authentification par en-têtes personnalisés** : `Authorization`, cookie obligatoire, `Referer`/`User-Agent` imposés, poignée de main DRM propriétaire. Le `<video>` natif ne garantit pas l’envoi d’en-têtes arbitraires (§6.1) ; ces fournisseurs sont déclarés **non supportés en V1**, pas « à tester plus tard ».
- Enregistrement vidéo, timeshift/catch-up, contrôle parental, multi-écran, cast, téléchargement ou lecture hors ligne.
- Promesse de prise en charge de tout flux `.ts`, RTSP, RTMP, MPEG-DASH, de tout codec, ou de tous les tags HLS. Les limites webOS et du serveur source s’appliquent. [S14][S15]
- Publicités tierces avant consentement et intégration d’un SDK publicitaire dans cette spécification.

**Conformité :** l’utilisateur doit posséder ou être autorisé à utiliser les sources configurées. Les mentions légales, la politique de confidentialité et toute déclaration demandée par LG doivent être fournies avant distribution.

### 1.4 Incréments de livraison (le périmètre V1 ne se livre pas d’un bloc)

La V1 complète est une **cible**, pas un premier lot. Chaque incrément est utilisable seul, se teste sur TV et se termine par le même budget de qualité :

| Incrément | Contenu | Ce qu’il ne contient pas |
|---|---|---|
| **V1-A** | Xtream (profil, test, connexion) + Live TV (catégories, chaînes) + télécommande/Spotlight + lecteur + `streamRef` résolu + diagnostic local minimal | EPG, favoris, reprise, VOD, séries, M3U |
| **V1-B** | EPG (courant/suivant, correspondance, décalage) + favoris + reprise + VOD (grille, fiche, recherche, saut alphabétique) | séries, M3U, gros catalogues |
| **V1-C** | Séries (saisons, épisodes, recherche sur titres) + navigation globale persistante | M3U, gros catalogues |
| **V1-D** | **M3U** (second moteur de données, §5.2), gros catalogues (250 k/256 Mio), index chiffré, import reprenable, sélection de groupes | — |

Deux règles de découpage :

- **M3U n’est pas une variante de Xtream, c’est un second moteur de données.** Il porte sa propre identité (§5.3), sa propre classification, sa propre UX de séries (« best effort », §3.4) et son propre modèle de persistance (§8.2). Il arrive en V1-D, après que l’architecture (`ServiceCatalogStore`, `ImportJob`, chiffrement) a été validée sur un catalogue Xtream réel.
- Le **contrôle de distribution** (§12, phase 0) et le **banc de qualification média** (sous-ensemble « smoke », §11.2) sont en revanche des prérequis de V1-A : ils conditionnent la faisabilité du produit, pas une fonctionnalité.

L’utilisateur voit une seule application : les incréments sont un ordre de construction, pas des modes. Un écran absent de l’incrément courant (par ex. Séries en V1-A) est **masqué proprement** plutôt qu’affiché vide, et la page « À propos » indique la version réellement installée.

---

## 2. Recherche : choix du langage, framework et architecture
- Le tableau de compatibilité LG indique **Enact 3.4.9 / Sandstone 1.4.6** pour webOS 6.0. Enact 4 ne prend plus en charge les téléviseurs 2021 ou antérieurs : un build V1 commun webOS 6+ doit donc rester sur la branche Enact 3 validée, ou maintenir des builds distincts après essais. [S02][S03]
- webOS prend en charge deux modes de contrôle Magic Remote : pointeur et navigation 5-way. LG impose de concevoir aussi pour le 5-way ; les flèches et OK doivent suffire à accomplir tout le parcours. [S06]
- La lecture vidéo dépend de l’appareil, du manifeste, du codec, du profil, du débit et du serveur. L’émulateur/simulateur ne reproduit pas fidèlement toutes les capacités média du téléviseur. [S14][S15][S24]
- Le service dépend d’un **Node.js 8.12 embarqué** (version documentée par LG pour webOS 6), pas du Node courant : `fs.promises` n’existe qu’à partir de **Node 10.1**, l’itération asynchrone (`for await`) et `stream.pipeline` à partir de **Node 10.0**, Brotli (`zlib.createBrotliDecompress`) à partir de **Node 10.16**, `worker_threads` n’existe pas. Le service doit tenir dans le sous-ensemble ES2017/Node 8.12 et chaque API douteuse est bloquée par le lint de compatibilité (§2.3). [S36]
- Ce même Node embarque **OpenSSL 1.0.2p** : pas de TLS 1.3, pas de traitement des certificats signés en RSASSA-PSS, et un **magasin de racines figé à la date de build**. Chromium et le pipeline média ont leur propre magasin, mis à jour par firmware ; les trois piles se testent séparément (§2.5, §10). [S28][S36]

### 2.2 Comparaison des options

- Produire un paquet de production statique (bundles locaux, CSS et assets locaux) avec le build production Enact, qui minifie et regroupe le code de l’application. [S10] Pas de `import()`/chargement de chunks à l’exécution dans la V1 empaquetée ; pas de dépendance à un serveur web distant pour dessiner l’interface.
- Éviter les syntaxes et APIs plus récentes sans transpilation/polyfill vérifié sur webOS 6. Ne pas confondre transpilation TypeScript et polyfill des APIs navigateur.

**Deux cibles de compilation distinctes.** L’interface et le service ne s’exécutent pas sur le même runtime ; une cible unique est une source de bugs silencieux (le code compile, puis échoue sur la TV) :

| Cible | Runtime de référence | Cible TS / syntaxe | Contrôles |
|---|---|---|---|
| `ui/`, `application/`, `providers/` côté application | Chromium 79 (webOS 6) | `target: ES2018`, Browserslist `chrome 79`, parse AST `ecmaVersion: 2019` | syntaxe post-ES2018 non transformée, `String.prototype.replaceAll`, APIs absentes de Chromium 79 |
| `services/provider-service/` | **Node.js 8.12.0** (webOS 6) | `target: ES2017`, `lib: ES2017` | `for await`, `fs.promises`/`fs/promises`, Brotli, `worker_threads`, `stream.pipeline`, `Object.fromEntries`, `String.prototype.matchAll`, `Array.prototype.flat`/`flatMap`, `String.prototype.trimStart`, groupes de capture nommés, BigInt, `globalThis`, `import()` dynamique |

- Le service utilise les callbacks `fs` (ou une promisification locale ; `util.promisify` existe en Node 8.0) et lit les flux avec `on('data')`/`read()`, jamais `for await`.
- Deux configurations `tsconfig`, deux lints de compatibilité (`eslint-plugin-es` ou `eslint-plugin-n` avec `engines: node >=8.12.0` pour le service, Browserslist pour l’interface) et un contrôle CI par parse AST de chaque bundle livré.
- **CI :** exécuter les tests du service sur un **Node 8.12.0 épinglé** en plus du Node de développement, comme Chromium 79 épinglé pour l’interface. Cela garantit le sous-ensemble de langage et les API, **pas** le build LG lui-même : relever `process.versions` sur l’appareil en phase 0 et consigner tout écart.
- Node 8.12.0 est EOL et sans correctifs de sécurité. Risque accepté pour un service local **sans écoute réseau entrante**, à condition que les données fournisseur restent traitées comme non fiables (bornes de taille, parseurs sans `eval`, aucune commande shell) et que la limite soit divulguée dans la page confidentialité. Toute API Node introduite plus tard exige une nouvelle mesure sur l’appareil.
- Compressions : annoncer `Accept-Encoding: gzip, deflate, identity` (jamais `br`) ; si un fournisseur répond malgré tout en Brotli, échouer proprement avec un message explicite plutôt que de tenter une décompression indisponible.

**Dépendances du service : verrouiller l’arbre entier, pas seulement son propre code.** Le risque n’est pas le TypeScript écrit à la main mais les bibliothèques : `A → B → C` où C utilise une API Node moderne. Le code compile, les tests passent sur Node 20, et l’échec n’apparaît que sur la TV.

- **Objectif par défaut : zéro dépendance d’exécution** pour `services/provider-service/` — le service n’utilise que `http`, `https`, `zlib`, `crypto`, `fs`, `net`, `tls`, `url`, `buffer`, `stream`. Un parseur M3U/XMLTV incrémental s’écrit à la main, ce qui est de toute façon préférable ici (§2.4). Toute exception est justifiée par écrit dans le dépôt.
- Si une dépendance d’exécution devient nécessaire : vérifier son champ `engines`, puis l’**analyser avec le même lint AST** que le code du service, et l’exécuter dans la CI Node 8.12 sur **l’arbre complet du lockfile** (`npm ci`, jamais `install`) — c’est cette exécution qui vaut preuve, pas la déclaration `engines`.
- `devDependencies` (TypeScript, ESLint, test runner) peuvent utiliser du Node récent : elles ne sont pas livrées. La frontière doit être vérifiée par un contrôle qui échoue si un paquet de `dependencies` finit dans le bundle du service.
- Installer avec `--ignore-scripts` : aucun `postinstall` de dépendance ne doit s’exécuter sur le poste ni dans la CI du service.
- Les dépendances d’**interface** suivent la même logique contre Chromium 79 : contrôle Browserslist + parse AST sur l’arbre réellement regroupé (§2.3, premier tableau), pas seulement sur les fichiers du projet.

### 2.4 Architecture retenue

Architecture en couches et adaptateurs (ports/adapters), sans serveur cloud obligatoire :
- `epg/` : adaptation XMLTV/Xtream, correspondance chaîne-programmes et sélection courant/suivant.
- `platform/webos/` : LS2, cycle de vie, DB8, état réseau, saisie/clavier virtuel, clés système, capacités média.
- `services/provider-service/` : service JS webOS compact pour les requêtes fournisseur et traitements hors UI ; Node.js 8.12.0 est la version documentée pour webOS 6. [S11]
- `ServiceCatalogStore` : index compact M3U et index de recherche pour catalogues Xtream en fichiers du service, écrit/relu par pages ; quand l’API Xtream ne pagine pas, ingérer son tableau JSON par flux/parseur incrémental vers le même index. Chaque index porte un **`indexVersion`** monotone ; toute page, recherche ou tranche alphabétique renvoie cette version et tout curseur est un couple `(indexVersion, offset/ancrage)` exploitable uniquement sur cette version — jamais un « dernier offset » implicite. Le processus peut disparaître entre deux appels et n’est jamais la source de durabilité. DB8 ne reçoit que profils, préférences, favoris, correspondances et reprises.
- `player/` : interface `PlayerAdapter` et implémentation `NativeHtmlVideoPlayer`. L’UI du lecteur ne connaît pas les détails du fournisseur.

Le service JS webOS ne doit pas être un serveur de longue durée ni un proxy ouvert. LG documente son lancement à la demande et un délai d’inactivité de 5 s sans activité LS2 ; un service actif ne doit pas être supposé persister en mémoire après une réponse. Il s’exécute dans un environnement isolé ; ses fichiers peuvent être conservés sous `/media/internal` et réutilisés avec le même UID. [S11][S32][S33]

- `services.json` n’expose que des commandes étroites (`importPlaylist`, `getPage`, `getBuckets`, `cancelOperation`, etc.) ; toutes renvoient l’`indexVersion` utilisée. Conserver `public:false` (valeur par défaut) et ne jamais publier un proxy générique. Vérifier sur TV les règles effectives d’appelant/LS2 et n’accepter que l’ID de profil et les opérations attendues. [S34]
- Un import garde une requête/abonnement LS2 active uniquement tant que l’utilisateur le suit, publie la progression et accepte une annulation ; ne pas installer un keep-alive permanent ni laisser le service travailler en arrière-plan. LG déconseille les services qui restent actifs plusieurs minutes. [S32][S33]
- Favoriser chunks HTTP Range/ETag si le serveur les supporte et checkpoint d’index temporaire ; sinon un seul flux asynchrone peut rester actif pendant l’import, mais son temps/RSS doivent passer la qualification phase 0. Si la TV termine le service ou si la durée sûre est dépassée, supprimer la transaction temporaire, garder l’ancien index et proposer de reprendre/recommencer. Le process peut rouvrir l’index validé au prochain appel.
- **Bascule atomique, rétention et budget disque.** L’index précédent reste lisible après la bascule tant qu’un lecteur (requête LS2 en vol) le référence, avec une rétention bornée (valeur de départ 30 s) ; ensuite, les nouveaux lecteurs visent la version courante ou reçoivent `catalog/indexChanged` (§7.2). Pendant un import, le disque porte donc **l’ancien index + le nouvel index + les fichiers temporaires**, soit environ deux fois la taille de l’index plus l’entrée : le quota de sécurité se calcule sur `2 × index + marge`, pas sur l’index seul, et le test de capacité de 256 Mio mesure ce pic réel. Séquence : `catalog-<version>.tmp` → validation (décompte, empreinte) → `fsync` → `rename` → écriture atomique du manifeste. Au démarrage du service, supprimer les `.tmp` orphelins et toute version non élue par le manifeste.
- Le service parse M3U/XMLTV en flux et par lots sur son event loop, **sans `for await` ni `fs.promises`** (§2.3) ; pas de `worker_threads` requis ni supposé sur Node 8.12. Toute étape CPU longue cède la main régulièrement pour traiter annulation, progression et appels LS2.
- Les méthodes LS2 imposent pagination/chunks bornés ; le service limite tailles reçues et répond, ferme les requêtes annulées et n’écrit jamais d’identifiants ou d’URLs authentifiées dans ses logs.

### 2.5 Paquet empaqueté, CORS et accès fournisseur

**TLS par pile :** le tableau LG confirme TLS 1.2/1.3 au niveau webOS, mais cela ne prouve pas que le client HTTPS du service Node 8.12 négocie TLS 1.3 ou utilise le même magasin de certificats que Chromium/le pipeline média. Le tag Node.js 8.12.0 upstream embarque OpenSSL 1.0.2p, qui ne fournit pas TLS 1.3 ; le build LG peut différer et n’est pas documenté à ce niveau. Lire uniquement la version non sensible `process.versions.openssl` sur l’appareil, puis tester la même API sur TLS 1.2, TLS 1.3-only et certificats publics représentatifs. Exiger TLS 1.2 comme baseline du service ; annoncer TLS 1.3 que si le prototype appareil le démontre. Aucun contournement TLS ni ajout silencieux de CA privée. [S28][S36]

**Magasin de racines du service (risque de fraîcheur) :** le bundle de CA du Node 8.12 embarqué est figé à la date de build du firmware : une chaîne qui aboutit à une racine publiée plus tard ne valide pas, alors que Chromium ou le média peuvent réussir (magasin distinct, mis à jour par firmware). Cas typique : chaînes ECDSA terminant sur **ISRG Root X2 (2020)**, ou toute racine apparue après 2018. La phase 0 doit donc inclure un hôte dont la chaîne **échoue** avec un bundle de 2018, en plus des cas TLS 1.2, TLS 1.3-only, certificat absent de l’appareil et horloge TV fausse, et consigner le résultat séparément par pile. Remède retenu pour la V1 : **embarquer un bundle de racines publiques à jour** (par ex. celui de Mozilla, ~200 Ko, licence et date tracées) et le passer au client HTTPS du service via l’option `ca`, vérification du nom d’hôte conservée. Ce n’est pas un contournement : aucune CA privée, aucun `rejectUnauthorized: false`, aucun élargissement silencieux de la confiance ; le bundle est mis à jour avec l’application, et le pipeline média — sur lequel l’application n’a pas de prise — reste un état d’erreur distinct (§7.2). [S28][S36][S39]

**Protection contre URL malveillantes/redirects :** toutes les URL M3U/EPG/stream sont non fiables. Pour les appels HTTP exécutés par le service, limiter les redirects à 5, revalider schéma/port/hôte à chaque saut, résoudre chaque nom et épingler l’IP publique validée via le callback DNS du client HTTP ; bloquer loopback, link-local, multicast et plages privées par défaut. Pour un serveur LAN, demander une autorisation explicite par profil et ne pas autoriser les redirects hors de cette plage. Ne jamais transférer `Authorization`/cookies à un autre origin. **Pour les URL de flux remises au `<video>`**, cette politique ne peut pas être appliquée par le service (aucun hook) : elle est approximée par le marquage d’hôte à l’indexation (§5.2) puis le contrôle avant affectation de la source (§6.1), avec les limites de cette approximation.

**Limite du `<video>` natif :** le media pipeline résout DNS et suit ses redirects lui-même ; l’app n’a pas de hook documenté pour pinner l’IP au socket. Avant de lui donner une URL, appliquer un contrôle best-effort de schéma/host et tester les redirects connus ; signaler explicitement que l’app ne peut ni pinner l’IP ni garantir l’inspection de chaque redirect du chemin média sans proxy. N’accepter que les URLs du profil actif/import choisi, jamais une URL issue d’un champ HTML arbitraire. Si une menace SSRF forte est exigée, réévaluer un relais local opt-in plutôt que prétendre au pinning complet.


Un relais distant n’est **pas** le comportement par défaut.

### 2.6 Manifest et capacités webOS (contrat, pas intention)

Cette section est la source de vérité pour `appinfo.json`, `services.json` et les permissions. Elle est écrite pour être copiée dans le projet, puis **vérifiée sur TV** avant d’ajouter une API.

**Contraintes de nommage à respecter dès le premier commit** (elles sont coûteuses à changer après publication) [S34][S37] :

- `id` : `com.<éditeur>.app.<nom>`, minuscules/chiffres/points, sans tiret ni « .nombre » si l’application embarque un service JS (Luna refuse ces caractères dans un nom de service, et **le nom du service doit commencer par l’ID de l’application**) — par ex. ID `com.exemple.app.iptvplayer` → service `com.exemple.app.iptvplayer.service`.
- Préfixes réservés interdits : `com.palm`, `com.webos`, `com.lge`, `com.palmdts`. L’ID ne change plus après publication.
- `version` : trois entiers séparés par des points, sans zéro de tête ; une version publiée ne peut pas être réutilisée.

**`appinfo.json` minimal (application empaquetée)** — propriétés documentées uniquement :

```json
{
  "id": "com.exemple.app.iptvplayer",
  "version": "0.1.0",
  "vendor": "Éditeur",
  "type": "web",
  "main": "index.html",
  "title": "Lecteur IPTV",
  "icon": "assets/icon_80x80.png",
  "largeIcon": "assets/icon_130x130.png",
  "resolution": "1920x1080",
  "splashBackground": "assets/splash.png",
  "splashColor": "#0b1220",
  "transparent": false,
  "disableBackHistoryAPI": false,
  "handlesRelaunch": true,
  "requiredMemory": 40,
  "accessibility": {
    "supportsAudioGuidance": true
  },
  "requiredPermissions": [
    "time.query"
  ]
}
```

- `disableBackHistoryAPI: false` : la pile History est utilisée (§4.5) ; passer à `true` seulement après un test qui le justifie.
- `supportsAudioGuidance` est **imbriqué dans l’objet `accessibility`** — ce n’est pas une propriété racine (vérifié dans la référence appinfo.json). [S37]
- `handlesRelaunch: true` : l’application traite `webOSRelaunch` sans réinitialiser son état (§10).
- `requiredMemory` : valeur prudente à ajuster après mesure ; ce n’est pas un quota garanti.

**`services.json` (service JS)** — schéma réel : un tableau `services[]` portant `name`, `description` et un tableau **`commands[]`** (et non `methods`), chaque commande ayant `name`, `description?`, `public` (défaut `false`) [S34] :

```json
{
  "services": [
    {
      "name": "com.exemple.app.iptvplayer.service",
      "description": "Réseau fournisseur, index catalogue local",
      "commands": [
        { "name": "testProfile",     "public": false },
        { "name": "importPlaylist",  "public": false },
        { "name": "getImportJob",    "public": false },
        { "name": "cancelOperation", "public": false },
        { "name": "getPage",         "public": false },
        { "name": "search",          "public": false },
        { "name": "getBuckets",      "public": false },
        { "name": "getDetails",      "public": false },
        { "name": "resolveStream",   "public": false },
        { "name": "deleteProfile",   "public": false }
      ]
    }
  ]
}
```

Aucune commande `public: true` : le service n’est appelable que par son application. Aucun proxy générique, aucune commande acceptant une URL ou un chemin arbitraire. Les signatures exactes sont au §15.4.

**Permissions (ACG) :**

- `requiredPermissions` est un **tableau de noms d’ACG** correspondant aux méthodes LS2 réellement appelées — pas une liste de fonctionnalités. Chaque nom se lit dans la référence de l’API concernée ; on ne copie pas une liste d’exemple trouvée sur un forum.
- Appels LS2 attendus ici : horloge (`time.query`) si nécessaire, DB8 pour l’application (`com.webos.service.db` et ses ACG), et réception des événements de cycle de vie via `com.webos.service.applicationmanager`. **Chaque ACG ajoutée doit être justifiée par un appel réel dans le code** ; un `requiredPermissions` surdimensionné est un motif de remarque en revue.
- Le service JS n’a **pas** de permission réseau particulière à déclarer pour ses requêtes HTTP sortantes ; en revanche il ne doit écouter sur aucun port (§2.4). À confirmer en phase 0A : appeler `player_api.php` depuis le service et vérifier les journaux LS2.
- La référence appinfo.json TV actuelle **ne liste plus** `requiredPermissions` dans sa table de propriétés (la propriété reste documentée côté webOS OSE et utilisée par les applications système). Conséquence pratique : la traiter comme **à valider en phase 0A** (`ares-install` + journaux LS2) et consigner dans le dépôt le nom exact des ACG acceptées. [S34][S37][S40]

**Chemins et capacités :**

| Élément | Contrat |
|---|---|
| Paquet | `.ipk` produit par `ares-package`, installé par `ares-install` (mode développeur) ; premier écran servi depuis le paquet, aucun serveur distant (§0). |
| Stockage du service | Répertoire privé du service sous `/media/internal`, même UID entre exécutions ; aucune écriture hors de ce répertoire (§8.1). [S33] |
| DB8 | `kinds` préfixés par l’ID de l’application et versionnés : profils, préférences, favoris, correspondances EPG, reprises, `ImportJob` et clé maître de profil (§15.3). Jamais le catalogue. [S17] |
| Réseau entrant | Interdit : le service ne bind aucun port et n’expose aucun serveur local. |
| Réseau sortant | HTTP/HTTPS via le service uniquement (§2.5) ; le `<video>` garde son propre chemin média. |
| Audio guidance | `accessibility.supportsAudioGuidance` + ARIA (§9.1), vérifié sur TV avec l’option activée. |

**Règle finale :** toute capacité non démontrée en phase 0 n’est pas promise. Le tableau ci-dessus est le contrat minimal vérifiable ; toute ligne non validée sur TV reste marquée « non certifiée » dans le diagnostic local.

---

## 3. Parcours et exigences fonctionnelles

Chaque carte a un intitulé lisible, une icône simple, un état de focus très visible et un aperçu visuel discret. Le profil actif peut être indiqué dans l’en-tête. Si aucun profil n’est configuré, les sections de contenu expliquent qu’une source est nécessaire et le focus peut aller directement vers **Profil**, sans supprimer les quatre entrées.

**Navigation globale persistante sur les écrans de contenu.** L’accueil à quatre cartes reste la porte d’entrée, mais une **barre discrète** en haut des écrans Live/VOD/Séries/Profil permet de passer d’une section à l’autre sans repasser par l’accueil :

```text
┌──────────────────────────────────────────────────────────────┐
│  Live TV   VOD   Séries   Profil            [profil actif]    │  ← barre persistante
├─────────────┬──────────────────────────┬─────────────────────┤
│ Catégories  │ Contenu                  │ EPG / détail        │
└─────────────┴──────────────────────────┴─────────────────────┘
```

- Position : **en haut**, hauteur réduite, sans icônes superflues ; la section courante est marquée par un état actif (pas seulement par la couleur).
- Accès au D-pad : **Haut depuis le premier élément de chaque panneau** atteint la barre ; Haut/Bas y circulent ; OK change de section ; Bas revient au panneau d’origine **avec le focus et l’état conservés** (§4.3, §15.1).
- Chaque section conserve son propre `ScreenState` (catégorie, requête, scroll, focus) : changer de section puis revenir doit rendre l’écran tel qu’il était.
- La barre **n’existe pas** dans le lecteur (l’immersion prime, Retour suffit) ni dans les dialogues ; elle est masquée sur l’accueil, où les quatre cartes jouent ce rôle.
- En RTL, la barre est ordonnée de droite à gauche et l’ordre logique des sections est préservé (§9.1).
- Cas sans profil : la barre reste affichée mais les sections de contenu sont inertes et renvoient vers Profil avec une explication, jamais un écran vide muet.

### 3.2 Live TV

Disposition cible en 16:9 :
### 3.3 VOD

- Catégories à gauche ; à droite, la plus grande zone d’écran est une grille virtualisée de films.
- En tête de la grille : recherche globale sur tous les films des catégories visibles du profil, saisissable au clavier virtuel, plus saut alphabétique dont les **tranches viennent des scripts réellement présents dans les données indexées** (§9.1) — pas de la locale de l’interface : un catalogue arabe avec interface française affiche les tranches arabes. Utilisable au D-pad ; résultat limité et paginé par le service.
- Debounce de recherche de 250 ms, annulation des requêtes obsolètes, accents/casse normalisés ; OK sur un résultat ouvre sa fiche et Back restaure query, lettre, catégorie, scroll et focus.
- Poster de taille modérée, jamais une affiche plein écran dans la grille. Afficher le titre et, si disponibles, année/durée/notation ; les données manquantes ne doivent pas créer de trous visuels.
- La grille doit rester parcourable si les posters sont absents ou lents : placeholder immédiat, chargement différé, image de repli en cas d’échec.
### 3.4 Séries

- Catégories à gauche ; grille de séries virtualisée dans le panneau principal.
- Recherche globale sur toutes les séries des catégories visibles et saut alphabétique sur les scripts présents dans les données (§9.1), avec même comportement D-pad, clavier virtuel, pagination, debounce et restauration d’état que la VOD.
- **Portée explicite de la recherche :** elle porte sur les **titres de séries**, pas sur les épisodes. Xtream n’expose les épisodes que par le détail d’une série (`get_series_info&series_id`) ; l’index global ne les couvre donc pas et l’écran de recherche doit le dire (« les épisodes se trouvent dans la fiche de la série »). Aucun compteur « N résultats » ne doit suggérer une recherche exhaustive sur les épisodes.
- OK sur une série ouvre une fiche de série (nom, visuel, synopsis si disponible) et le choix de saison.
- Après choix de saison, afficher les épisodes ; chaque ligne/card indique numéro, titre, durée ou résumé si présents.
- OK sur un épisode ouvre le lecteur. À la fermeture, restaurer la série, la saison, l’épisode sélectionné et la position de scroll.
- URL EPG XMLTV facultative ; sinon utiliser l’URL `url-tvg`/`x-tvg-url` détectée si elle existe.
- Boutons **Tester**, **Importer/actualiser** et **Enregistrer**. Afficher le nombre d’entrées/groupes trouvés, progression, taille estimée et avertissements de parsing.
- Après découverte des groupes, permettre d’indexer tous les groupes ou de n’en garder qu’un sous-ensemble ; cette sélection locale sert de solution de repli quand un catalogue est trop volumineux, sans demander au fournisseur de le modifier.
- **Persistance (M3U) : la règle dépend de la présence réelle de secrets.** Toutes les playlists ne portent pas des identifiants : `https://cdn.exemple.com/chaîne.m3u8` est une URL publique. La v1.2 imposait la persistance à *toute* source M3U, ce qui était trop absolu. Règle v1.3, décidée **par analyse à l’import** (jamais par supposition) :

| Cas détecté | Persistance | Consentement |
|---|---|---|
| Au moins une URL de lecture porte des identifiants (userinfo, segment de chemin de type `user/pass`, `?username=`/`?token=`, segment en base64 long) | **Nécessaire** : sans elle, il faudrait retélécharger et réindexer jusqu’à 256 Mio à chaque lancement | **Prérequis affiché avant l’import** : « Cette source ne fonctionne qu’en conservant ses adresses sur ce téléviseur (stockage privé de l’application, chiffré, effacé avec le profil) » → accepter, ou renoncer à cette source |
| Aucune URL de lecture ne porte d’identifiant (CDN public) | Facultative : le catalogue reste utilisable après un simple retéléchargement | Consentement **non bloquant** ; l’écran explique simplement que le profil et son index sont enregistrés localement et effacés avec le profil |
| Cas mixte (certaines lignes avec identifiants) | Traité comme le premier cas | Le drapeau est calculé **par entrée** (`hasCredential`) et exposé au diagnostic sans jamais afficher l’URL |

L’exception « préfixe d’identifiants commun » (§5.2) reste une optimisation de confort et **ne dispense pas du consentement** : elle réduit ce qui est stocké, elle ne supprime pas le secret.

**Préférences locales du profil**
- Masquer/afficher et réordonner les catégories live, VOD et séries ; écran de rétablissement des catégories masquées et retour à l’ordre fournisseur.

### 4.3 Carte de focus par écran

Les règles ci-dessous sont écrites en **termes logiques** (« vers le panneau catégories », « vers le panneau EPG », « vers la fiche ») : en RTL, le layout se miroite et ces destinations s’inversent d’elles-mêmes, les touches restant physiques. Aucune règle ne doit être écrite « droite/gauche » sans nommer la destination logique correspondante.

| Écran | Règles de focus (logiques ; miroir appliqué en RTL) |
|---|---|
| Accueil | Grille 2 × 2 ou rangée de quatre cartes selon résolution ; déplacement naturel, focus initial sur le profil actif ou Live si configuré. |
| Barre de navigation globale | Présente sur les écrans de contenu (§3.1), atteinte par **Haut depuis le premier élément de chaque panneau**. Gauche/droite parcourent les sections dans l’ordre logique (miroir en RTL) ; OK change de section ; Bas rend le focus au panneau d’origine, à sa position mémorisée ; pas de wrap circulaire. Haut depuis la barre ne fait rien (le focus reste au bord). La barre n’est jamais atteinte par Bas depuis un panneau. |
| Live catégories | Haut/bas dans les catégories ; **vers le panneau chaînes** (droite en LTR, gauche en RTL) ; l’autre direction ne quitte pas la page ; Haut en tête de liste atteint la barre de navigation. |
| Live chaînes | Haut/bas dans la liste virtualisée ; **vers le panneau catégories** (bord amont) ; **vers le panneau EPG** (bord aval) ; si aucune action EPG n’est disponible, rester dans le panneau ; Haut en tête de liste atteint la barre. La colonne EPG est prioritaire ; aucun espace publicitaire vide n’est focalisable. |
| Panneau EPG (Live) | Le panneau entier est une **zone focalisable unique** dont le focus initial est le titre du programme courant. Haut/bas y défilent le contenu en respectant l’ordre : programme courant (titre, horaires, progression, description courte) → **programme suivant** → description longue avec « Lire la suite » focalisable. OK sur « Lire la suite » déplie le texte et laisse la même position de focus ; Retour replie. Gauche ramène au panneau chaînes ; Haut en tête du panneau atteint la barre de navigation. Quand le panneau est trop court pour défiler, Haut/Bas restent sans effet visible (pas de vol de focus). Le panneau se met à jour à la sélection dans le panneau chaînes, **sans prendre le focus** si l’utilisateur est ailleurs. |
| VOD / Séries | Haut/bas/gauche/droite dans la grille ; **depuis le bord amont de la grille, vers le panneau catégories** ; Haut au bord supérieur de la grille atteint la barre de navigation ; entrée dans une fiche par OK ; le retour restaure l’élément. |
| Fiche série | Focus initial sur les saisons ; **vers la liste d’épisodes** (côté aval) ; haut/bas dans la colonne ; OK confirme la saison/l’épisode. |
| Fiche VOD | Ordre : Lire, Favori, Retour/fermer ; jamais de focus derrière la modalité. |
| Profil | Formulaire vertical ; OK active le clavier virtuel ; le curseur système peut apparaître, mais les autres champs et actions restent D-pad accessibles ; Haut au premier champ atteint la barre de navigation. |
| Dialogues | Focus piégé dans le dialogue, bouton principal mis en évidence ; Retour ferme ou annule selon le contexte, aucune suppression directe. |
| Lecteur | La vidéo ne capte jamais le focus. Overlay masqué : flèches appliquent les règles de zap/seek du §4.6 ou le font apparaître sans action destructive ; overlay affiché : flèches déplacent le focus dans les contrôles (barre de progression comprise) et OK active. Retour quitte le lecteur. **Exception au miroir : le lecteur conserve l’axe temporel gauche→droite et un mapping physique des flèches de seek, dans toutes les locales (§4.6).** La barre de navigation globale n’existe pas dans le lecteur. |

### 4.4 Répétition, pressions longues et protection contre les doubles actions


### 4.6 Comportement spécifique du lecteur

- **Règle overlay unique :** overlay masqué, seules les flèches contextuelles exécutent une action de lecture (zapping/seek) ; toutes les autres touches directionnelles affichent l’overlay sans action secondaire. Overlay visible, les flèches déplacent le focus parmi les commandes, **sauf lorsque la barre de progression a le focus : elle consomme alors Gauche/Droite pour ajuster la position** (comportement slider, point ci-dessous) ; OK active le contrôle focalisé. Retour quitte le lecteur dans les deux états.
- **Live sans DVR** : overlay masqué, Haut/Bas demandent chaîne précédente/suivante dans la **file de lecture** définie ci-dessous ; Gauche/Droite affichent l’overlay. **Live avec fenêtre DVR seekable** : overlay masqué, Gauche/Droite sautent de 10 secondes ; Haut/Bas zappent. Ne jamais seek dans un direct sans `seekable`.
- **VOD / épisode** : overlay masqué, Gauche/Droite font un saut de 10 secondes si le média est seekable ; Haut/Bas affichent l’overlay. Un maintien répète le seek de façon bornée, sans `playbackRate` autre que 1.0.
- **Seek précis — la barre de progression est un contrôle focalisable** (slider) : overlay visible, la focaliser (Haut/Bas circulent entre les rangées de contrôles), Gauche/Droite ajustent la position cible — pas de 10 s, répétition bornée, puis accélération 30 s/60 s après maintien mesuré ; le code temporel cible s’affiche au-dessus de la barre et OK reprend la lecture à cette position. C’est le chemin garanti pour un seek précis au D-pad ; seek borné à `video.seekable`, jamais de `playbackRate` ≠ 1.0, pas d’affichage de durée infinie (§6.3).
- **Sens des flèches et RTL** : dans le lecteur, l’axe temporel de la barre de progression reste **gauche→droite** et les flèches gardent un sens **physique** (Gauche = retour dans le temps, Droite = avance) dans toutes les locales. C’est la convention des lecteurs vidéo et la seule qui ne rende pas le geste contradictoire avec le contrôle ; le reste de l’habillage (ordre des boutons, titres, panneaux) se miroite normalement (§9.1). QA RTL explicite sur ce point.
- **Séquence de zapping = file de lecture explicite**, transmise au lecteur à l’ouverture et mémorisée dans l’état d’historique ; « la catégorie visible » n’est qu’un des cas :
  - depuis une catégorie Live : chaînes visibles de cette catégorie, dans l’ordre affiché ;
  - depuis **Favoris** : favoris dans l’ordre affiché (liste inter-catégories ; on ne « saute » pas implicitement d’une catégorie à l’autre, on suit la liste de favoris) ;
  - depuis une **recherche globale** : la liste de résultats affichée, dans son ordre, sans relancer la recherche ni changer de catégorie ;
  - depuis une **fiche série** : épisodes de la saison courante (Haut/Bas = épisode précédent/suivant) ;
  - depuis une grille VOD : la liste affichée de la catégorie courante.
  Les catégories masquées et les entrées sans `streamRef` résolu sont exclues ; pas de wrap en bout de file ; un toast nomme la file au premier zap (« Favoris », « Résultats », « Saison 2 »). Retour restaure exactement l’écran d’origine et sa file.
- **Coalescence et fermeture du flux** : déplacer la sélection UI immédiatement, mais n’ouvrir le flux demandé qu’après 400 ms sans nouvelle touche (valeur de départ 300–500 ms). Garder seulement la dernière demande pendant cette fenêtre. Sérialiser le changement : arrêter/annuler l’ancienne session, retirer sa source et attendre `emptied` ou un timeout borné avant d’affecter la nouvelle URL. Aucun deuxième `<video>`/décodeur ne doit rester actif.
- La barre de commandes disparaît après temporisation uniquement si le focus n’est pas sur un contrôle. Une touche non contextuelle la réaffiche. Afficher les raccourcis la première fois ; ne pas les laisser invisibles.
- Au Back, arrêter proprement le flux et faire de la dernière chaîne réellement lancée la sélection restaurée. Revenir à **l’écran d’origine de la file** — sa catégorie pour un lancement depuis une catégorie, la liste Favoris pour un lancement depuis Favoris, la liste de résultats pour un lancement depuis la recherche — même si cet écran diffère de celui où l’utilisateur était avant lecture ; retrouver index/scroll ; si la liste a changé, choisir le voisin le plus proche et montrer une indication discrète.

---

Xtream-compatible et M3U ne doivent pas être codés en dur dans les vues. Chaque profil expose une interface commune :

```text
ProviderAdapter                       // définition normative : §15.1
  testConnection(profile)             // → TestResult
  getCategories(contentType)          // → Category[]
  getItems(contentType, categoryId, cursor?)      // → CatalogPage<CatalogItem>
  getBuckets(contentType)             // → BucketSet   (alimente AlphabetNavigator)
  searchItems(contentType, normalizedQuery, cursor?)   // → CatalogPage<CatalogItem>
  getDetails(contentType, ref)        // → CatalogDetail (seule source des descriptions longues)
  getEpg(channelRef, range)           // → Program[]
  resolveStream(ref, requestedFormat) // → StreamResolution (donnée de session, §6.1)
  startRefresh(profileId, options)    // → { jobId }  (suit ImportJob, §15.5)
```

Les actions et champs Xtream sont une convention de facto, non une API unique garantie. Tester la réponse réelle, gérer identifiants en nombre ou chaîne, champs manquants, versions de noms (`series_id`, par exemple) et variantes EPG ; ne jamais supposer que toute réponse 200 est un JSON valide.

**Appels courants à encapsuler dans l’adaptateur Xtream-compatible :** authentification `player_api.php`, catégories live/VOD/séries, listes filtrées par `category_id`, détail VOD, détail série avec saisons/épisodes, EPG court ou XMLTV. Les URL de flux sont construites séparément à partir du format/identifiant communiqué par le fournisseur, sans stocker la chaîne d’URL dans les logs.

Xtream ne fournit pas toujours une pagination ni une recherche serveur. Respecter les pages si l’API les propose.

**Indexation : l’appel « tous les flux » d’abord, la catégorie ensuite.** Les portails Xtream exposent `get_live_streams`, `get_vod_streams` et `get_series` **sans filtre de catégorie** : c’est la voie par défaut — trois appels de liste plus les trois listes de catégories — ingérée par parseur de tableau incrémental vers `ServiceCatalogStore`. Le découpage **par catégorie** (`get_live_streams_by_category`, etc.) n’est qu’un **repli** : portail qui refuse ou limite l’appel global, quotas par réponse, reprise après échec, ou sélection volontaire d’un sous-ensemble de groupes. Des centaines de catégories multiplieraient les requêtes, exposeraient aux 429 et allongeraient une indexation que la TV ne peut pas poursuivre en arrière-plan (§2.4, §7.3). Les deux voies alimentent le même index versionné ; la reprise se fait par lots (offsets de page ou de catégorie), jamais par un état en mémoire.

Ne jamais appeler `JSON.parse()` sur une réponse entière potentiellement géante ni conserver tous les objets en mémoire. L’index de recherche reste **attaché à la souscription LS2 au premier plan** : il publie sa progression, s’annule, se reprend, et l’interface signale « résultats incomplets » tant que l’indexation n’est pas terminée.

**Portée de la recherche :** chaînes, films et **titres de séries**. Les **épisodes** ne sont pas indexés globalement, car Xtream ne les expose que par le détail d’une série (`get_series_info&series_id`) ; l’écran de recherche l’indique et l’épisode reste accessible par la fiche série (§3.4). Aucun compteur « N résultats » ne doit suggérer une recherche exhaustive sur les épisodes.

**La recherche n’est pas un `filter()`.** Elle s’appuie sur l’index trié et l’index de préfixes décrits au §15.2 (recherche binaire sur préfixe épars puis balayage borné), avec pour objectif **p95 ≤ 250 ms jusqu’à la première page** sur le catalogue de 250 000 entrées, en respectant le debounce de 250 ms. Aucun parcours linéaire du catalogue, aucun tri en mémoire, aucune construction de tableau de résultats complet : la page est bornée en objets **et** en octets (§15.2).

### 5.2 Import M3U

- Pour l’import, borner les redirections (maximum initial de 5), revalider le schéma et l’hôte à chaque saut, ne jamais transférer `Authorization`/cookies à un autre hôte et demander confirmation avant un downgrade HTTPS→HTTP. Refuser loopback par défaut ; les serveurs LAN privés peuvent être autorisés explicitement par l’utilisateur, car ils sont un cas d’usage possible.
- Détecter les doublons par identifiant/URL de source ; ne pas supprimer deux chaînes distinctes au seul motif qu’elles ont le même nom.
- Ne pas télécharger simultanément toutes les images. Charger les logos/posters à la demande et limiter l’activité réseau.
- **Marquage des URL de flux non sûres.** À l’indexation, analyser l’hôte de chaque URL de lecture et marquer les entrées dont l’hôte est une **adresse IP littérale** privée (`10/8`, `172.16/12`, `192.168/16`), loopback (`127/8`, `::1`), link-local (`169.254/16`, `fe80::/10`, métadonnées `169.254.169.254`), CGNAT (`100.64/10`), `0.0.0.0`, multicast, ou IPv4 encapsulée dans IPv6 — y compris en notation décimale compacte, octale ou hexadécimale (`2130706433`, `0177.0.0.1`). Ces entrées ne sont pas jouables sans **autorisation LAN explicite du profil** (§2.5). Les **noms d’hôte** qui résolvent vers une adresse privée restent un risque résiduel assumé : le pipeline média résout lui-même son DNS et l’application ne peut pas épingler l’IP (§6.1).
- **Détection des secrets et persistance.** À l’import, chaque ligne est classée `hasCredential` (userinfo, segment de chemin de type `user/pass`, `username=`/`token=` en requête, segment base64 long) et `hostSafety` (§ci-dessus). L’ensemble décide de la règle de persistance §3.5 — jamais l’inverse. Tester en plus si les URL de lecture partagent un **préfixe porteur d’identifiants** (cas courant `http://hôte:port/utilisateur/motdepasse/…`) : si oui, l’index peut ne conserver que la partie non secrète (identifiant de flux, extension, forme d’URL) et l’URL est reconstruite à la lecture depuis l’URL de playlist fournie en session (`derived`). Cette détection est une **optimisation de confort, pas une garantie** : elle est consignée sans secret, tout échec de reconstruction redemande l’URL de playlist à l’utilisateur, et une source sans secret peut être conservée sans consentement bloquant.
- **Tranches alphabétiques dans les données.** L’index mémorise par entrée le **script dominant** du titre normalisé et les compteurs par tranche (§9.1), afin que le saut alphabétique se calcule sur le catalogue et non sur la locale de l’interface.

**Stockage et lecture de grands catalogues :** le service ne garde jamais le catalogue entier en RAM ni dans DB8. Il lit la réponse ligne par ligne après décompression et écrit un index compact versionné et **chiffré au repos** (§8.2) dans son répertoire privé sous `/media/internal` : dictionnaire des groupes partagé, enregistrements par chaîne/film/épisode, source order, métadonnées d’affichage, script/tranche alphabétique, `streamRef` opaque et URL de lecture (traitée comme un secret, en mode `storedSecret` ou reconstruite en mode `derived`), plus index d’offsets par groupe et titre normalisé. `getItems(category,cursor)`/recherche ouvrent l’index et renvoient 100–250 objets maximum par réponse LS2. Écrire d’abord `catalog-<version>.tmp`, valider l’import, puis basculer atomiquement vers la nouvelle version ; un import annulé/arrêté ne remplace jamais le dernier index valide. La suppression du profil efface index, fichiers temporaires et références associées. Au prochain appel, le service rouvre les fichiers : aucune dépendance à une mémoire de processus durable. [S33]

Les plafonds initiaux de 25 Mio/50 000 entrées sont retirés. La qualification vise au minimum **250 000 entrées ou 256 Mio décompressés** (test de capacité, pas plafond produit). Mesurer les octets reçus après décompression, le nombre d’entrées, l’espace disque libre et le pic mémoire au fil du flux ; ne pas faire confiance au seul `Content-Length`. Le seuil dur est un quota de sécurité configuré selon les mesures du plus petit téléviseur, pas une constante universelle. Si le quota est atteint, continuer au besoin un scan léger des noms de groupes sans conserver les URLs, présenter la sélection locale, puis refaire un téléchargement en n’indexant que les groupes choisis ; indiquer que cette opération peut retélécharger la source. Conserver l’ancien catalogue pendant ce parcours et ne jamais exiger que l’utilisateur fasse modifier la playlist chez son fournisseur.

| `Profile` | `id`, `name`, `providerType`, `baseUrl`, `username` si nécessaire, `secretRef`, `epgUrl?`, `preferredLiveFormat`, `lastSyncAt`, `status` |
| `Category` | `id`, `profileId`, `contentType`, `name`, `sourceOrder` |
| `CategoryPreference` | `profileId`, `categoryKey`, `isHidden`, `manualSortOrder?` |
| `ContentRef` | **un seul type d’identité** : `profileId`, `contentType`, `providerId?` (Xtream), `sourceKey` (M3U `variantKey`), `logicalKey?`, `displayName` — il remplace les trois stratégies d’identification de la v1.2 |
| `Channel` | `ref: ContentRef`, `categoryId`, `name`, `logoUrl?`, `epgId?`, `streamRef`, `sourceOrder`, `hostSafety` (ok/private/unknown, §5.2) |
| `Movie` | `ref`, `categoryId`, `title`, `posterUrl?`, `year?`, `duration?`, `plot?`, `rating?`, `streamRef`, `hostSafety` |
| `Series` | `ref`, `categoryId`, `title`, `posterUrl?`, `plot?`, `seasons[]` ou référence de détail, `structure: provider/derived/flat` (§3.4) |
| `Episode` | `ref`, `seriesRef`, `seasonNumber?`, `episodeNumber?`, `title`, `duration?`, `plot?`, `streamRef`, `hostSafety` |
| `Program` | `epgChannelId`, `startUtc`, `endUtc?`, `title`, `description?`, `category?`, `imageUrl?` |
| `Favorite` | `ref: ContentRef`, `profileId`, `lastSeenName`, `updatedAt`, `matchState` |
| `EpgMapping` | `ref: ContentRef` (ou `sourceKeyHash` M3U), `epgChannelId`, `matchMethod`, `updatedAt` |
| `PlaybackPosition` | `ref: ContentRef`, `profileId`, `positionSeconds`, `durationSeconds?`, `updatedAt`, `completed` |
| `ImportJob` | voir §15.1 — persisté en DB8, jamais en mémoire seule |
| `CatalogIndexManifest` | `profileId`, `indexVersion`, `contentType`, `entryCount`, `bytes`, `searchIndexKind`, `scriptBuckets`, `createdAt`, `state` (building/valid) — écrit par le service, jamais en DB8 |

`streamRef` est une référence opaque résolue par le service dans son index privé. **L’URL de lecture n’est pas une donnée de catalogue : c’est une donnée de session.** L’interface ne reçoit une URL que par `resolveStream()`, juste avant la lecture, sous forme de `StreamResolution` (`url`, `preferredMime?`, `expiresAt?`, `kind`) — contrat complet au §15.1 — et ne la conserve ni dans son état d’écran, ni dans l’historique, ni dans un journal. Elle est re-résolue à chaque tentative de lecture, à chaque reprise après erreur, et dès que `expiresAt` est atteint (certains fournisseurs émettent des URL valables quelques dizaines de secondes). Deux modes de résolution coexistent selon le consentement §8.2 : `storedSecret` (URL complète conservée dans l’index, chiffrée au repos) et `derived` (URL reconstruite à la lecture depuis un préfixe d’identifiants fourni en session) ; le mode est un champ de l’entrée d’index, jamais une supposition de l’interface.

**Identité stable et réassociation (deux niveaux distincts).** La v1.2 mélangeait « identité logique du contenu » et « identité de variante de flux » : deux lignes `TF1` de même `tvg-id` et de même groupe mais pointant vers `server-a` et `server-b` n’étaient pas « strictement identiques » (l’URL diffère) et recevaient donc toutes deux le rang 1 → **même clé, fusion silencieuse**. Correction :

```text
logicalKey   = H( 0x01 ‖ contentType ‖ tvgIdNorm ‖ nameNorm ‖ groupNorm )

variantKey   = H( 0x02 ‖ logicalKey
                     ‖ endpointClass                    // schéma://hôte:port, sans identifiants
                     ‖ endpointFingerprint              // HMAC-SHA-256(masterKey, chemin+requête) tronqué 10 octets
                     ‖ occurrence )                     // rang parmi les lignes de même (endpointClass, fingerprint, métadonnées)

sourceKey    = variantKey                                  // stocké dans DB8 (favoris, reprises)
```

- `endpointFingerprint` est **calculé en HMAC avec la clé maître du profil** (§15.3) : il distingue `server-a/live/1` de `server-b/live/1` et `…/1` de `…/2`, sans jamais rendre le chemin réversible ni permettre à une autre application lisant DB8 de le recalculer. Le token ne participe donc toujours **pas** à l’identité sous forme claire.
- **Identité logique ≠ identité de variante** : `logicalKey` est stable quand l’URL change (rotation de token côté fournisseur) ; `variantKey` ne l’est pas. C’est exactement ce qu’il faut pour réassocier sans fusionner.
- Deux lignes **réellement identiques** (mêmes métadonnées *et* même `endpointClass`/`endpointFingerprint`) sont des **doublons** : la seconde est ignorée et comptée dans les avertissements d’import (§5.2), plutôt que conservée avec un rang. `occurrence` ne subsiste que comme garde-fou du cas pathologique où deux entrées doivent rester distinctes malgré un fingerprint identique.
- `tvg-id` reste un **indice, pas une identité** : souvent partagé par des variantes ou des flux de secours, parfois faux ; il ne sert jamais seul.
- « TF1 HD », « TF1 FHD » et « TF1 4K » restent trois entrées : `nameNorm` les distingue et aucun suffixe n’est retiré de la clé stricte.

**Réassociation à l’actualisation**, dans cet ordre :

1. `variantKey` identique → même entrée, favori et reprise conservés silencieusement ;
2. sinon, si `logicalKey` **et** `endpointClass` sont identiques mais que `endpointFingerprint` diffère → **même chaîne, URL changée** (cas le plus fréquent) : candidat unique, présenté comme « adresse mise à jour », accepté par défaut **uniquement** si un seul candidat existe et que le nom affiché est identique ;
3. sinon, si `logicalKey` seul correspond et qu’un unique candidat existe → proposition à valider par l’utilisateur ;
4. ambiguïté (plusieurs candidats) → présentation des candidats, **aucune liaison automatique**, l’entrée reste non appariée et modifiable (§5.4).

Une **clé assouplie** — nom normalisé avec suffixes qualité/langue retirés (liste prudente partagée avec l’EPG, §5.4) + groupe + type — sert uniquement à **proposer** des candidats au niveau 3/4 ; elle n’est jamais une identité stockée.

### 5.4 EPG

- Charger l’EPG en arrière-plan après les premières catégories ; mettre à jour à la sélection de chaîne avec debounce de 150–250 ms ; ne pas requêter à chaque répétition de touche.
- Si le guide est vide, trop ancien, non apparié ou invalide, afficher une indication discrète ; la lecture live reste indépendante.
- Ne pas recharger la totalité d’un XMLTV à chaque navigation ; cache borné des programmes filtrés et rafraîchissement contrôlé (valeur de départ 6–12 h, ajustable par profil).
- **Politique de rafraîchissement EPG (précise, par source) :** *au premier affichage d’un écran Live* → lire le cache ; s’il est absent ou plus vieux que la durée de fraîcheur (défaut 6 h), lancer un rafraîchissement en tâche de fond attaché à la session ; *toutes les 15 min* → rafraîchir si le guide est ouvert et si la dernière tentative a plus de 30 min ; *jamais* de rafraîchissement déclenché par un mouvement de focus ; *sur erreur* → backoff exponentiel borné (5 min → 15 min → 1 h) et indicateur discret « guide indisponible » sans bloquer les chaînes ; *à la reprise de veille* → marquer le cache comme douteux et rafraîchir une seule fois. Chaque profil porte ces valeurs ; l’écran Profil les affiche en minutes/heures, sans jargon.
- **Cache d’images borné :** logos et posters sont chargés à la demande, avec une mémoire de décodage plafonnée (cible initiale ≈ 24 Mio d’images décodées, à calibrer) et une file de téléchargement limitée ; au-delà, les entrées les plus anciennes hors écran sont libérées. Aucun préchargement de catalogue, aucune vignette plein écran, et une image ne peut jamais retarder l’affichage d’une liste ou le focus (§9.2).

---

- À chaque nouveau média : annuler les listeners/timers de la session précédente, arrêter la vidéo précédente, vider sa source proprement, affecter la nouvelle URL, appeler `load()` puis `play()` après l’action OK. Observer le rejet de `play()` : si le moteur exige une activation utilisateur directe, afficher « Appuyez sur OK pour démarrer » et retenter depuis cette nouvelle pression, sans classer cela comme un échec de codec.
- HLS : privilégier le HLS natif webOS. La spécification LG déclare HLS pris en charge sur le téléviseur, mais documente également des tags HLS absents/partiels, l’absence d’avance/retour rapide continu et la prise en charge du seek selon le média. [S14]
- Matrice média à valider sur chaque gamme : HLS, MPEG-TS progressif sur HTTP(S), H.264/MPEG-2/HEVC, audio AAC/AC-3 (Dolby Digital)/E-AC-3 (Dolby Digital Plus) et un cas 1080i. LG répertorie certains de ces codecs/conteneurs pour webOS 6, mais la combinaison réelle, le modèle, le profil, le débit et l’entrelacement changent la compatibilité ; aucun support universel n’est promis. GMC/Qpel et certains profils ne sont pas pris en charge. [S15]
- URL sans extension : ne pas se fier à une détection par nom. Construire un `<source>` avec `type` MIME uniquement si le fournisseur ou une sonde contrôlée l’établit ; pour HLS, tester explicitement le MIME/`mediaTransportType` webOS documenté. Si le type reste inconnu, tenter une seule lecture native puis afficher une erreur claire, sans essais indéfinis. Le paramètre MIME doit être validé sur TV, pas seulement desktop. [S35]
- **Ordre de préférence pour établir le type :** 1) métadonnées du fournisseur (`container_extension` du détail Xtream, variante/format du profil) ; 2) forme d’URL connue (`m3u8`) ; 3) **sonde bornée** ; 4) tentative native unique sans `type`.
- **Discipline de la sonde** : une sonde est une **connexion au flux**. Elle consomme une connexion du compte et peut déclencher `max_connections` (§7.2) ou être comptée comme une session par le fournisseur. Règles : **jamais de sonde quand `max_connections ≤ 1`** ni quand le profil est en format Auto sans variante connue — les métadonnées et la tentative native suffisent ; au plus une sonde à la fois par compte, comptée dans le sémaphore de concurrence (§7.3) ; **la sonde est fermée/annulée avant `load()`/`play()`**, jamais exécutée pendant la fenêtre de coalescence du zap ni pendant une lecture ; résultat mémorisé par forme d’hôte+chemin pour ne pas resonder à chaque changement de chaîne. Si un doute subsiste, préférer un échec propre et documenté à une sonde non maîtrisée.
- **Boucles de qualification sur comptes dédiés** : les boucles d’essais de la phase 0 (10 essais par cas puis 30 par cellule) s’exécutent sur des **comptes de test dédiés** fournis à cet effet, jamais sur le compte d’un utilisateur : un compte à `max_connections=1` ne peut pas soutenir un test de charge, et marteler un compte réel peut le faire bloquer. Documenter `max_connections` et les formats autorisés de chaque compte de test.
- **Contrôle avant `video.src`** : avant d’affecter l’URL au média, revérifier le marquage d’hôte de l’entrée (§5.2) contre la politique LAN du profil actif ; une entrée marquée « non sûre » sans autorisation explicite n’est pas jouée et produit « destination réseau non autorisée » (§7.2). Les redirects du pipeline média restent hors de portée de l’application : ce contrôle est best-effort et documenté comme tel (§2.5).
- Tester les redirects 301/302/307/308 vers le même et un autre hôte, changement HTTP↔HTTPS, DNS et autorisation. La pile `<video>` suit ses propres redirects ; l’app ne peut pas inspecter tous les en-têtes/statuts. Ne pas transmettre de credentials d’API par défaut au nouvel origin ; URLs contenant tokens restent des secrets.
- Le HTTP clair peut être nécessaire pour certains fournisseurs : autoriser après avertissement explicite **une seule fois par profil/host** (répéter si le schéma/hôte change), mémoriser le choix et rappeler que réseau/credentials peuvent être observables. HTTPS reste la préférence ; ne jamais downgrader silencieusement.
- **Contrat d’authentification (produit, pas espoir).** Le lecteur natif accepte une **URL** ; il ne garantit pas l’envoi d’en-têtes arbitraires. Contrat V1 explicite, à afficher dans le profil et la fiche technique :
  - **Supporté** : authentification portée par l’URL (utilisateur/mot de passe dans le chemin ou la requête, token d’URL), pour les formats validés en phase 0.
  - **Non supporté** : en-tête `Authorization` personnalisé, cookie obligatoire, `Referer`/`User-Agent` imposés, poignée de main DRM propriétaire ou EME non validé. Ces sources sont **déclarées non compatibles** au test de profil, avec un message qui le dit clairement — pas un échec de lecture obscur.
- **Résolution à la demande, avec expiration.** L’interface ne détient jamais une URL de catalogue : elle appelle `resolveStream(streamRef)` au moment de la lecture (§15.1), obtient `{ url, preferredMime?, expiresAt?, kind }`, et rejoue la résolution si `expiresAt` est atteint, si un `403`/`MediaError` réseau survient, ou sur Réessayer. Une URL expirée pendant la session (certains fournisseurs émettent des URL valables quelques dizaines de secondes) déclenche **une** re-résolution automatique puis une reprise au même point si le média est seekable — sans exposer l’URL dans l’UI, les logs ou l’historique. Le token d’une URL M3U ou de lecture reste un secret.
- Ne pas inclure HLS.js dans le chemin par défaut : il transfère au navigateur la segmentation/buffer en JavaScript et augmente les coûts CPU/mémoire. La V1 s’appuie sur le pipeline média natif ; toute bibliothèque MSE (par ex. Shaka) est une évolution après mesure/prototype ciblé.
- L’usage de DASH/MSE/EME ou d’un DRM doit faire l’objet d’une décision produit, d’une validation des droits/licences et d’essais appareil par appareil. La matrice LG webOS 6 décrit certaines combinaisons HLS-AES128 et MSE/EME-PlayReady/Widevine ; cela ne signifie pas que tous les flux DASH/DRM fournisseurs fonctionnent. [S14]
- Si le manifeste indique des tags non pris en charge, segments A/V incompatibles, un codec non pris en charge ou un certificat TLS non reconnu, afficher une erreur « source non compatible ou inaccessible » et diagnostic non sensible. Ne pas boucler indéfiniment.
### 6.3 Contrôles VOD et reprise

- Pause/reprise, seek uniquement dans `video.seekable` et à une vitesse normale ; aucune promesse d’avance accélérée ou de vitesse variable.
- Seek précis au D-pad : la barre de progression est un contrôle focalisable (§4.6) — Gauche/Droite ajustent la cible par pas bornés (10 s, puis 30/60 s en maintien), OK relance la lecture à la position choisie. C’est le chemin garanti lorsque l’overlay est visible ; il ne remplace pas les sauts directs de 10 s overlay masqué.
- Afficher une barre de progression seulement si la durée est finie et exploitable ; ne pas afficher `NaN`/durée infinie.
- Enregistrer la position périodiquement à faible fréquence (valeur de départ 30 s) et à pause/fin, pas à chaque `timeupdate`.
- À la reprise : proposer **Reprendre** ou **Depuis le début** ; marquer terminé selon une règle configurable (par ex. position > 95 %), puis autoriser à rejouer.
| HTML/login inattendu à la place JSON | Content-type ou parsing/schema invalide | « Réponse fournisseur inattendue. Vérifiez l’URL ou le portail. » Aucun crash de l’écran. |
| Profil accepté mais 0 catégorie/chaîne | Liste vide valide séparée d’une erreur | « Aucune chaîne dans cette source » + actualiser/changer de profil. |
| M3U illisible, vide ou mal formée | Header absent, entrées invalides ou fin prématurée | Compteur d’éléments importés + avertissement « Corriger l’URL / Réessayer ». Garder l’ancien index tant que le nouvel import n’est pas validé. |
| Quota disque/volume M3U dépassé | L’index temporaire n’atteint pas le seuil modèle ; espace libre insuffisant pour **2 × index + temporaire** (§2.4) | Ne pas écraser l’ancien index ; proposer de choisir des groupes, libérer de l’espace ou relancer l’import localement. Aucun refus permanent au seul motif d’un catalogue >50 000 entrées. |
| XMLTV vide, XML mal formé, fuseaux/IDs inconnus | Parseur EPG indépendant | « Guide EPG indisponible » ; les chaînes restent utilisables. |
| Logo/poster 404 ou lent | `onError`, délai, chargement différé | Placeholder stable, aucun blocage catalogue ni déplacement de focus. |
| URL source expirée/flux 403 | `MediaError`, test de la source quand possible ; le statut HTTP exact n’est pas toujours disponible au `<video>` | « Flux inaccessible — l’adresse a peut-être expiré ou l’accès est refusé. » Réessayer, autre chaîne ou modifier source. |
| `waiting`/`stalled` trop long | Seuil de départ : 10–15 s sans avancée, ajustable au HLS fournisseur | Distinguer « Mise en mémoire tampon » et « Lecture interrompue ». Réessayer ou revenir au direct ; pas de spinner infini. |
| DB8 plein/indisponible | Erreur LS2 / quota | Préserver l’interface, expliquer que favoris/profil ne peuvent être enregistrés, proposer libérer cache. Pas de perte silencieuse. |
| Retour, changement de profil ou relance en cours de requête | Annulation par `operationId`/token de session | Annuler la requête et empêcher toute réponse ancienne de remplacer le nouvel écran ou le nouveau flux. |
| Index remplacé pendant une pagination ou une recherche | Curseur portant un `indexVersion` périmé au moment de la requête | « Le catalogue a été mis à jour. » L’interface relance **la même requête** sur la nouvelle version en conservant catégorie, requête, scroll et focus ; aucune page partielle n’est fusionnée avec l’ancienne. |
| Racine de confiance absente du service mais présente ailleurs | Échec de vérification limité aux appels du service Node, alors que Chromium ou le média réussissent | « Connexion sécurisée API impossible sur ce téléviseur. » Vérifier le bundle de racines publiques embarqué et l’horloge TV (§2.5) ; ne jamais désactiver la vérification. |
| Hôte de flux privé/loopback non autorisé | Marquage d’index (§5.2) + absence d’autorisation LAN du profil | « Cette destination réseau n’est pas autorisée. » Autoriser explicitement l’hôte dans les réglages avancés du profil si c’est un serveur LAN voulu. |
| Application masquée/arrière-plan | `visibilitychange`, `webOSRelaunch` | Arrêter chargements de posters/EPG non nécessaires ; pause/arrêt média selon la politique ; restaurer l’état sûr au retour. [S16] |

**Important :** les erreurs `HTMLMediaElement` ne donnent pas toujours le code HTTP précis du segment/manifeste. Utiliser les codes média (abandon, réseau, décodage, source non prise en charge), le statut réseau observable et des tests ciblés ; ne pas déduire à tort qu’un code 4 signifie mot de passe erroné. [S14]

- Appels API catégories/détails : délai connexion 8 s ; délai total 15 s.
- Import M3U/EPG : deadline et quota disque dépendant du modèle, progression par subscription LS2, annulation par Retour/changement de profil ; reprendre avec Range/ETag seulement après preuve que le serveur supporte ces mécanismes.
- Au plus 4 requêtes de métadonnées fournisseur simultanées ; pas de chargement global de toutes les images. Ce plafond inclut la sonde MIME (§6.1), qui est en outre unique par compte et fermée avant toute lecture.
- Indexation Xtream : appels « tous les flux » en priorité (§5.1) ; les replis par catégorie sérialisent leurs lots et respectent le même plafond de 4, jamais en parallèle d’une lecture du même compte quand `max_connections` est bas.
- GET idempotent : au plus 2 réessais automatiques sur timeout/erreur réseau/5xx, backoff avec jitter (ex. 1 s puis 3 s). Pas de retry auto sur credentials incorrects, CORS, parsing ou refus 403/404.
- HTTP 429 : respecter `Retry-After`, sinon temporisation plus longue, jamais boucle serrée.
- Démarrage vidéo : indicateur immédiat ; timeout utilisateur initial 20 s à calibrer sur réseau de référence ; un clic Réessayer lance une nouvelle session et annule l’ancienne.
**Menaces couvertes en V1 :** fuite accidentelle dans les logs/diagnostics, lecture par une autre app ordinaire, interception réseau lorsque TLS est disponible, injection de contenu fournisseur et réutilisation involontaire après suppression de profil. **Hors garantie :** téléviseur rooté/compromis, extraction forensique des fichiers par un attaquant ayant accès privilégié au système, malware exécuté dans le même contexte. Cette limite est affichée dans la page confidentialité ; l’application ne prétend pas que DB8 ou le sandbox équivalent à un coffre matériel. [S20][S33]

- DB8 (kinds versionnés + validation runtime) stocke profils, préférences, favoris, correspondances EPG et positions de reprise, pas le catalogue complet. `private:true` sert à la politique de suppression/désinstallation selon les APIs DB8 ; ce n’est **pas** une promesse de chiffrement. [S17]
- Les index compacts M3U/Xtream vivent dans l’espace privé du service sous `/media/internal`, avec même UID de service entre exécutions ; le service est le seul accès applicatif à ces fichiers. Les URLs M3U de lecture qu’ils contiennent restent des secrets : ils sont **chiffrés au repos** (§8.2) et suivent la même suppression que le profil. Le chiffrement ne change pas la garantie annoncée : un attaquant privilégié reste hors périmètre. [S29][S33]
- `localStorage` est réservé à des réglages non sensibles et non critiques. LG indique que le stockage local d’une application empaquetée peut être supprimé lors d’une mise à jour/suppression ; prévoir migration et ne pas y garder la seule copie des favoris/profils. [S19]
- Import temp + bascule atomique : les écritures interrompues ne corrompent ni DB8 ni le dernier index valide.


Les URL M3U, réponses API, index local et URL de lecture peuvent contenir des identifiants ou tokens. La pile média reçoit l’URL décodée pour lire le flux : l’application peut réduire sa durée de vie, mais ne peut pas cacher ce secret au système média ni au serveur fournisseur. Aucun secret dans l’UI de diagnostic, logs, crash reports ou télémétrie.

- **V1 webOS 6–23 — profil Xtream :** demander un consentement explicite **« Mémoriser ce profil sur ce téléviseur »**, puis conserver les identifiants dans les données DB8 app-aware et les URLs de catalogue dans le stockage privé du service. Pas de passphrase obligatoire ni de saisie répétée à chaque lancement : le compromis est cohérent avec la menace §8.1 et doit être divulgué. Si l’utilisateur refuse, le secret Xtream (utilisateur/mot de passe, quelques dizaines d’octets) reste en mémoire de session et est redemandé au lancement suivant ; le catalogue déjà indexé, lui, n’est pas rejoué.
- **V1 webOS 6–23 — source M3U : la persistance suit la présence réelle de secrets (§3.5).** Si l’analyse de la playlist trouve au moins une URL de lecture porteuse d’identifiants, la persistance est **nécessaire** et devient un **prérequis affiché avant l’import** : il n’existe alors aucun petit secret séparé que l’on pourrait redemander, et refuser la persistance équivaudrait à retélécharger et réindexer jusqu’à 256 Mio à chaque lancement. Si aucune URL ne porte d’identifiant (CDN public), la persistance est simplement annoncée, sans blocage. Le consentement porte sur le stockage local des adresses, pas sur leur usage à distance.
- **Chiffrement au repos (exigence LG).** L’index du service contient des URL authentifiées ; il est écrit **chiffré en AES-256-GCM par blocs de taille fixe**. Les pages sont déchiffrées à la lecture : pas de KDF sur le chemin chaud, coût mesuré en phase 0 sur la TV de référence. Cette mesure répond à l’exigence de la Self Checklist LG (« les informations de confidentialité et d’identifiants doivent être stockées dans un espace sûr ou chiffrées ») et couvre la lecture par une autre application ou un accès non privilégié ; elle **ne résiste pas** à un attaquant privilégié (§8.1) et n’est pas présentée comme une protection matérielle. Repli uniquement si les mesures montrent un coût inacceptable : stockage non chiffré **avec** la même divulgation explicite — jamais un chiffrement annoncé mais absent. [S20][S29]
- **Dérivation de clé : correction d’un défaut P0 de la v1.2.** « Clé par profil + nonce = numéro de bloc » réutilise le couple **(clé, nonce)** dès qu’un nouvel index est écrit — or un index est réécrit à chaque actualisation, et AES-GCM avec un nonce réutilisé sous la même clé perd sa confidentialité et son intégrité (les deux chiffrés se XORent, et un tag peut être forgé). La v1.3 impose une dérivation à trois niveaux, spécifiée au §15.3 :

```text
masterKey(profile)                                  // 32 octets aléatoires, DB8 app-aware
  └─ HKDF-SHA256(masterKey, salt = profileId ‖ indexVersion ‖ contentType, info = "index-key")
       └─ indexKey(indexVersion, contentType)       // clé unique par version d’index ET par type de contenu
            └─ nonce(b) = HKDF-SHA256(indexKey, info = "nonce", salt = u32be(b))[0..11]
AAD = profileId ‖ contentType ‖ indexVersion ‖ u32be(b) ‖ magic
```

  - La clé **change à chaque version d’index** : deux index successifs n’utilisent jamais la même clé, donc `nonce = numéro de bloc` redevient sûr pour un index donné.
  - Le nonce est **dérivé, donc unique par (version, type, bloc)**, sans compteur persistant à maintenir.
  - L’AAD **lie le chiffré à son contexte** : un bloc déplacé d’un index, d’un profil ou d’un `contentType` vers un autre échoue à l’authentification au lieu d’être déchiffré de travers.
  - La clé maître n’est jamais utilisée directement pour chiffrer ; seule la hiérarchie dérivée l’est. Rotation : régénérer `masterKey` et réécrire l’index courant ; l’ancien index devient illisible et est supprimé.
  - Node 8.12 n’expose pas `crypto.hkdf` (arrivé en Node 15) : HKDF-SHA256 est implémentée à la main (RFC 5869, Extract + Expand sur `crypto.createHmac("sha256", …)`), ce qui est explicitement autorisé par le contrat §15.3 et couvert par des vecteurs de test RFC 5869 en CI.
- **Keymanager3/TEE : reporté hors V1.** Le modèle de menace §8.1 exclut précisément l’attaquant contre lequel une clé TEE protège (TV rootée, extraction privilégiée), aucune API de coffre n’est documentée avant webOS 24, et la supporter maintenant ajouterait un second chemin de secrets à tester sans bénéfice couvert. À traiter **avec** l’option passphrase (§8.2, option future) dans une version ultérieure, quand webOS 24+ devient le plancher de support : à ce moment-là, la clé d’index migre vers Keymanager3 lorsqu’il est disponible, avec repli DB8 conservé. [S18]
- Option future « chiffrement local avec passphrase » pour les utilisateurs qui veulent résister à l’extraction de stockage : AES-GCM avec KDF versionnée, sel aléatoire et nonce unique. Si PBKDF2-HMAC-SHA-256 est retenu, 600 000 itérations est la baseline OWASP indiquée pour ce KDF ; la note FIPS concerne le choix de PBKDF2. Exécuter en asynchrone et mesurer sur la TV minimale ; ne jamais réduire le coût en silence. [S30][S31]
- Un URL/token transmis à une source HTTP claire est observable sur le réseau. Avertir avant la première requête claire vers chaque hôte (API, M3U/EPG ou média) du profil, mémoriser l’acceptation par couple profil/hôte/schéma, et réavertir si le schéma ou l’hôte change. Proposer HTTPS si la source le supporte ; aucune alerte répétitive à chaque lecture.
- Ne jamais coder une clé dans le paquet ni désactiver la validation TLS. Effacer les références en mémoire au changement de profil/fermeture, sans prétendre pouvoir effacer immédiatement les copies internes du décodeur.
- Respecter une zone sûre d’écran (5 % environ comme cible initiale) et vérifier 1280×720, 1920×1080 et 4K ; éviter qu’un focus en bord de liste soit coupé.
- Maintenir une grille de 8 px logique (adaptée à la densité TV), espacement constant et cartes assez grandes pour cliquer au pointeur.
- Affiche/poster : image adaptée à la taille de carte, lazy-load, ratio stable et fallback ; aucune grande image inutile décodée à l’ouverture du catalogue.
- **RTL dès l’architecture :** régler `dir="rtl"` à la racine selon la locale, utiliser les propriétés CSS logiques (`margin-inline`, `inset-inline`, `text-align:start`) et éviter les `left/right` codés en dur. Ce qui se miroite est le **layout** — ordre et position des panneaux, côté du panneau catégories, transitions Spotlight exprimées sur l’axe logique — pas les **touches**, qui restent physiques : toutes les règles de focus sont écrites en termes logiques (§4.3, « vers le panneau catégories ») et se lisent à l’envers en RTL sans réécriture. **Deux exceptions explicites**, traitées §4.6 : l’axe temporel de la barre de progression du lecteur et le mapping Gauche/Droite du seek restent physiques. QA RTL dédiée sur ces points.
- **Saut alphabétique : composant `AlphabetNavigator` à stratégies explicites, pas de logique générique.** Les tranches proviennent des **scripts réellement présents dans les données indexées**, pas de la locale de l’interface : une interface française avec un catalogue arabe affiche les tranches arabes, et inversement. « Ordre canonique du script » étant insuffisant pour plusieurs écritures, chaque stratégie est définie et testée séparément :

| Stratégie | Tranches | Règle de tri / clé |
|---|---|---|
| `latin` | A–Z + `#` | pliage NFKD, casse ignorée, articles et préfixes retirés (§9.3) |
| `arabic` | 28 lettres + `#` | normalisation des formes contextuelles et des diacritiques (`تَشْكِيل`) puis ordre alphabétique arabe ; `أ/إ/آ` repliées sur `ا`, `ة`→`ه`, `ى`→`ي` ; les titres purement latins d’un catalogue arabe restent dans `#` |
| `cyrillic` | А–Я + `#` | pliage casse, ordre cyrillique standard |
| `hebrew` | א–ת + `#` | ordre hébreu, niqqud ignorés |
| `greek` | Α–Ω + `#` | accents et tréma ignorés (`ά`→`α`) |
| `cjk` | **pas de tranche par lettre** : regroupement par plage Unicode (CJK unifié, Hiragana, Katakana, Hangul) et, si le catalogue fournit la donnée ou si un pinyin est calculable hors ligne sans dépendance, sous-tranches par **première lettre pinyin** pour le han ; sinon un simple regroupement par plage, annoncé comme tel | le tri se fait par point de code de la chaîne normalisée, jamais par « ordre alphabétique » implicite |
| `numeric` | 0–9 + `#` | entrées commençant par un chiffre |

  Chaque tranche affiche son nombre d’entrées et masque celles qui sont vides ; si aucune tranche exploitable n’existe, un unique groupe `#` reste affiché. Le composant reçoit `(script dominant, tranches, compteurs)` du service (§15.2) et ne recalcule jamais l’ordre à partir des titres affichés. Les stratégies non implémentées pour un script donné sont **désactivées explicitement** plutôt que rendues avec un ordre arbitraire.
- **Normalisation de tri partagée :** le même module de normalisation que l’EPG (§5.4) retire, pour les besoins de tri et de recherche uniquement, les préfixes fournisseur (`FR|`, `|4K|`, `[VIP]`, flèches/emoji), les suffixes qualité/langue (`HD`, `FHD`, `4K`, `UHD`, `HEVC`, `SD`, `1080p`, `MULTI`, `VF`, `VO`, codes de langue) et les articles initiaux (`le`, `la`, `les`, `l’`, `un`, `une`, `the`, `el`, `ال`…), avec décomposition Unicode NFKD et repli de casse. Le titre affiché n’est jamais modifié et cette normalisation n’entre pas dans `sourceKey` (§5.3). Prévoir une passe QA arabe avant distribution, même si le français est la langue V1.
- **Accessibilité :** `appinfo.json` active `supportsAudioGuidance`; utiliser ARIA labels/roles/state sur les contrôles personnalisés et vérifier l’annonce du focus avec l’audio guidance webOS réellement activé. Ne pas prétendre à l’accessibilité vocale sans test appareil. Focus identifiable autrement que par couleur seule ; texte redimensionnable (100/125/150 %) sans troncature critique ; poster avec alternative utile ou décorative explicitement marquée ; dialogues et erreurs compréhensibles au lecteur d’écran. [S37]

### 9.2 Budgets de performance projet
| Sélection d’une catégorie déjà en cache | cible ≤ 250 ms avant feedback ; le réseau remplit ensuite le contenu. |
| VOD/grilles/catalogues longs | virtualisation Sandstone ; ne monter que les éléments visibles et un petit tampon ; retenir le focus sans reconstruire tout le catalogue. [S08] |
| Lecture | afficher immédiatement l’état de préparation ; afficher l’image/nom pendant l’attente ; mesurer séparément délai fournisseur et temps jusqu’à première image. |
| Zapping live (chaîne suivante, même profil/format) | cible initiale **p50 ≤ 4 s** et p95 ≤ 8 s, mesurés depuis la **dernière** pression de la rafale jusqu’à la première image affichée, fenêtre de coalescence de 400 ms incluse ; à calibrer en phase 0 puis à figer. |
| Images | jamais attendre logo/poster pour rendre l’élément, la liste ou le focus. |
| Session longue | scénario soak de 30 min et au moins 100 changements de chaîne ; aucune croissance mémoire monotone, perte durable de réactivité, écran noir ou crash. Mesurer CPU/mémoire sur TV réelle avec les outils LG. [S21] |
| Bundle | build production minifié, imports limités et assets locaux ; fixer un budget de bundle en CI après première mesure réelle plutôt que d’ajouter des dépendances sans contrôle. |

- Utiliser Sandstone `VirtualList`/`VirtualGridList` pour les longues listes. Définir `itemSize`, `dataSize`, renderer stable, clé et `data-index` pour Spotlight ; ne pas reconstruire de fonctions/item tree à chaque mouvement de focus. Enact documente la virtualisation comme réponse aux listes longues et au coût repaint/reflow. [S08]
- Charger catégories, détail et EPG à la demande ; ne jamais récupérer film + série + live + EPG complet avant l’accueil.
- Un **seul** module de normalisation (casse, accents, NFKD, préfixes/suffixes fournisseur, articles) alimente la correspondance EPG, les clés de tri, la recherche et les tranches alphabétiques ; sa duplication par écran est interdite. Il ne modifie jamais le texte affiché et n’intervient pas dans `sourceKey` (§5.3).
- Recherche et saut alphabétique exécutés par requête indexée du service (catégories visibles, résultats paginés), jamais par filtre JS d’un tableau géant ; debounce 250 ms, annuler les requêtes obsolètes, garder l’état visible précédent jusqu’au remplacement.
- Éviter mises à jour React globales à chaque `timeupdate` vidéo ; rafraîchir la progression par cadence contrôlée ou au niveau du DOM du contrôle dédié.
- Utiliser placeholder et tailles fixes pour réduire layout shift ; ne pas animer `width`/`height` d’une grille à chaque focus.
- À la reprise visible : vérifier le profil actif ; rafraîchir au plus une source d’état nécessaire ; conserver focus, scroll et route si possible ; relancer EPG/catalogue uniquement si expiré.
- Si le téléviseur redémarre ou termine l’application : reprendre accueil/dernier écran par défaut, pas démarrage automatique d’un flux potentiellement coûteux ; option de reprise live uniquement après choix produit explicite.
- Pour Chromium et la pile média webOS, LG documente TLS 1.2 et TLS 1.3 sur webOS 6 ; un certificat racine absent de l’appareil peut bloquer la connexion. La pile Node 8.12 du service est distincte : baseline API TLS 1.2, TLS 1.3 seulement après validation effective sur le téléviseur. Ne jamais accepter un certificat invalide. [S28][S36]
- Le **bundle de racines publiques embarqué** par le service (§2.5) est un artefact suivi : source, date de génération et licence consignées, mise à jour contrôlée à chaque version de l’application, sans CA privée. Un écart entre le magasin du service et celui de Chromium/du média doit rester observable dans le diagnostic local, pas masqué.
- Ne pas supposer que le client `http` Node utilise HTTP/2/3 parce que le navigateur ou le pipeline média le prend en charge ; HTTP/1.1 est la baseline fournisseur du service. Tester les protocoles séparément si une source l’exige.

---
### 11.1 Tests automatisés

- Les tests Spotlight/focus reposent sur la géométrie et le layout DOM : **jsdom ne suffit pas**. Exécuter les parcours d’intégration dans un vrai navigateur, sur Chromium 79 épinglé pour le minimum, puis sur une TV réelle ; conserver les tests unitaires indépendants dans le runner léger.
- **CI des deux cibles :** tests du service sur un **Node 8.12.0 épinglé**, parcours d’interface sur **Chromium 79 épinglé**. Un test qui échoue seulement sur Node 8.12 est un bug de cible, pas un test à désactiver. Ajouter un contrôle qui échoue si le bundle du service contient une API interdite (§2.3) et vérifier qu’aucun `for await`, `fs.promises` ni Brotli n’entre par une dépendance.
- **Clés M3U :** fixtures `TF1 HD` / `TF1 FHD` / `TF1 4K`, `tvg-id` dupliqué ou faux, variantes de secours, trois lignes strictement identiques (rangs distincts) ; vérifier qu’aucune chaîne distincte n’est fusionnée, qu’un favori reste sur la bonne variante après refresh et qu’aucune réassociation ambiguë n’est automatique.
- **Curseurs et version d’index :** pagination/recherche interrompues par une bascule, lecteur sur une version retirée, reprise après redémarrage du service, import annulé n’écrasant jamais l’ancien index ; vérifier `catalog/indexChanged`, le rejeu au même ancrage et le pic disque `2 × index + temporaire`.
- **Filtrage d’URL de flux :** hôtes `10.0.0.1`, `127.0.0.1`, `169.254.169.254`, `2130706433`, `0177.0.0.1`, `[::1]`, `fe80::1` marqués puis refusés à la lecture sans autorisation LAN ; autorisation explicite par profil qui les rend jouables ; sonde MIME désactivée et non comptée quand `max_connections ≤ 1`.
- **Tranches alphabétiques et RTL :** catalogue arabe avec interface française et catalogue latin avec interface arabe produisent les tranches du contenu avec comptes corrects, par stratégie de script (§9.1) ; vérifier aussi la barre de progression et le seek physique en RTL.
- **Contrats d’implémentation (§15) :** `resolveStream` rejouée sur expiration et sur `403` ; `Cursor` d’une `indexVersion` révolue → `catalog/indexChanged` puis rejeu ; `ImportJob` persistant qui survit à un redémarrage du service après 60 % d’un import ; page bornée en objets **et** en octets (fabriquer des entrées ventrues et vérifier la coupure) ; dérivation de clé — deux index successifs du même profil ne doivent **jamais** produire le même couple (clé, nonce), et un bloc déplacé doit être rejeté ; vecteurs RFC 5869 en CI ; aucun `filter()` ni tri en mémoire dans le chemin de recherche (test de non-régression avec un catalogue instrumenté).
- Maintenir des fixtures de structure réalistes : réponses Xtream anonymisées (success, expiry, connexions, formats, erreurs et variantes de schéma), M3U de tailles/formats variés avec URLs et tokens remplacés, XMLTV bruités (fuseaux, CDATA, encodages et programmes hors fenêtre). Les fixtures de référence et leur provenance/licence sont revues avant commit ; compléter par des données synthétiques de fuzz.
- Adaptateur Spotlight : parcours flèches/OK de chaque conteneur, entrée/sortie de fiches, focus initial, focus restauré après navigation et modale.
- Retour : une pression par profondeur d’écran, fermeture de dialog, retour lecteur→catalogue, touche Back en saisie, comportement à la racine.

- **Minimum** : une TV réelle webOS 6, modèle de gamme moyenne/faible, 1080p, Chromium 79.
- **Versions de plateforme** : webOS 6 comme minimum, puis matrice de régression webOS 22, 23, 24, 25 et 26 (Simulator/émulateur quand disponible). Au moins une TV réelle récente en plus de la TV 6 ; chaque major annoncée comme compatible passe ses scénarios de release. Si une version n’est pas testée, l’indiquer comme non certifiée plutôt que d’extrapoler.
- **Familles de modèles** : la certification média est en plus **par famille de modèles**, car les limites HEVC/1080i/débit divergent entre une entrée de gamme et un OLED de la même année. Deux téléviseurs de même version webOS mais de gammes différentes ne se couvrent pas l’un l’autre : annoncer « certifié » uniquement pour les familles testées et « non testé » ailleurs — jamais par version d’OS seule.
- **Protocole statistique à trois niveaux** — une batterie complète ne doit pas être le prix d’un premier verdict :

| Niveau | Essais par cellule | Verdict rendu | Coût |
|---|---|---|---|
| **Smoke** (à chaque build, pendant le développement) | 1–3 | « fonctionne / ne fonctionne pas », sans conclusion statistique | minutes |
| **Qualification** (par incrément, avant de déclarer un format « prévu ») | 10 | cellule **retenue** si 10/10 ; à 9/10 ou moins → cellule **non retenue** et cause documentée | heures |
| **Certification** (avant distribution, sur la matrice de référence) | 30 (≥ 29/30) **ou** 20/20 | seul niveau qui autorise le mot « certifié » pour une famille de modèles | jours |

  Règle de lecture : le smoke et la qualification servent à **éliminer vite** ; seul le niveau certification est une preuve statistique. Aucun échec ne doit être reproductible deux fois pour entrer en certification ; un 9/10 ou un 18/20 ne prouve rien. Consigner par cellule le nombre d’essais, les échecs et leur cause.
- **Comptes de test dédiés** pour toute boucle d’essais, avec `max_connections` et formats documentés ; jamais un compte utilisateur.
- Magic Remote pointeur et 5-way ; tester explicitement si CH+/CH− livrent des keycodes sur chaque télécommande physique. Télécommande conventionnelle avec touches média si disponible ; clavier virtuel et entrée URL.
- Réseau normal, latence haute, DNS erroné, perte/reprise Wi-Fi, portail indisponible, HTTP et HTTPS, API/flux TLS 1.2 et TLS 1.3-only, certificat racine invalide/absent ; tester séparément service Node, navigateur et pipeline `<video>`. **Cas obligatoire :** un hôte dont la chaîne aboutit à une racine postérieure au build du Node embarqué (par ex. ISRG Root X2, 2020) — vérifier si le magasin de 2018 échoue, que le bundle de racines publiques embarqué corrige le service, et consigner le résultat par pile. [S39]
- Matrice de flux autorisés : HLS, MPEG-TS progressif; URL sans extension avec `Content-Type` correct, absent ou générique ; redirects cross-host ; H.264, HEVC, MPEG-2, AAC, AC-3, E-AC-3, 1080i et cas non supportés. Tester HTTP clair avec avertissement une fois par profil.
- Catalogues de capacité : fixtures synthétiques de 250 000 entrées et 256 Mio décompressés, 1 000 catégories, catégories sélectionnées, images absentes, logos lourds, recherche, import interrompu/repris et quota disque ; mesurer le **pic disque en incluant l’ancien index conservé et les fichiers temporaires** (≈ 2 × index + entrée) ; EPG XMLTV volumineux/filtré.
- Mesure mémoire définie : après 10 min de chauffe, relever le RSS de l’app et du service toutes les 30 s ; exécuter 100 zappings puis 5 min au repos. Objectif initial par processus : pic stabilisé ≤ baseline + max(15 % de la baseline, 40 Mio), sans crash ; p95 D-pad reste ≤150 ms. Toute pente RSS >1 Mio/min sur les 5 dernières minutes est un no-go jusqu’à analyse. Conserver heap JS et RSS séparés dans le rapport.
- Session live longue, Home/retour, veille/réveil si scénario utilisé ; mesurer CPU/mémoire séparément en navigation et lecture.

10. **Télécommande seulement** : profil, recherche, lecture, catégories masquées, retour et suppression réalisables au D-pad ; vérifier CH+/CH− sans en dépendre.
11. **Confidentialité** : consentement de mémorisation, avertissement HTTP une seule fois par profil/host, aucun secret dans logs/diagnostics ; diagnostic uniquement local avec export manuel ; suppression efface DB8 et fichiers service.
12. **Accessibilité/localisation** : noms accessibles/ARIA, audio guidance activé et testé sur TV ; vérification RTL arabe, focus miroir et tailles de texte sans coupure.
13. **Fluidité** : objectifs p95, p50 de zapping et seuils mémoire du §11.2 mesurés sur la TV de référence ; un échec est un no-go à corriger avant extension de compatibilité.
14. **Consentement M3U** : refuser la persistance explique pourquoi aucun import ne démarre et propose Xtream ou l’abandon ; accepter écrit un index chiffré, relisible après redémarrage du service ; l’option « préfixe d’identifiants commun » redemande l’URL de playlist à la session suivante au lieu de stocker les URL complètes.
15. **Zapping hors catégorie** : lancer depuis Favoris et depuis une recherche globale, vérifier la file réellement suivie (liste affichée, pas de saut de catégorie) et le retour exact à l’écran et à l’état d’origine.
16. **Seek précis** : overlay visible, barre de progression focalisée, Gauche/Droite ajustent par pas bornés et OK reprend à la position choisie, y compris en RTL.
17. **Index remplacé** : lancer une recherche, déclencher un rafraîchissement pendant la pagination ; vérifier « catalogue mis à jour », le rejeu automatique au même ancrage et la conservation du focus.
18. **Hôte de flux privé** : une playlist contenant `http://192.168.1.1/...` ou une IP en notation décimale/octale est refusée à la lecture sans autorisation LAN du profil, puis jouable après autorisation explicite.

---

## 12. Séquencement recommandé

### Phase 0 — Prototype de risques, découpé en sous-étapes

Objectif : **éliminer vite les risques disqualifiants**, pas construire l’application une seconde fois. Chaque sous-étape se termine par un verdict écrit et peut arrêter le projet.

**0A — Socle applicatif et plateforme (2–3 jours).** Installer un paquet Enact 3.4.9/Sandstone 1.4.6 sur une TV réelle webOS 6 moyenne/faible avec le manifest de §2.6, et vérifier : Spotlight (D-pad, pointeur, clavier virtuel, Back 461/history), quatre écrans factices, navigation D-pad complète, service JS joignable en LS2 avec `commands` non publiques, écriture/lecture DB8, écriture dans le répertoire privé du service, et **capacités réellement accordées** (`requiredPermissions`, appels DB8, réseau sortant du service). Épingler en parallèle le socle CI : Chromium 79 (interface) + **Node 8.12.0** (service) + contrôle d’API interdites (§2.3).

**0B — Lecteur et pipeline média.** `<video>` natif réutilisé : HLS et MPEG-TS progressif, URL sans extension avec MIME déclaré/absent/générique, redirect 302 même et autre hôte, HTTP et HTTPS, H.264, HEVC, MPEG-2, AAC, AC-3, E-AC-3, 1080i, et le zapping coalescé (fermeture effective du flux précédent). Verdicts au niveau **smoke puis qualification** (§11.2), sur **au moins deux familles de modèles** — une seule TV webOS 6 ne représente pas toutes les limites HEVC.

**0C — Un fournisseur de chaque type.** Un portail Xtream autorisé et une playlist M3U autorisée, avec **comptes de test dédiés** (`max_connections` et formats documentés), et une charge volontairement minuscule : 1 catégorie, 10–20 chaînes, 1 film, 1 série. Vérifier `player_api`, l’appel « tous les flux », la construction des `streamRef` et `resolveStream()` (session, expiration, re-résolution), l’identité M3U (`logicalKey`/`variantKey`, §5.3) sur un catalogue jouet, la classification M3U et la structure série « provider/derived/flat ».

**0D — Gros catalogue, secrets, sécurité réseau.** Seulement après 0A–0C validés : import de **250 000 entrées/256 Mio** (temps, RSS/heap, espace, annulation, **pic disque incluant l’ancien index**), `ImportJob` reprenable après mort du service, recherche p95 ≤ 250 ms au niveau qualification, bascule d’index pendant une pagination, **chiffrement** (dérivation §15.3, vecteurs RFC 5869 en CI, coût mesuré sur la TV), modèle UX secrets (§3.5, §8.2), TLS par pile (`process.versions.openssl`, TLS 1.2, TLS 1.3-only, chaîne à **racine récente** type ISRG Root X2, bundle de racines embarqué), refus de loopback/IP privée y compris notations décimales/octales, puis exception LAN autorisée.

**Contrôle de distribution — go/no-go bloquant, à lancer au début de 0A et à trancher avant V1-B.** Relire la Self Checklist, le processus d’approbation (pretest, function test, content test) et la Privacy Guideline LG en vigueur, puis poser **par écrit** à LG Seller Lounge la question du positionnement : application qui lit des playlists/portails **fournis par l’utilisateur**, sans aucun contenu ni chaîne fourni, sans contournement de DRM, sans proxy ni SDK tiers utilisant les ressources de l’appareil. Récupérer : acceptabilité du modèle, mentions obligatoires (page confidentialité, « cette application ne fournit aucun contenu »), pays de distribution autorisés, exigences de revue et calendrier. Vérifier les applications comparables déjà publiées sur le Content Store. Un refus ou une condition inacceptable n’a **pas de repli silencieux** : il change le produit ou le mode de distribution, donc il se tranche ici. [S20][S29]

**GO V1 media (niveau certification §11.2) :** sur chaque téléviseur de référence et pour chaque cellule (modèle × format × codec) que le produit annonce compatible, **30 tentatives indépendantes avec ≥ 29 premières images** — ou **20/20** — ; p95 première image ≤ 15 s **et p50 de zapping ≤ 4 s** sur réseau de labo stable ; le flux précédent est fermé avant le suivant ; aucune erreur TLS/CORS non documentée ni crash. Une cellule qui échoue perd son label « certifié » pour la famille de modèles concernée ; l’appartenance à une famille certifiée est publiée. **GO UI :** navigation complète D-pad (barre de navigation comprise), focus stable, p95 focus ≤150 ms et mémoire dans les seuils §11.2. **GO architecture :** marquage d’index et recherche tenant le catalogue maximal avec les budgets du §15.2. **GO distribution :** réponse écrite de LG obtenue et conditions acceptables — sinon le GO est suspendu, pas contourné.

**Repli explicite :** si le player natif échoue, ne pas changer de framework pour le résoudre ; borner les formats compatibles et évaluer séparément une autre intégration média, après preuve sur TV. Si seul Enact/DOM échoue les budgets UI sur les TVs visées, lancer un prototype **Lightning/Blits isolé** et le comparer aux mêmes métriques, sans mélanger les frameworks dans la V1. Ne pas contourner TLS/CORS ni attribuer à un nouveau framework un problème de pipeline média.

### Phase 1 — V1 fonctionnelle, par incréments (§1.4)

- **V1-A** : squelette empaqueté et manifest §2.6, thème, quatre cartes, adaptateur remote, routeur/Retour, profil Xtream (test, consentement, erreurs normalisées), Live TV (catégories/chaînes), lecteur avec `resolveStream()`, diagnostic local.
- **V1-B** : EPG (courant/suivant, correspondance, décalage manuel), favoris et reprises réassociables, VOD (grille, fiche, recherche indexée, saut alphabétique), navigation globale persistante.
- **V1-C** : Séries (saisons, épisodes, recherche sur titres), structure provider/derived/flat, états d’écran normalisés.
- **V1-D** : M3U comme second moteur (identité §5.3, classification, secrets §3.5), gros catalogues avec `ImportJob` reprenable, index chiffré (§15.3), sélection de groupes, cycle de vie et soak.

### Phase 2 — Durcissement et distribution

- Tests multi-modèles, performance/soak, sécurité et privacy ; corriger les écarts.
- Finaliser iconographie, langues, guide d’utilisation, politique de confidentialité et données de distribution.
- Compléter le self-checklist LG et préparer les captures/scénarios de validation demandés. La faisabilité du modèle ayant été tranchée en phase 0, cette phase ne décide plus de la distribution : elle la met en forme (checklist remplie et **téléversée** avec la soumission — son absence ou son imprécision entraîne un rejet sans QA —, métadonnées, politique de confidentialité, signalement des SDK tiers et section data safety). LG publie un processus de revue et un self-checklist ; vérifier les exigences à jour au moment de soumettre. [S20][S21][S29]

---

- **[S33] LG — stockage privé `/media/internal`, jail et durée de vie du service** : [JS Service Usage](https://webostv.developer.lge.com/develop/guides/js-service-usage)
- **[S34] LG — exposition publique des méthodes LS2 (`public:false` par défaut)** : [services.json](https://webostv.developer.lge.com/develop/references/services-json)
- **[S35] LG — MIME et `mediaOption` pour le lecteur natif** : [mediaOption Parameters](https://webostv.developer.lge.com/develop/guides/mediaoption-parameter)
- **[S36] Node.js — runtime Node 8, API disponibles, OpenSSL embarqué et version exposée par `process.versions`** : [Process API v8](https://nodejs.org/docs/latest-v8.x/api/process.html#process_process_versions), [fs v8](https://nodejs.org/docs/latest-v8.x/api/fs.html), [zlib v8](https://nodejs.org/docs/latest-v8.x/api/zlib.html), [Node.js 8.12.0](https://nodejs.org/en/blog/release/v8.12.0) et [en-tête OpenSSL du tag v8.12.0 (1.0.2p)](https://github.com/nodejs/node/blob/v8.12.0/deps/openssl/openssl/crypto/opensslv.h) — vérifie l’absence de `fs.promises` (Node 10.1), `for await`/`stream.pipeline` (Node 10.0), Brotli (Node 10.16) et `worker_threads` en 8.12.
- **[S37] LG — `supportsAudioGuidance` et ARIA dans `appinfo.json`** : [appinfo.json](https://webostv.developer.lge.com/develop/references/appinfo-json)
- **[S38] Xtream Codes — inventaire des actions `player_api.php`** (référence communautaire, non officielle) : `get_live_streams`, `get_vod_streams`, `get_series` sans filtre de catégorie, variantes `*_by_category`, `get_series_info` pour saisons/épisodes : [Xtream Codes API reference](https://xtreamiptv.codes/xtream-codes/api/)
- **[S39] Let’s Encrypt — chaînes d’émission et racines récentes** (ISRG Root X2, 2020 ; chaîne par défaut vers ISRG Root X1 depuis juin 2024) : [Changes to issuance chains](https://letsencrypt.org/2024/04/12/changes-to-issuance-chains.html) et [Policy on issuance chain changes](https://community.letsencrypt.org/t/policy-on-issuance-chain-changes/223073)
- **[S40] webOS OSE — manifeste, ACG et niveaux de confiance** (`requiredPermissions` comme liste d’ACG, service client vs fournisseur) : [appinfo.json (webOS OSE)](https://www.webosose.org/docs/guides/development/configuration-files/appinfo-json/) et [Security Guide](https://www.webosose.org/docs/guides/development/configuration-files/security-guide/)

---

## 14. Décision finale en une phrase

Pour une V1 LG webOS 6+, livrée par incréments (V1-A → V1-D), partir sur **application empaquetée TypeScript + Enact 3.4.9/Sandstone 1.4.6 + Spotlight**, un **service JS webOS local** compilé pour **Node 8.12/ES2017** et portant un index catalogue compact **chiffré au repos** (clé dérivée par version d’index, §15.3), **DB8** pour profils/favoris/reprises/`ImportJob` avec mémorisation des secrets sur consentement explicite — **prérequis affiché pour une M3U porteuse d’identifiants**, option pour Xtream — sans prétention de coffre matériel, puis un **unique `<video>` HTML natif** alimenté par `resolveStream()` pour les formats validés au go/no-go ; recherche indexée et catalogues paginés à curseurs versionnés, EPG pleine hauteur, filtrage best-effort des URL de flux privées, navigation D-pad complète — le tout exécuté selon les **contrats normatifs du §15** et sous réserve du **go/no-go de distribution LG** tranché en phase 0.

---

## 15. Contrats d’implémentation

Cette section remplace les formulations « il faudrait » par des structures que l’implémentation peut suivre **sans décision critique improvisée**. Elle est normative : en cas de contradiction avec une section précédente, c’est le §15 qui l’emporte, et l’écart doit être corrigé dans la section amont.

### 15.1 Types et interfaces exacts (TypeScript)

```ts
// Identité — une seule stratégie, quel que soit le fournisseur (§5.3)
type ContentType = 'live' | 'vod' | 'series' | 'episode';

interface ContentRef {
  profileId: string;
  contentType: ContentType;
  providerId?: string;        // Xtream : identifiant fournisseur
  sourceKey?: string;         // M3U : variantKey (§5.3)
  logicalKey?: string;        // M3U : clé logique, pour la réassociation
  displayName: string;        // dernier nom vu, pour l'UI et la réassociation
}

type HostSafety = 'ok' | 'private' | 'unknown' | 'allowed-lan';

interface CatalogItem {
  ref: ContentRef;
  categoryId: string;
  title: string;
  sourceOrder: number;
  logoOrPosterUrl?: string;
  epgId?: string;
  year?: number;
  durationSeconds?: number;
  summary?: string;           // ≤ 200 caractères en vue liste (§15.2)
  hostSafety: HostSafety;
  playable: boolean;          // dérivé : hostSafety autorisé ET streamRef résolu
}

// Pagination : jamais un offset nu (§2.4)
interface Cursor {
  indexVersion: number;
  contentType: ContentType;
  order: 'source' | 'title' | 'search';
  ordinal?: number;           // position dans l'ordre demandé
  queryKey?: string;          // empreinte normalisée de la requête, si order === 'search'
}

interface CatalogPage<T> {
  items: T[];
  cursor?: Cursor;            // absent => fin de liste
  indexVersion: number;
  totalKnown?: number;
  approximate: boolean;       // true quand l'indexation est partielle
}

// Résolution de flux : une donnée de session, pas de catalogue (§6.1)
interface StreamResolution {
  url: string;                // jamais journalisée, jamais persistée
  preferredMime?: string;
  expiresAt?: number;         // epoch ms
  kind: 'storedSecret' | 'derived' | 'urlNoSecret';
  resolvedAt: number;
}

// Import reprenable, persisté en DB8 à chaque lot (§2.4, §15.5)
type ImportPhase =
  | 'idle' | 'downloading' | 'parsing' | 'writing'
  | 'validating' | 'swapping' | 'done' | 'failed' | 'cancelled' | 'interrupted';

interface ImportJob {
  jobId: string;
  profileId: string;
  sourceType: 'm3u' | 'epg' | 'xtream';
  phase: ImportPhase;
  bytesRead: number;
  entriesRead: number;
  currentCategory?: string;
  tempIndexVersion: number;
  resumable: boolean;
  resumeHint?: { etag?: string; lastModified?: string; byteOffset?: number };
  usesEmbeddedCredentials: boolean;    // décide la règle de persistance §3.5
  warnings: string[];                  // sans secret
  startedAt: number;
  updatedAt: number;
}

// État d'écran normalisé : un seul modèle, pas un par écran (§4.3)
interface ScreenState {
  route: string;
  categoryId?: string;
  selectedRef?: ContentRef;
  scrollOffset: number;
  query?: string;
  bucket?: string;            // tranche alphabétique active
  focusId?: string;           // identifiant Spotlight à restaurer
}

// Tranches alphabétiques : produites par le service à partir des données (§9.1, §15.2)
type ScriptId = 'latin' | 'arabic' | 'cyrillic' | 'hebrew' | 'greek' | 'cjk' | 'numeric';
interface BucketSet {
  script: ScriptId;                                  // script dominant du catalogue
  buckets: Array<{ key: string; count: number; startOrdinal: number }>;
  generatedFrom: 'index';                            // jamais recalculé depuis l'UI
}

// Adaptateurs fournisseur : la signature unique des deux moteurs
interface ProviderAdapter {
  testConnection(profile: ProfileInput): Promise<TestResult>;
  getCategories(contentType: ContentType): Promise<Category[]>;
  getItems(contentType: ContentType, categoryId: string, cursor?: Cursor): Promise<CatalogPage<CatalogItem>>;
  getBuckets(contentType: ContentType): Promise<BucketSet>;
  searchItems(contentType: ContentType, normalizedQuery: string, cursor?: Cursor): Promise<CatalogPage<CatalogItem>>;
  getDetails(contentType: ContentType, ref: ContentRef): Promise<CatalogDetail>;
  getEpg(channelRef: ContentRef, range: { fromUtc: number; toUtc: number }): Promise<Program[]>;
  resolveStream(ref: ContentRef, requestedFormat?: 'auto' | 'hls' | 'ts'): Promise<StreamResolution>;
  startRefresh(profileId: string, options: RefreshOptions): Promise<{ jobId: string }>;
}
```

Règles attachées :

- `unknown` jusqu’à validation runtime : aucune réponse fournisseur n’est typée « de confiance » (§5.1).
- L’interface ne reçoit **jamais** d’URL de flux hors de `StreamResolution`, et ne la stocke pas (ni `ScreenState`, ni `history.state`, ni journal).
- `CatalogItem.playable` est calculé par le service : une entrée `hostSafety: 'private'` sans autorisation LAN est affichée mais marquée non jouable, avec l’action « autoriser ce serveur LAN » dans le profil (§5.2, §6.1).
- `Cursor.order` fait partie du contrat : un curseur `title` ne peut pas être réutilisé sur un ordre `source`.

### 15.2 Structure d’index et index de recherche

**Fichiers par profil et par `contentType`** (répertoire privé du service, tous chiffrés sauf le manifeste) :

| Fichier | Contenu | Taille indicative (250 k entrées) |
|---|---|---|
| `manifest.json` | `indexVersion`, `contentType`, `entryCount`, `blockSize`, `blockCount`, `searchIndexKind`, `scriptBuckets`, `state`, `createdAt`, `etag` | ~1 Ko, **non secret** |
| `groups.bin` | dictionnaire des groupes (`categoryId` → nom, `sourceOrder`) | ~50 Ko |
| `records.bin` | enregistrements **en ordre source**, slots à taille fixe + zone de charge variable | ~25–60 Mo |
| `title.idx` | index épars de titres : toutes les 32 entrées, `(prefix8, ordinal)` | ~120 Ko |
| `buckets.idx` | première position et compte par `(script, tranche)` | ~4 Ko |
| `token.idx` | **optionnel** : index de jetons pour la recherche milieu de titre (§ci-dessous) | 2–10 Mo |

**Enregistrement (`records.bin`)** — pour permettre la recherche binaire et la pagination sans décodage complet :

```text
[secteur fixe, 128 octets]
  u32  payloadOffset        (offset relatif vers la charge variable)
  u16  payloadLength
  u8   flags                (hasCredential, hostSafety, hasEpgId, playable)
  u8   scriptBucket
  u32  sourceOrder
  u32  crcTitle
  u8[48] titleNormalized    (tronqué, zéro-terminé)
  u8[16] refHash            (variantKey/providerId tronqué — jamais l'URL)
  u8[8]  prefixKey          (clé de tri : 8 premiers octets du titre normalisé, plié)
[secteur variable]
  titre affiché, groupe, logo/poster, année/durée, résumé ≤ 200 car., epgId, streamRef
```

**Deux ordres, un seul fichier :** `records.bin` est écrit en **ordre source** (ordre d’affichage par défaut en Live et dans les grilles) ; l’**ordre alphabétique** est obtenu par `title.idx` (ordinal → secteurs). `getPage(order:'title')` fait donc des accès non contigus, mais bornés : un bloc fait **4 Kio** et une page reste ≤ 64 blocs (≤ 256 Kio), soit au pire 64 déchiffrements AES-GCM indépendants par page — mesuré en phase 0D.

**Recherche — jamais de `filter()` sur le catalogue (§5.1) :**

1. normaliser la requête (même module que le tri, §9.3) ;
2. **recherche binaire** dans `title.idx` (sparse, 1 entrée / 32) pour trouver le premier ordinal dont la `prefixKey` ≥ celle de la requête ;
3. **balayage borné** en avant dans l’ordre alphabétique (ordinal par ordinal via `title.idx` → secteur), en accumulant les correspondances du préfixe, arrêté dès que la clé dépasse la requête ou que la page est pleine (≤ 200 objets / ≤ 256 Kio) ;
4. curseur renvoyé = `{ indexVersion, order:'search', queryKey, ordinal: dernier traité }` → page suivante = reprise exacte, sans rescanner depuis le début ;
5. si `searchIndexKind === 'title+tokens'`, une seconde recherche binaire sur `token.idx` couvre les mots **à l’intérieur** du titre (« matrix » trouve « Le Grand Matrix Reloaded » même sans préfixe) ; les résultats des deux voies sont fusionnés par ordinal, sans doublon, puis paginés.

- **Complexité** : `O(log n)` seeks + un balayage borné à la page. Aucun parcours linéaire de 250 000 entrées, aucun tri en mémoire, aucune construction du tableau complet de résultats.
- **Budgets** (à valider en 0D sur la TV de référence) : recherche → première page **p95 ≤ 250 ms** sur 250 k entrées ; `getPage` → **p95 ≤ 120 ms** ; `getBuckets` → ≤ 50 ms (lecture d’un fichier de quelques Ko).
- **Plafonds de charge utile** : une page de *liste* est bornée par **≤ 200 objets ET ≤ 256 Kio de JSON UTF-8** ; les champs lourds sont remplacés par `summary` (≤ 200 caractères) ; la description complète n’arrive que par `getDetails` (**≤ 32 Kio**). Le service coupe la page **avant** la limite d’octets si les objets sont lourds, et renvoie un curseur valide — il ne dépasse jamais la limite pour « finir » la page. Le champ `bytes` est journalisé dans le diagnostic local, sans contenu.
- `buckets.idx` alimente directement `AlphabetNavigator` (§9.1) : scripts présents, tranche, nombre d’entrées, ordinal de départ.
- Un index partiel (`state:'building'`) est utilisable : `approximate: true` et bandeau « indexation en cours » jusqu’à bascule.

### 15.3 Format de fichier chiffré (corrige le défaut nonce/clé)

```text
EN-TÊTE (en clair, authentifié par l’AAD, 32 octets)
  u8[8]  magic            "IPTVCI1\0"
  u8     formatVersion    = 1
  u8     contentType
  u32    indexVersion
  u32    blockSize        = 4096
  u32    blockCount
  u32    schemaHash       (empreinte du schéma d'enregistrement)

BLOC b (b = 0 … blockCount-1), à offset fixe  headerSize + b × (blockSize + 16)
  u8[4096] ciphertext     (AES-256-GCM, dernier bloc complété, longueur réelle en préfixe)
  u8[16]   tag
```

**Dérivation des clés (RFC 5869, implémentée à la main)** — `crypto.hkdf` n’existe pas en Node 8.12 :

```text
masterKey                    : 32 octets aléatoires par profil, DB8 app-aware (kind dédié)
prk      = HKDF-Extract(salt = profileIdHash ‖ u32be(indexVersion) ‖ contentType, ikm = masterKey)
indexKey = HKDF-Expand(prk, info = "iptv/index-key/v1", L = 32)
nonce(b) = HKDF-Expand(prk, info = "iptv/nonce/v1", salt = u32be(b), L = 12)
aad(b)   = magic ‖ profileIdHash ‖ contentType ‖ u32be(indexVersion) ‖ u32be(b) ‖ schemaHash
```

- **Une clé par `(indexVersion, contentType)`** : deux index successifs n’utilisent jamais la même clé, donc `nonce = f(b)` ne peut pas se répéter sous une même clé. C’est la correction du défaut P0 : en v1.2, « clé par profil + nonce = numéro de bloc » réutilisait le couple (clé, nonce) à chaque réécriture d’index.
- **AAD liée au contexte** : un bloc déplacé vers un autre profil, un autre `contentType` ou une autre version d’index échoue à l’authentification au lieu d’être déchiffré de travers. Le `blockCount` et les ordres stockés dans les index empêchent la réorganisation silencieuse.
- **Accès aléatoire O(1)** : les blocs ont une taille fixe, donc un secteur se lit sans déchiffrer le fichier entier ; une page de liste déchiffre au plus 64 blocs (§15.2) et n’en garde qu’un en mémoire à la fois.
- **Longueur réelle** stockée en tête de clair de chaque bloc (les 4 premiers octets du plaintext), le remplissage étant ignoré à la relecture — pas de fuite de longueur au-delà du bloc.
- **Vecteurs de test obligatoires en CI** : RFC 5869 (cas de test 1 à 3) pour l’HKDF, plus des cas locaux — deux index de même profil produisent des chiffrés différents pour un contenu identique ; un bloc déplacé est rejeté ; un tag altéré est rejeté ; un indice de version incohérent produit `catalog/indexChanged` ou `catalog/corrupt`, jamais un déchiffrement partiel.
- **Clé maître** : jamais utilisée directement pour chiffrer, jamais journalisée, supprimée avec le profil. Rotation = nouvelle `indexVersion` avec nouvelle clé ; l’ancien index devient illisible et est effacé (§2.4).
- **Portée de la protection** : identique à §8.1 — protège contre une autre application et une lecture non privilégiée des fichiers, **pas** contre un appareil rooté ni une extraction par un attaquant privilégié. Cette limite figure dans la page confidentialité.

### 15.4 Protocole LS2

Toutes les commandes sont **non publiques** (§2.6) et suivent une enveloppe unique :

```ts
interface Ls2Reply<T> {
  returnValue: boolean;
  indexVersion?: number;      // présent dès qu'une donnée d'index est renvoyée
  data?: T;
  error?: { code: string; retryable: boolean; hint?: string };   // jamais de secret
}
```

| Commande | Paramètres | Retour | Règles |
|---|---|---|---|
| `testProfile` | `{ profileId?, kind, baseUrl \| playlistUrl, username?, password?, epgUrl?, lanAllowed }` | `{ ok, account?, warnings[], errors[] }` | Identifiants reçus **en paramètre de session uniquement** ; jamais relus depuis le disque ici. Détecte format/expiration/connexions si exposés (§3.5). |
| `importPlaylist` | `{ profileId, kind, source:{url, credentials?}, groups?, consent:{persistSecrets} }` | `{ jobId }` **puis** notifications de progression | Refuse sans `persistSecrets:true` si `usesEmbeddedCredentials` (§3.5). Progression par abonnement LS2, une seule souscription active par profil. |
| `getImportJob` | `{ jobId }` | `ImportJob` | Permet la reprise après mort du service (§15.5). |
| `cancelOperation` | `{ jobId }` | `{ cancelled: true }` | Coopératif, entre deux lots ; l’ancien index reste en place. |
| `getPage` | `{ profileId, contentType, categoryId?, order, cursor? }` | `CatalogPage<CatalogItem>` | `cursor.indexVersion` différent de la version courante → `catalog/indexChanged`. |
| `search` | `{ profileId, contentType, query, cursor? }` | `CatalogPage<CatalogItem>` | Requête normalisée côté service (le module de normalisation vit là, pas dans l’UI). |
| `getBuckets` | `{ profileId, contentType }` | `BucketSet` | Alimente `AlphabetNavigator`. |
| `getDetails` | `{ profileId, contentType, ref }` | `CatalogDetail` | Seule source des descriptions complètes ; ≤ 32 Kio. |
| `resolveStream` | `{ profileId, ref, requestedFormat? }` | `StreamResolution` | Appelée **juste avant** la lecture ; ne met rien en cache au-delà de `expiresAt`. |
| `deleteProfile` | `{ profileId }` | `{ deleted: true }` | Efface DB8 (profil, favoris, reprises, correspondances, `ImportJob`, clé maître) **et** index, fichiers temporaires et résolutions en cache. |

Codes d’erreur normalisés (complètent la matrice §7.2) :

| Code | Sens | `retryable` |
|---|---|---|
| `catalog/indexChanged` | curseur d’une version révolue | oui — rejeu immédiat de la même requête |
| `catalog/quotaExceeded` | quota disque ou taille atteint | non sans action utilisateur (choisir des groupes, libérer) |
| `catalog/corrupt` | échec d’authentification d’un bloc ou manifeste incohérent | non — réimport proposé |
| `catalog/busy` | une opération d’import est déjà active pour ce profil | oui après attente/annulation |
| `network/*`, `auth/*`, `provider/*` | cf. §7.2 | selon le cas |

Règles transverses : **une seule opération lourde par profil à la fois** ; **≤ 4 requêtes fournisseur simultanées** (§7.3) ; toute réponse est bornée en objets **et** en octets (§15.2) ; aucun appel LS2 ne transporte une URL ou un secret vers l’UI ; toute réponse indique l’`indexVersion` utilisée.

### 15.5 Machines d’état exactes

**Lecteur** (complète §6.2) :

```text
IDLE ──play(ref)──▶ PREPARING ──src prête──▶ BUFFERING ──playing──▶ PLAYING
  ▲                     │                       │                     │
  │                     │ resolveStream échoue  │ waiting > seuil     │ pause
  │                     ▼                       ▼                     ▼
  │                   ERROR ◀── MediaError ── ERROR               PAUSED
  └──── STOPPING ◀──────┴─────── retour ──────┘
```

| Transition | Déclencheur | Délai / condition | Effet |
|---|---|---|---|
| sélection → `PREPARING` | pression Haut/Bas ou OK | **après 400 ms** sans nouvelle touche (coalescence) | UI mise à jour immédiatement, un seul flux demandé |
| `PREPARING` → `BUFFERING` | source affectée | — | `load()` puis `play()` |
| `BUFFERING` → `PLAYING` | `playing` | — | spinner masqué, toast de zapping |
| `BUFFERING` → `ERROR` | `error`, `abort`, ou **20 s** sans première image | seuil à calibrer | message + Réessayer/Retour |
| `PLAYING` → `BUFFERING` | `waiting` | seuil 10–15 s avant message | deux messages distincts (tampon / interrompu) |
| `*` → re-résolution | `expiresAt` dépassé ou `403`/erreur réseau | **une** tentative automatique | reprend au même point si seekable |
| `*` → `STOPPING` | Retour, changement de profil, app masquée | — | `pause()`, retrait de la source, `load()`, attente `emptied` ou timeout borné |
| `STOPPING` → `IDLE` | `emptied` ou timeout | ≤ 2 s | aucun décodeur résiduel (vérifié en 0B) |

**Import** (complète §2.4) :

```text
idle ─▶ downloading ─▶ parsing ─▶ writing ─▶ validating ─▶ swapping ─▶ done
            │              │          │            │            │
            └──────────────┴──────────┴────────────┴────────────┴──▶ failed / cancelled
service mort ─▶ interrupted (persisté) ──getImportJob──▶ reprise depuis resumeHint si resumable
```

- L’état est écrit dans DB8 **à chaque lot** (page ou 1 Mio, selon la mesure), pas seulement à la fin : après une mort du service, `getImportJob` restitue la phase, les compteurs, la catégorie courante et `tempIndexVersion`.
- `cancelled`/`failed`/`interrupted` ne touchent **jamais** l’index validé : `swapping` est la seule transition qui change la version élue, et elle est atomique (`rename` + manifeste, §2.4).
- Un job resté `interrupted` depuis plus de 7 jours est proposé à la suppression au démarrage du service, sans bloquer l’usage normal.

**Cycle de vie de l’application** (complète §10) : `webOSLaunch` démarre à l’accueil sans réseau ; `webOSRelaunch` et `visibilitychange` ne réinitialisent **pas** l’état mais suspendent les opérations non critiques ; une reprise visible restaure `ScreenState` et ne relance une source que si le cache est expiré.

### 15.6 Ce que la spec refuse encore de fixer

Trois décisions restent volontairement ouvertes, chacune avec son critère de décision — les figer maintenant serait inventer des chiffres :

1. **Seuils mémoire exacts du service** (RSS du processus Node, taille maximale d’un lot de parsing) : fixés par les mesures de 0D, pas avant.
2. **`searchIndexKind` par défaut** (`title` ou `title+tokens`) : dépend du budget disque réellement disponible sur la TV de référence après l’import de 250 k entrées.
3. **Seuil de longueur des URL considérées comme « portant un identifiant »** lors de l’analyse `hasCredential` : à calibrer sur des playlists réelles, avec un test d’acceptation écrit (les URL publiques de CDN ne doivent pas être classées secrètes).

---

## Annexe A — Journal de révision 1.2

*Lecture : cette annexe conserve l’état de la v1.2. Deux de ses lignes ont depuis été corrigées par la v1.3 — voir annexe B, points P0.*

| Point de revue | Vérification | Correction apportée (v1.2) |
|---|---|---|
| 1. Consentement M3U inapplicable | Confirmé : dans une playlist M3U, l’URL de lecture est le secret ; LG exige des identifiants « stockés dans un espace sûr ou chiffrés ». | Persistance **obligatoire et affichée** comme prérequis pour M3U (§3.5, §8.2) ; variante « index sans segment d’identifiants » lorsque le préfixe est commun (§5.2) ; index **chiffré AES-256-GCM par blocs** (§8.2). ⚠️ **Nuancé en v1.3** : la règle dépend désormais de la présence réelle d’identifiants (§3.5) et le schéma de chiffrement a été corrigé (§15.3). |
| 2. Pas de cible de compilation du service | Confirmé : `fs.promises` (10.1), `for await` (10.0), Brotli (10.16), `worker_threads` absents en 8.12. | Cible **ES2017 / Node 8.12** explicite, liste d’API interdites, deux lint, **CI sur Node 8.12.0 épinglé** (§2.3, §11.1, §12) ; risque EOL documenté. |
| 3. Indexation Xtream par catégorie | Confirmé : les appels « tous les flux » sans filtre de catégorie existent ; le repli par catégorie reste possible mais coûteux (429, durée) et incompatible avec l’absence de travail en arrière-plan. | Appel global par défaut, par catégorie en repli ; indexation **attachée à la souscription au premier plan**, reprise par lots ; portée de recherche précisée (titres de séries, pas d’épisodes) (§5.1, §3.4). |
| 4. Collisions de clés M3U | Confirmé : une clé sur nom sans suffixes qualité fusionne des variantes distinctes. | Clé composite **stricte** (`contentType` + `tvg-id` + nom complet + groupe + rang d’occurrence) ; clé assouplie réservée à la **réassociation** (§5.3, §11.1). ⚠️ **Corrigé en v1.3** : cette clé fusionnait encore deux variantes de même nom pointant vers deux serveurs ; remplacée par `logicalKey`/`variantKey` avec empreinte d’endpoint en HMAC (§5.3). |
| 5. Sonde MIME vs connexions | Confirmé : une sonde consomme une connexion et peut déclencher `max_connections` ou un blocage. | Métadonnées d’abord ; sonde **interdite si `max_connections ≤ 1`**, unique par compte, comptée, fermée avant `play()` ; essais de phase 0 sur **comptes dédiés** (§6.1, §11.2, §12). |
| 6. Curseurs et bascule atomique | Confirmé : un offset nu devient faux après bascule ; la rétention de l’ancien index double le besoin disque. | `indexVersion` obligatoire, erreur `catalog/indexChanged` + rejeu au même ancrage ; rétention bornée et quota calculé sur **≈ 2 × index + temporaire** (§2.4, §7.2, §11.2). |
| 7. Keymanager3 sans menace couverte | Confirmé : API TEE **webOS 24+ uniquement**, non disponible avant, hors simulateur. | **Reporté hors V1**, à traiter avec l’option passphrase ; modèle de menace inchangé, chiffrement logiciel assumé et divulgué (§8.1, §8.2). |
| 8. URL de flux non filtrées | Confirmé : la politique réseau couvre les téléchargements, pas `<video>`. | **Marquage à l’indexation** des hôtes IP littéraux privés/loopback/link-local (notations décimale, octale, hexadécimale, IPv6) et contrôle avant `video.src`, sauf autorisation LAN du profil ; noms d’hôte = risque résiduel assumé (§5.2, §6.1, §7.2). |
| 9. Saut alphabétique et RTL | Confirmé : les tranches suivaient la locale de l’interface ; préfixes fournisseur et articles polluaient le tri. | Tranches issues des **scripts présents dans les données** ; **normalisation partagée** avec l’EPG ; règles de focus réécrites en **termes logiques** et décision explicite sur le seek physique du lecteur (§4.3, §4.6, §9.1, §9.3). |
| 10. Trous du lecteur | Confirmé : aucune file définie pour favoris/recherche ; aucun seek précis overlay visible. | **File de lecture explicite** par contexte (catégorie, favoris, résultats, saison, grille) et **barre de progression focalisable** (slider) pour le seek (§4.3, §4.6, §6.3, §11.3). |
| 11. Go/no-go statistiquement faible | Confirmé : 9/10 est compatible avec un taux réel proche de 60 %. | **30 tentatives par cellule avec ≥ 29/30, ou 20/20** (même ordre de confiance) ; **p50 de zapping ≤ 4 s** ajouté ; certification **par famille de modèles** et non par version d’OS seule (§0, §9.2, §11.2, §12). |
| 12. Risque de distribution tardif | Confirmé : le processus LG (pretest/function/content, self-checklist à téléverser) conditionne tout le produit. | **Go/no-go de phase 0** avec question écrite à LG Seller Lounge, mentions obligatoires et pays de distribution (§12 ; §0). |
| Dernier détail — magasin de certificats | Confirmé : bundle figé au build ; chaînes récentes (ISRG Root X2, 2020) peuvent échouer côté service alors que le média réussit. | Cas de test **racine récente** obligatoire en phase 0 et **bundle de racines publiques embarqué** pour le client HTTPS du service, sans contournement TLS (§2.5, §10, §11.2). |

---

## Annexe B — Journal de révision 1.3 (passage aux contrats d’implémentation)

La v1.3 répond à une revue d’architecture qui confirmait le cap (Enact + Spotlight + service JS + `<video>` natif + index disque) et demandait de transformer les intentions en contrats. Deux défauts P0 et cinq manques de contrat ont été traités ; le périmètre a été découpé.

| Point de revue | Vérification | Correction apportée |
|---|---|---|
| **P0 — Réutilisation de nonce AES-GCM** (clé par profil + nonce = n° de bloc ; un nouvel index réutilise donc le couple) | Défaut réel et grave : sous une même clé, réutiliser un nonce casse confidentialité et intégrité de GCM. | Hiérarchie `masterKey → HKDF(indexVersion, contentType) → indexKey → nonce(b)` avec **clé par version d’index** et **AAD** liant profil/type/version/bloc ; HKDF-SHA256 écrit à la main (absente de Node 8.12) avec vecteurs RFC 5869 en CI ; format de fichier exact en §15.3 (§8.2 en résumé). |
| **P0 — Collision d’identité M3U** (deux variantes `server-a`/`server-b` de même nom, même `tvg-id`, même groupe → même clé) | Défaut réel : l’occurrence ne comptait que les lignes *strictement* identiques, or les URL diffèrent. | Séparation **`logicalKey` / `variantKey`** : empreinte d’endpoint en **HMAC** (chemin+requête, jamais réversible), rang d’occurrence en garde-fou, doublons vrais ignorés ; réassociation en 4 niveaux (§5.3). |
| **P0 — Manifest et capacités webOS** | La référence `services.json` documente `commands[]` (**pas `methods`**) et un `public` par défaut à `false` ; `supportsAudioGuidance` est **imbriqué** dans `accessibility` ; `requiredPermissions` n’est plus listé dans la référence TV (documenté côté webOS OSE). | Nouvelle section §2.6 : `appinfo.json` minimal, `services.json` complet, contraintes de nommage (ID ↔ nom de service Luna), politique d’ACG justifiée appel par appel, tableau de capacités, et ligne « à valider en 0A » au lieu d’une affirmation. [S34][S37][S40] |
| **P0 — Cycle de vie des URL (`streamRef`)** | Manquait le contrat explicite « référence de contenu ≠ URL de session ». | `StreamResolution { url, preferredMime?, expiresAt?, kind }`, résolution à la demande, re-résolution unique sur expiration ou `403`, interdiction de conserver/logger l’URL (§6.1, §15.1, §15.5). |
| **P0 — Index de recherche** | La spec disait « index de recherche » sans structure : un `filter()` sur 250 k entrées était l’implémentation implicite. | Structure exacte des fichiers, enregistrement à secteurs fixes, index épars + balayage borné + jetons optionnels, budgets p95 (recherche ≤ 250 ms, page ≤ 120 ms), interdiction de parcours linéaire (§15.2, §9.3). |
| **P0 — `ImportJob` persistant** | La reprise était décrite mais sans état persistant normalisé. | `ImportJob` complet (phase, compteurs, catégorie, `tempIndexVersion`, `resumeHint`, secrets présents) persisté en DB8 à chaque lot, machine d’état d’import et reprise après mort du service (§15.1, §15.5, §2.4). |
| **P0 — Dépendances transitives Node 8.12** | Le contrôle CI ne couvrait que le code du projet. | Discipline ajoutée : zéro dépendance d’exécution par défaut, lint AST + CI Node 8.12 sur l’arbre complet du lockfile, `--ignore-scripts`, frontière `dependencies`/`devDependencies` vérifiée (§2.3). |
| Plafond en **octets** des réponses LS2 | Deux pages de 250 objets n’ont pas le même poids selon le contenu. | Double plafond **≤ 200 objets ET ≤ 256 Kio**, `summary` en liste, description longue réservée à `getDetails` (§15.2, §15.4). |
| Sémantique des secrets M3U | Toute playlist n’est pas porteuse d’identifiants : `https://cdn.exemple.com/x.m3u8` est publique. | Règle **par analyse** : `hasCredential` par entrée → persistance nécessaire et consentement bloquant, ou persistance facultative ; l’exception « préfixe commun » ne dispense plus du consentement (§3.5, §5.2, §8.2). |
| **Navigation globale persistante** | L’accueil à quatre cartes n’offrait pas de passage direct entre sections. | Barre discrète en haut des écrans de contenu, atteinte par Haut, état conservé par section, absente du lecteur et des dialogues, miroir RTL (§3.1, §4.3). |
| **EPG** : focus du panneau | Le comportement interne du panneau EPG n’était pas décrit. | Panneau focalisable unique : courant → suivant → description, « Lire la suite », règles de défilement, mise à jour sans vol de focus (§4.3). |
| **État d’écran normalisé** | Le même retour (catégorie/index/scroll/focus) était répété par écran. | `ScreenState` unique (§15.1) + règles de restauration par incrément (§4.3, §10, §15.5). |
| CJK / arabe : ordre alphabétique | « Ordre canonique du script » est insuffisant pour le han. | `AlphabetNavigator` à **stratégies explicites** (latin, arabe avec normalisation, cyrillique, hébreu, grec, CJK par plages/pinyin, numérique) (§9.1). |
| Charge de test trop lourde | La batterie statistique était exigée dès le départ. | **Trois niveaux** : smoke 1–3 essais, qualification 10, certification 30 (≥ 29/30) ou 20/20 — seul le dernier autorise « certifié » (§11.2, §12). |
| **Phase 0 trop grosse** | La phase 0 visait un prototype complet. | Découpage **0A socle/plateforme → 0B lecteur → 0C un fournisseur de chaque type (catalogue jouet) → 0D gros catalogue, secrets, réseau** ; le contrôle de distribution démarre en 0A et se tranche avant V1-B (§12). |
| **Périmètre V1 trop large** | Xtream, M3U, Live, EPG, VOD, Séries, RTL, chiffrement, 256 Mio dans un seul lot. | **Incréments V1-A → V1-D** avec critères d’entrée/sortie ; M3U traité comme **second moteur de données** en V1-D (§1.4, §12). |
| Cache d’images et rafraîchissement EPG | Politique non chiffrée. | Cache d’images borné (≈ 24 Mio décodés, à calibrer), politique EPG par source avec fraîcheur, périodicité, backoff et règle de réveil (§5.4, §9.2). |
| Modèle de données | Trois stratégies d’identité (`id`, `sourceKey`, `sourceKeyHash`, `streamRef`). | `ContentRef` unique pour favoris, reprises et correspondances EPG ; `hostSafety` et `playable` portés par l’item (§5.3, §15.1). |
| Contrat d’authentification | « `<video>` ne garantit pas les en-têtes » était une remarque, pas un contrat. | Liste **supporté / non supporté** (URL-based oui ; en-tête, cookie, referer, DRM propriétaire non) affichée au test de profil (§1.3, §6.1). |
| Décisions non figées | — | Trois points sont explicitement laissés ouverts avec leur critère de décision (§15.6) : seuils mémoire du service, `searchIndexKind` par défaut, seuil de longueur des URL « avec identifiant ». |
