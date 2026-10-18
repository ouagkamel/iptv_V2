# Essai 0A — téléviseur LG webOS 6+ (version 0.1.17)

Feuille de route à exécuter **devant la TV**. Elle prouve le critère bloquant de la phase 0 :
le socle applicatif tient sur un vrai téléviseur (service node, LS2, DB8, stockage privé,
permissions, TLS) et l'interface s'enchaîne au doigt. Le détail normatif est dans
`docs/PHASE-0.md` (§0A) ; ce document est la version « à suivre pas à pas », avec les preuves
attendues et la fiche de relevé à renvoyer telle quelle.

Durée : ~20 min la première fois. Aucune commande de ce document ne publie quoi que ce soit.

## 0. Pièces et prérequis

| Pièce | Où |
|---|---|
| Paquet d'**essai** (source de test préconfigurée) | `release/local/com.ouagkamel.app.iptvplayer_0.1.17_all.ipk` |
| Mode d'emploi court livré avec le banc | `release/local/LISEZ-MOI-ESSAI.txt` |
| Pack simulateur (banc hors TV) | `release/local/0.1.17-simulateur-source.zip` |

- [ ] Outillage LG installé : `npm i -g @webosose/ares-cli`
- [ ] TV **webOS 6 ou plus**, sur le réseau local, application **Developer Mode** activée
      (même compte LG que celui qui a créé la clé) ; le mode développeur **expire au bout de
      1000 h** — s'il est tombé, `ares-install` répond `connection refused`.
