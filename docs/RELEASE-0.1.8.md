## Application IPTV — phase 0A, incrément V1-A (0.1.8)

Cette livraison contient l'**interface Enact de V1-A** en plus du service webOS complet et de la page
de diagnostic. Elle est **sans source préconfigurée** (aucun identifiant) : le profil Xtream se saisit
dans *Réglages*, ou se prépare localement avec `secrets.local/profils.js` (voir `README.md`).

### Ce qui est livré

| Pièce | Contenu |
|---|---|
| **Service** | protocole LS2 (§15.4) : **douze commandes** non publiques — `testProfile`, `importerPlaylist`, `getCategories`, `getPage`, `getBuckets`, `search`, `getDetails`, `resolveStream`, `getImportJob`, `cancelOperation`, `deleteProfile`, `diagnostics` ; client HTTP §2.5, parseur incrémental, DB8, import reprenable, racines TLS embarquées, zéro dépendance d'exécution (Node 8.12 / ES2017) |
| **Interface Enact** | accueil à **quatre cartes** (Live TV, Films, Séries, Réglages) ; Live TV avec catégories issues de l'index et chaînes **paginées par le service** ; réglages du profil Xtream avec consentement « HTTP clair » (§8.2) ; **lecteur** `<video>` natif unique alimenté par `resolveStream()` ; navigation par `Panels`/`TabLayout` + Spotlight, touche Retour de la télécommande |
| **Page de diagnostic** | `diagnostic.html` : commandes LS2 une par une, témoin du bus, bannière d'explication, journal — joignable depuis *Réglages* → « Page de diagnostic (0A) » |

Films (V1-B) et Séries (V1-C) sont annoncés à l'écran — aucun écran vide trompeur.

### Contenu de l'archive

- `com.ouagkamel.app.iptvplayer_0.1.8_all.ipk` : paquet installable sur la TV ;
- `app/` : application telle qu'empaquetée (`index.html`, `ui/main.js`, `ui/main.css`,
  `diagnostic.html`, `profils.js`, `webos-bridge.js`, `format.js`, `assets/`) ;
- `service/<id>/` : service compilé (`services.json`, `lib/`, `assets/roots.pem`) ;
- `simulateur/` : dossier `app/` + `service/` à sélectionner dans le simulateur LG (voir son
  `LISEZ-MOI-SIMULATEUR.txt`) ;
- `SHA256SUMS.txt` : empreintes de tous les fichiers.

### Installation (TV en mode développeur)

```bash
npm i -g @webosose/ares-cli
ares-setup-device --add tv --info "host=<IP de la TV>" --passphrase
ares-install --device tv com.ouagkamel.app.iptvplayer_0.1.8_all.ipk
ares-launch  --device tv com.ouagkamel.app.iptvplayer
```

### Simulateur LG

Extraire `0.1.8-simulateur.zip` dans le dossier personnel, puis *File > Add Service* en choisissant
`service/com.ouagkamel.app.iptvplayer.service` (puis *Tools > Service List* pour le démarrer) et
*File > Launch App* sur `app/`. Sans l'ajout du service, toute requête répond
« Service does not exist » : le simulateur n'enregistre pas les services d'un `.ipk`.

### Ce qui reste à vérifier sur la TV (phase 0A/0B, critère bloquant)

L'installation, les journaux LS2 (`ares-log --device tv --follow`), DB8, l'écriture du catalogue
chiffré, le parcours complet de l'interface et la **qualification du lecteur** (HLS, MPEG-TS
progressif, codecs, 1080i) se déroulent sur téléviseur : procédure détaillée et preuves attendues
dans `docs/PHASE-0.md` §0A/§0B. Les budgets D-pad et le p95 de navigation se mesurent sur le
téléviseur (Chromium 79), pas sur le simulateur.

### État des contrôles dans le dépôt

`npm test` → **192 tests, 0 échec** (Node 20 et Node 8.12), `npm run lint:node812` → OK,
construction de l'interface (`npm run build:ui`) sans aucun avertissement, `npm run check:deps` → OK.
