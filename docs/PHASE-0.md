# Phase 0 — vérifications à exécuter sur le téléviseur et auprès de LG

Ces vérifications ne peuvent pas être faites dans un environnement de développement : elles
conditionnent la faisabilité du produit (§12). Chaque case se coche **avec sa preuve** (journal,
copie d'écran, réponse écrite), jamais par extrapolation.

## 0A — Socle applicatif et plateforme

### Paquet à installer (interface + page de diagnostic)

Le paquet livré contient le service complet (§15.4), **l'interface Enact de V1-A** (accueil à quatre
cartes, Live TV, réglages, lecteur) et la **page de diagnostic** télécommandable, qui appelle les
douze commandes LS2 et reste joignable depuis *Réglages* → « Page de diagnostic (0A) ». La page sert
à prouver le socle sur la TV — LS2, DB8, permissions, stockage privé, TLS — **même si l'interface
refuse de démarrer** ; c'est elle qui porte la bannière explicative et le témoin du bus.

```bash
npm ci                                    # outillage de développement
npm i -g @webosose/ares-cli               # outillage LG (ares-package, ares-install)
npm run pack:webos                        # compile le service puis produit release/*.ipk

# sur la TV : mode développeur activé (application « Developer Mode »), même compte LG que le CLI
ares-setup-device --add tv --info "host=<IP de la TV>" --passphrase   # la TV affiche la phrase
ares-device  --device tv --system-info                                # doit répondre : mode développeur visible
ares-install --device tv release/com.ouagkamel.app.iptvplayer_0.1.12_all.ipk
ares-launch  --device tv com.ouagkamel.app.iptvplayer
```

Le mode développeur **expire au bout de 1000 heures** : s'il tombe, `ares-install` répond
`connection refused` — réactiver l'application Developer Mode sur la TV avant de conclure à un bug.

**Si l'application répond « Service does not exist »** — deux défauts du paquet ont produit ce
message (voir `docs/JOURNAL.md` D-09 et D-17) : le service ne s'enregistrait pas quand la plateforme
le chargeait par `require()`, et la page chargeait `webOSTV.js`, absent du paquet, si bien qu'aucun
pont LS2 n'existait côté application. Les deux sont corrigés depuis la version **0.1.2**. Si le
message persiste avec cette version, il vient de l'**enregistrement du service par la TV**, pas du
paquet — la bannière de la page affiche alors la même séquence que ci-dessous :

```bash
ares-install --device tv --listfull                                  # version réellement installee
ares-install --device tv -r com.ouagkamel.app.iptvplayer             # desinstallation complete
ares-install --device tv com.ouagkamel.app.iptvplayer_0.1.12_all.ipk  # reinstallation
# redemarrer la TV : le hub relit la liste de ses services au demarrage
ares-inspect --device tv -s com.ouagkamel.app.iptvplayer.service -o   # lance le service et ouvre sa console
```

Le journal du service se lit pendant l'installation :

```bash
ares-log --device tv --follow          # suivre les journaux de la TV
ares-log --device tv --lines 400       # relire les derniers
```

Le service écrit au minimum `[iptv] demarrage du service ... (node v8.12.x)` puis
`[iptv] service enregistre aupres du hub LS2 : 12 commandes`. Si la **première** ligne n'apparaît
pas, le service n'a jamais été lancé (enregistrement côté plateforme) ; si elle apparaît sans la
seconde, la cause est affichée juste après (chargement `lib/service/main.js` impossible).

**Écran noir au lancement** — trois causes corrigées (voir `docs/JOURNAL.md`, D-35, D-38, D-39) :

1. chargement **synchrone** des données de langue d'Enact (0.1.9, `ui/src/services/sansLocales.js`) ;
2. **thème Sandstone jamais appliqué** : texte noir sur fond noir, sans erreur (0.1.10) ;
3. **polices du thème absentes** du paquet (0.1.10).

