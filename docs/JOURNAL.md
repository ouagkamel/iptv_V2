# Journal d'exécution

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