- [ ] Rien d'autre n'est nécessaire : le paquet d'essai embarque déjà le pont LS2, le service
      complet et la source de test (champs préremplis dans l'interface).

**Correctif 0.1.17 (D-46) à contrôler ici :** DB8 exige `_rev` pour mettre à jour un objet existant. La progression d’import réécrit une même ligne de job ; le parcours doit aller jusqu’à `done`, sans `-3960` (« _rev must be specified ») ni `-3961` (révision périmée).

⚠️ Le paquet d'essai contient les identifiants du **compte de test**. Il ne se publie pas, ne se
pousse pas, ne se partage pas. À la fin de la campagne, le désinstaller de la TV
(`ares-install --device tv -r com.ouagkamel.app.iptvplayer`).

## 1. Installation

```bash
ares-setup-device --add tv --info "host=<IP de la TV>" --passphrase   # la TV affiche la phrase
ares-device   --device tv --system-info                               # doit répondre : mode développeur visible
ares-install  --device tv release/local/com.ouagkamel.app.iptvplayer_0.1.17_all.ipk
ares-launch   --device tv com.ouagkamel.app.iptvplayer
ares-log      --device tv --follow                                    # dans un second terminal
```

- [ ] Journal du service (l'ordre compte) :
      `[iptv] demarrage du service … (node v8.12.x)` **puis** `… service enregistre aupres du hub LS2 : 12 commandes`.
      *Si la première ligne manque* : le service n'a jamais été lancé (enregistrement côté TV).
      *Si la seconde manque* : la cause est affichée juste après.
- [ ] Accueil : **quatre cartes** (Live TV, Films, Séries, Réglages), texte clair sur fond noir.

## 2. Contrôles du socle (page de diagnostic)

*Réglages* → **« Page de diagnostic (0A) »**. Chaque ligne a une preuve attendue ; recopier la
valeur observée dans la fiche (§5). Aucun identifiant ne doit apparaître nulle part.

| # | Action dans la page | Preuve attendue |
|---|---|---|
| 1 | La page s'ouvre : **bannière** et **témoin du bus** | le témoin répond — le pont LS2 de l'application fonctionne |
| 2 | **Diagnostic du service** | `returnValue: true` ; `runtime.node = 8.12.x` ; version d'OpenSSL du firmware ; `roots.chain` = bundle embarqué ; `indexes: []` (aucun index avant import) |
| 3 | **Tester la source** | `data.ok: true` avec `account.status`, `expiresAt`, `formats` ; le journal ne montre **aucun identifiant** |
| 4 | **Importer (live)** | progression `downloading → parsing → writing → validating → swapping → done`, puis `data.final: true` ; en 0.1.17, la ligne DB8 du job est réécrite avec `_rev` : aucun refus `-3960`/`-3961` |
| 5 | **État de l'import** | `job.phase: done`, compteurs cohérents — **après redémarrage de la TV** |
| 6 | **Page** puis **Tranches** | `items[]` avec `ref.providerId`, **aucune URL** ; tranches alphabétiques non vides |
| 7 | **Détail** puis **Résoudre le flux** | `streamMode` (`storedSecret` ou `derived`) ; l'URL n'apparaît que si « afficher l'URL complète » est cochée ; le journal reste muet |
| 8 | **Diagnostic du service** à nouveau | `indexes[0].entryCount` = nombre de chaînes du portail ; `jobs[]` sans secret |
| 9 | Ligne **« formats de flux déclarés »** | copier la ligne entière : ordre d'essai, `canPlayType` par format, et le **support MSE** (nouveau en 0.1.16) |
| 10 | Bouton **« Tester le repli MSE »** | fichier présent dans le paquet ; `Hls.isSupported()` répond (résultat à recopier) |
| 11 | **Supprimer le profil** (en fin de campagne) | `deleted: true`, `masterKeyRemoved: true` ; ensuite **Page** répond `catalog/indexMissing` |

Réponses DB8 à recopier telles quelles — c'est ainsi que se tranchent les incidents D-41 à D-43 :

- `db.ok` : …… ; `db.service` : …… ; `db.owner` : …… ; `db.erreur` : ……
- `sonde` : …… (attendu : `ok (ecriture puis relecture indexee)`)

## 3. Parcours dans l'application (socle et enchaînement)

| # | Action | Preuve attendue |
|---|---|---|
| 1 | **Spotlight** : parcourir les quatre cartes au D-pad, puis Réglages, Live TV, un écran de liste | focus visible qui suit le D-pad, sans saut ; mode pointeur OK si la télécommande en a un |
| 2 | **Live TV** → catégories → chaînes | catégories issues de l'**index** (aucun appel fournisseur), chaînes présentes après l'import |
| 3 | **OK sur une chaîne** | le lecteur s'ouvre — **voie native** (HLS déclaré par la plateforme) ; l'image et le son relèvent de la 0B, l'ouverture et la sortie de la 0A |
| 4 | Zapper sur une seconde chaîne, revenir | image rétablie ; l'ancien flux est **fermé** (aucun second décodeur) |
| 5 | **Touche Back (461)** : une pression = un niveau ; à la racine | lecteur → liste → accueil → sortie ; comportement à la racine à noter |
| 6 | Clavier virtuel (nom de profil ou saisie manuelle) | clavier de la plateforme affiché, saisie reportée dans le champ |

Si le lecteur **n'ouvre pas** l'image, noter le message exact : depuis 0.1.15 il **nomme les
formats essayés** (`hls`, `ts`, et `mse` depuis 0.1.16). Ce n'est pas un défaut à corriger ici :
c'est la mesure de la 0B (et la TV doit lire par la voie native — le repli MSE n'est pas destiné
à la TV).

## 4. Checklist 0A (items du plan)

- [ ] `ares-package` + `ares-install` du paquet sur la TV webOS 6 visée
- [ ] Spotlight : D-pad complet sur les quatre écrans, mode pointeur, clavier virtuel
- [ ] Touche **Back (461)** : un niveau par pression ; comportement à la racine consigné
- [ ] Service JS joignable en LS2 ; `services.json` accepté avec **12 commandes** et
      `public: false` partout (0 commande publique — contrôle : `luna-send` depuis le shell TV
      répond ; un appel émis depuis une **autre** application doit être refusé)
- [ ] **ACG réellement accordées** : relever dans les journaux LS2 les permissions refusées, en
      particulier pour DB8 (`com.palm.db`) et `time.query` — consigner les **noms exacts**
      observés (§2.6 les traite comme « à valider en 0A », pas comme acquises)
- [ ] Écriture dans le répertoire privé du service sous `/media/internal`, relecture après mort
      du service (`ares-inspect … -s … -o`), **persistance après redémarrage de la TV**
- [ ] `process.versions.node` et `process.versions.openssl` lus **sur l'appareil** → confirmer
      Node **8.12**
- [ ] Appel sortant `player_api.php` depuis le service : **aucun port en écoute** côté service
      (le service n'ouvre pas de serveur ; si le shell TV fournit `netstat`, relever la ligne
      du processus node)

## 5. Fiche de relevé (à renvoyer telle quelle)

```
TV : marque/modèle .........  webOS .........  (Réglages TV > Général > À propos)
Version installée (ares-install --device tv --listfull) : 0.1.17  [ ] oui  [ ] non  -> .........

Diagnostic du service
  runtime.node ................  runtime.openssl (ou version firmware) ................
  roots.chain .................  indexes ................
  db.ok ........  db.service ........  db.owner ........  db.erreur ........
  sonde ........................

Formats de flux déclarés (ligne entière) :
  ..........................................................................................
  support MSE : ........   « Tester le repli MSE » : ........   (fichier présent : ........)

Lecture (0A : ouverture/sortie ; image et son = 0B)
  chaîne choisie (n° dans l'abonnement) : ........   bandeau/message éventuel : ................
  image : [ ] oui  [ ] non   son : [ ] oui  [ ] non
  import D-46 (progression jusqu’à done, sans -3960/-3961) : [ ] réussi  [ ] échec
  zapping : [ ] immédiat  [ ] lent (…… s)  [ ] échec   — l'ancien flux est-il fermé ? [ ] oui [ ] non

Spotlight / D-pad : ............   Mode pointeur : ............   Clavier virtuel : ............
Back (461) : ............   À la racine : ............

Persistance : écriture /media/internal [ ] oui [ ] non ; relecture après mort du service [ ] oui [ ] non ;
  après redémarrage de la TV [ ] oui [ ] non
ACG : refus observés (texte exact) ............................................................
Journal (extrait sans identifiant, si anomalie) : ..............................................

Remarques libres : ...........................................................................
```

## 6. Dépannage express

| Symptôme | À faire avant de conclure à un bug |
|---|---|
| `connection refused` à l'installation | le mode développeur est tombé : le réactiver sur la TV |
| « Service does not exist » | désinstaller / réinstaller / redémarrer la TV (§0A du plan), puis `ares-inspect --device tv -s com.ouagkamel.app.iptvplayer.service -o` |
| Écran vide | *Réglages* → « Page de diagnostic (0A) », puis hors TV `node tools/render-app.js release/package` et `node tools/inspecter-rendu.js release/package` |
| `insecureScheme` | normal en `http://` : cocher « Portail en HTTP clair : j'autorise » et relancer (une fois par hôte) |
| Aucune image (lecteur) | noter le message (il nomme les formats essayés) + la ligne « formats de flux déclarés » : c'est une mesure 0B, pas un défaut 0A |

## 7. Après l'essai

1. Recopier la fiche (§5) dans `docs/JOURNAL.md` (entrée 0A) — **sans identifiant ni URL de flux**.
2. Nettoyer l'appareil : `ares-install --device tv -r com.ouagkamel.app.iptvplayer`.
3. Enchaîner : **contrôle de distribution LG** (`docs/DISTRIBUTION-LG.md`, go/no-go bloquant à
   lancer dès le début de la 0A), puis la **0B** (qualification média, `docs/PHASE-0.md`).