Si la page reste noire, vérifier la version installée (`ares-install --device tv --listfull`), puis
reproduire hors TV : `node tools/render-app.js release/package` (démarrage, thème, ressources) et
`node tools/inspecter-rendu.js release/package` (contraste, capture d'écran).

**Base locale (DB8) en échec sur le simulateur (2026-10-08, essai 0.1.11)** — la page de diagnostic
affichait `db.ok: false`, `erreur : « Creation du kind DB8 refusee »`, `sonde : « echec (putKind
profiles) : creation du kind DB8 refusee »`. L'absence de **tout** code et de **tout** texte de la
plateforme était l'indice : un refus réel de DB8 arrive toujours avec son code. La cause était le
**pont LS2** : `webos-service` livre la réponse dans un objet `Message` dont la charge utile est
`payload`, et le pont lisait `message.returnValue` au premier niveau — un `putKind` réussi passait
donc pour refusé (D-41, corrigé en **0.1.12**). Contrôle attendu après installation : *Réglages* →
« Page de diagnostic (0A) » → `db.ok: true` et `sonde : ok (ecriture puis relecture indexee)`.

**Base locale (DB8) : « Service does not exist » (2026-10-08, essai 0.1.12)** — la page de
diagnostic a livré la cause exacte : `appel LS2 refuse (-1) : Service does not exist:
com.webos.service.db`. Le nom du service de base différait de celui de la plateforme testée. LG
documente les téléviseurs sous `luna://com.palm.db` (référence « Database » et exemples officiels) ;
le client essaie désormais ce nom d'abord, puis `com.webos.service.db` (webOS OSE), et expose le nom
retenu dans `db.service`. Les ACG `database.operation` et `database.management` sont déclarées dans
`appinfo.json` (0.1.13). Contrôle attendu : `db.ok: true`, `db.service: com.palm.db`, sonde
`ok (ecriture puis relecture indexee)`. Si un autre nom de service DB8 apparaît sur l'appareil,
relever la liste (`ls-monitor -l` sur TV) et la consigner ici.

**Base locale (DB8) : `-3963 db: permission denied` sur `putKind` (2026-10-08, essai 0.1.13)** — le
nom de service était bon, mais DB8 n'accepte la création d'un kind que de **son propriétaire**
(`MojDbKind::hasOwnerPermission` : `req.admin() || req.domain() == owner`). Le client essaie
désormais l'ID de l'application puis le nom du service et retient celui qui est accepté (0.1.14),
affiché dans `db.owner`. Si le refus persiste sur un appareil, recopier ici `db.service`, `db.owner`
et `db.erreur` : le message nomme les deux propriétaires essayés.

**Au lancement, l'interface doit afficher l'accueil à quatre cartes.** Le parcours minimal de la
0A : *Live TV* → les catégories apparaissent (elles viennent de l'index, aucun appel fournisseur) →
*Réglages* → « Tester la source » → « Importer (live) » → la progression va jusqu'à `terminé` avec
le nombre d'entrées → retour à *Live TV* : les chaînes sont là → OK sur une chaîne : le lecteur
s'ouvre (l'image et le son sont la partie 0B). Si un écran reste vide, *Réglages* → « Page de
diagnostic (0A) » donne la réponse brute du service.

Bouton **Témoin du bus LS2** de la page : il interroge un service *du système*
(`com.webos.service.tv.systemproperty`). S'il répond, le pont de l'application fonctionne et le
défaut est propre au service ; s'il échoue aussi, aucun appel LS2 ne sort de la page. Pour vérifier
que le service est bien enregistré après installation :

```bash
ares-inspect --device tv --service com.ouagkamel.app.iptvplayer.service --open   # console du service
luna-send -n 1 -f 'luna://com.ouagkamel.app.iptvplayer.service/diagnostics' '{}'
```

`luna-send` ne s'exécute que depuis la TV (shell développeur) ; la commande `diagnostics` répond
`returnValue: true` avec `runtime`, `roots`, `indexes` — et **aucun identifiant**.

**Ce que le portail de test a appris** (portail Xtream réel, essai `npm run verify:portal`) : le
portail exige un en-tête `User-Agent` (sans lui : HTTP 461) ; le flux est servi **après
redirection** par un CDN distinct (adresse IP) ; une chaîne absente de l'abonnement est refusée par
le CDN en **407** (ou 405 pour un identifiant invalide) — c'est une propriété du compte, pas un
défaut du lecteur. À l'étape 6 du tableau ci-dessous, choisir une chaîne **effectivement comprise
dans l'abonnement** pour l'essai de lecture.

`release/package/` contient la même arborescence, dépaquetée, pour inspection ; `release/` n'est pas
versionné (l'`.ipk` est un artefact de build, jamais committé).

**Séquence à exécuter sur la TV** (chaque étape a une preuve attendue) :

| Étape | Action dans la page | Preuve attendue |
|---|---|---|
| 1 | **Diagnostic du service** | `returnValue: true`, `runtime.node = 8.12.x`, version d'OpenSSL du firmware, `roots.chain` = bundle embarqué, `indexes: []` (aucun index encore) |
| 2 | **Tester la source** (portail de test dédié) | `data.ok: true` avec `account.status`, `expiresAt`, `formats` ; aucun identifiant dans le journal |
| 3 | **Importer (live)** | progression `downloading → parsing → writing → validating → swapping → done`, puis `data.final: true` |
| 4 | **État de l'import** | `job.phase: done`, compteurs cohérents après redémarrage de la TV |
| 5 | **Page** / **Tranches** | `items[]` avec `ref.providerId`, **aucune URL** ; tranches alphabétiques non vides |
| 6 | **Détail** puis **Résoudre le flux** | `streamMode` (`storedSecret` ou `derived`) ; `resolveStream` renvoie une URL que la case « afficher l'URL complète » dévoile, et le journal ne contient ni URL ni identifiant |
| 7 | **Diagnostic du service** à nouveau | `indexes[0].entryCount` = nombre de chaînes du portail, `jobs[]` sans secret |
| 8 | **Supprimer le profil** | `deleted: true`, `masterKeyRemoved: true`, puis « Page » répond `catalog/indexMissing` |

### Source préconfigurée (éviter de ressaisir les identifiants)

Pour un banc d'essai, les identifiants peuvent être préparés une fois pour toutes dans
`secrets.local/profils.js` (**hors dépôt**, `gitignore`) :

```js
window.iptvProfils = { sources: [ { id: 'p1', nom: 'Portail de test',
  url: 'http://portail:8080', username: '…', password: '…' } ] };
```

`npm run dist` intègre ce fichier à l'application (il **remplace** `src/app/profils.js`) ; la page
propose alors la source dans la liste *Source préconfigurée*, remplit l'adresse, le profil et les
identifiants, et coche l'autorisation HTTP clair si l'adresse est en `http://` — il ne reste qu'à
cliquer **Tester la source**, **Importer (live)**, **Page**…

Deux règles à ne pas contourner : `IPTV_SANS_SOURCES=1 npm run dist` pour toute livraison destinée à
être partagée, et `tools/publish-release.js` refuse de publier une archive qui embarque des sources
(les dépôts et publications GitHub sont publics).

### Simulateur webOS (banc d'essai hors téléviseur)

Le simulateur **n'installe pas** de `.ipk` : il lance une application depuis un **dossier** et il
n'accepte un service que s'il est **ajouté explicitement**. Un service présent uniquement dans un
`.ipk` n'y est donc jamais enregistré, et tout appel se termine par `Service does not exist` — même
quand l'application, elle, tourne. C'est le piège à connaître avant de chercher un défaut de paquet.

```bash
npm run stage:simulator        # assemble release/simulator/{app,service,LISEZ-MOI-SIMULATEUR.txt}
# ou, depuis une livraison : extraire <version>-simulateur.zip dans un dossier personnel
unzip 0.1.4-simulateur.zip -d ~/iptv-simulateur
```

Dans le simulateur, dans cet ordre :

| Étape | Menu | Cible |
|---|---|---|
| 1 | **File > Add Service** | `~/iptv-simulateur/service/com.ouagkamel.app.iptvplayer.service` (racine = dossier contenant `package.json`) |
| 2 | **Tools > Service List** | cliquer sur le service pour le **démarrer** |
| 3 | **File > Launch App** | `~/iptv-simulateur/app` (ou `ares-launch -s <version> ~/iptv-simulateur/app`) |
| 4 | dans la page | « Témoin du bus LS2 » → le pont répond ; « Diagnostic du service » → `runtime.node`, `roots`, `indexes` |

Le dossier du service doit être **sous le répertoire de l'utilisateur** (exigence du simulateur) :
c'est pourquoi le pack s'extrait dans `~`, jamais dans `/tmp`.

**Ce que le simulateur ne prouve pas** : les permissions ACG réelles, le chemin de stockage privé du
service (`/media/internal/…` — le service se rabat alors sur un répertoire temporaire, ce qui est
journalisé), le pipeline média du téléviseur et les performances réelles. Ces points restent à
mesurer **sur la TV** (§12) ; le simulateur sert à valider le protocole, l'index, l'import et
l'enchaînement des écrans.

### Portail en HTTP clair (`security/insecureScheme`)

Un portail servi en `http://` (cas du portail de contrôle) est **refusé par principe** (§8.2) tant que
son hôte n'a pas été explicitement autorisé. Depuis 0.1.6 la boucle est fermée sans rien connaître du
code :

1. **Tester la source** répond `security/insecureScheme` **avec l'hôte** (`hint: hote:<hôte>`) ;
2. la page **coche** la case « Portail en HTTP clair : j'autorise », affiche le risque (identifiants et
   flux en clair sur le réseau) et propose **Relancer** ;
3. l'import fait de même : il **refuse immédiatement** — aucun job n'est lancé — au lieu d'échouer
   après coup ;
4. une fois confirmé, le service enregistre l'autorisation **par hôte et par profil** ; les appels
   suivants passent sans question.

Si un ticket d'erreur parle d'autre chose (`auth/expired`, `network/http`, `catalog/busy`…), la
réponse porte désormais **le code et l'indication réels** : tout échec d'import auparavant annoncé
comme `internal/unexpected` porte maintenant sa cause.

**Contrôle hors TV, avant de monter sur la TV** (mêmes commandes que l'application, service
embarqué) :

```bash
IPTV_HOST=<portail>:8080 IPTV_USER=<compte> IPTV_PASS=<mot de passe> npm run verify:portal   # IPTV_ID=123492 pour viser une chaîne
```

Le contrôle importe le catalogue live, relit page/tranches/détail, résout un flux et **lit le flux
pour de bon** (redirections suivies, `video/mp2t`, synchronisation MPEG-TS). Aucun identifiant n'est
journalisé ; rien n'est écrit dans le dépôt (répertoire temporaire).

**Contrôle hors application** (shell développeur) : les commandes sont `public: false`, donc

```bash
luna-send -n 1 -f 'luna://com.ouagkamel.app.iptvplayer.service/diagnostics' '{}'
```

doit répondre depuis l'application, tandis qu'un appel émis depuis une **autre** application doit
échouer (contrôle 0A « aucune commande appelable depuis une autre application »).

---

- [ ] `ares-package` + `ares-install` du paquet sur la TV webOS 6 moyenne/faible.
- [ ] Spotlight : D-pad complet sur quatre écrans factices, mode pointeur, clavier virtuel.
- [ ] Touche **Back (461)** : une pression = un niveau ; comportement à la racine.
- [ ] Service JS joignable en LS2 ; `services.json` accepté avec `commands` **et** `public: false`
      (vérifier qu'aucune commande n'est appelable depuis une autre application).
- [ ] **ACG réellement accordées** : relever dans les journaux LS2 les permissions refusées, en
      particulier pour DB8 (`com.webos.service.db`) et `time.query`. Consigner les noms exacts
      obtenus — le §2.6 les traite comme « à valider en 0A », pas comme acquises.
- [ ] Écriture dans le répertoire privé du service sous `/media/internal`, relecture après mort du
      service, persistance après redémarrage de la TV.
- [ ] `process.versions.node` et `process.versions.openssl` lus **sur l'appareil** (sans donnée
      sensible) : confirmer Node 8.12 et la version d'OpenSSL du firmware.
- [ ] Appel sortant `player_api.php` depuis le service : aucun port en écoute côté service.

## 0B — Lecteur et pipeline média

Pour chaque cellule (modèle × format × codec) : *smoke* 1–3 essais en développement, puis
**qualification 10/10** ; seul le niveau **certification 30 (≥ 29/30) ou 20/20** autorise le mot
« certifié » (§11.2).

- [ ] HLS (`.m3u8`) ; MPEG-TS progressif (`.ts`) ; URL **sans extension** avec `Content-Type`
      correct, absent, puis générique.
      *Premier relevé (2026-10-08, appareil de l'essai)* : le lecteur a refusé le **MPEG-TS
      progressif** (`MediaError 4`) alors que le flux était servi (302 → 200 `video/mp2t`) ; depuis
      0.1.15 le format est choisi d'après `canPlayType` et l'autre conteneur est essayé une fois.
      La ligne « formats de flux déclarés » de la page de diagnostic donne la valeur exacte à
      consigner ici.
- [ ] Redirect 302 même hôte, puis autre hôte. HTTP clair (avertissement une fois par profil/hôte).
- [ ] H.264, HEVC, MPEG-2, AAC, AC-3, E-AC-3, 1080i, plus au moins un cas non supporté à consigner.
- [ ] Zapping coalescé : le flux précédent est **fermé** avant le suivant (aucun second décodeur).
- [ ] Zapping : p50 ≤ 4 s et p95 ≤ 8 s, mesurés depuis la dernière pression de la rafale.
- [ ] Première image : p95 ≤ 15 s sur réseau de labo stable ; 20 s sans image ⇒ message + Réessayer.
- [ ] Batterie par **famille de modèles** : deux TV de même version webOS mais de gammes
      différentes ne se couvrent pas l'une l'autre.
- [ ] Comptes de test **dédiés** (`max_connections` documenté), jamais un compte utilisateur.

## 0C — Un fournisseur de chaque type

- [ ] Portail Xtream autorisé, catalogue jouet (1 catégorie, 10–20 chaînes, 1 film, 1 série) :
      `player_api`, appel « tous les flux », construction des `streamRef`.
- [ ] `resolveStream()` : URL de session, expiration, re-résolution sur `403`, jamais journalisée.
- [ ] Playlist M3U autorisée : identité `logicalKey`/`variantKey` sur un catalogue jouet contenant
      `TF1 HD` / `TF1 FHD` / `TF1 4K`, un `tvg-id` dupliqué, deux variantes de serveurs distincts.
- [ ] Classification `hasCredential` : URL de CDN public non classée secrète.

## 0D — Gros catalogue, secrets, réseau

- [ ] Import de **250 000 entrées / 256 Mio décompressés** : temps, RSS et heap du service, espace
      disque, **pic disque incluant l'ancien index** (≈ 2 × index + temporaire).
- [ ] Annulation d'import en cours : l'index validé reste en place et lisible.
- [ ] `ImportJob` reprenable après mort du service à ~60 % (relecture par `getImportJob`).
- [ ] Bascule d'index pendant une pagination : `catalog/indexChanged`, rejeu au même ancrage.
- [ ] Recherche sur 250 k entrées : première page p95 ≤ 250 ms ; `getPage` p95 ≤ 120 ms ;
      `getBuckets` ≤ 50 ms. **Sans ces mesures, `titleSparseKeyBytes` et `searchIndexKind` restent
      ouverts (§15.6).**
- [ ] Coût du chiffrement par bloc mesuré sur la TV de référence (pas de KDF sur le chemin chaud).
- [ ] TLS par pile : `process.versions.openssl`, TLS 1.2, TLS 1.3-only, **chaîne à racine récente**
      (ISRG Root X2). Si le magasin figé échoue, embarquer un bundle de racines publiques (source,
      date, licence consignées) et **sans aucun contournement** (`rejectUnauthorized` jamais false).
- [ ] Refus de loopback/IP privée à la lecture (y compris `2130706433`, `0177.0.0.1`, `[::1]`),
      puis lecture possible après **autorisation LAN explicite du profil**.
- [ ] Sondes MIME : métadonnées d'abord, sonde interdite si `max_connections ≤ 1`.

## Contrôle de distribution — go/no-go bloquant

À lancer **au début de 0A** et à trancher **avant V1-B**. Trame de question à envoyer par écrit via
LG Seller Lounge :

> Notre application est un lecteur : elle ne fournit, ne découvre, ne partage et ne vend aucun
> contenu, aucune playlist et aucun identifiant. L'utilisateur configure lui-même une source
> (portail compatible Xtream ou playlist M3U) qu'il déclare être autorisé à utiliser. L'application
> ne contourne aucun DRM, ne met en place aucun proxy, n'intègre aucun SDK tiers publicitaire et
> n'utilise aucune ressource de l'appareil en dehors de la lecture demandée par l'utilisateur.
> Questions : (1) ce modèle est-il acceptable pour une publication sur le Content Store ;
> (2) quelles mentions obligatoires doivent figurer (page confidentialité, mention « cette
> application ne fournit aucun contenu ») ; (3) quels pays de distribution sont autorisés ;
> (4) quelles sont les exigences et le calendrier de revue (pretest, function test, content test) ?

- [ ] Question envoyée, accusé de réception conservé.
- [ ] **Réponse écrite** obtenue (acceptabilité, mentions, pays, revue).
- [ ] Self-checklist LG remplie et **téléversée** avec la soumission (son absence entraîne un rejet).
- [ ] Applications comparables déjà publiées vérifiées sur le Content Store.

Un refus ou une condition inacceptable **n'a pas de repli silencieux** : il change le produit ou le
mode de distribution, et se tranche ici.
