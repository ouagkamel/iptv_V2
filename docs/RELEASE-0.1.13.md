## Base DB8 injoignable : le bon nom de service, et l'ACG déclarée (0.1.13)

Avec 0.1.12, le diagnostic a enfin livré la cause exacte que le bandeau masquait :

```
"db": {
  "ok": false,
  "erreur": "appel LS2 refuse (-1) : Service does not exist: com.webos.service.db",
  "sonde": "echec (ecriture/relecture du temoin) : appel LS2 refuse (-1) : Service does not exist: com.webos.service.db"
}
```

Le service répondait, la base non : **ce nom de service n'existe pas sur cette plateforme**. Trois
défauts, tous corrigés ici.

### 1. Le nom du service de base

LG documente la base des téléviseurs sous **`luna://com.palm.db`** (référence « Database » : *Service
URI - luna://com.palm.db*, table de compatibilité : « Database : Yes » sur simulateur), et ses
exemples officiels — DB8 owner/user — appellent ce nom-là, y compris dans le simulateur. Les images
webOS OSE exposent le **même** service sous `com.webos.service.db`. Nous n'appelions que ce second
nom.

Le client essaie désormais les deux, **dans l'ordre** `com.palm.db` puis `com.webos.service.db`, et
retient pour la session le premier qui répond. Un nom qui n'existe pas n'est plus une erreur : c'est
un essai suivant. Toute autre erreur (index, permission, schéma) remonte telle quelle, sans second
essai.

### 2. Un « exist » qui masquait l'échec

La tolérance « le kind existe déjà » (D-41c) cherchait la sous-chaîne `exist` : or **« Service does
not exist »** la contient. Conséquence : sur une base injoignable, `ensureKind` se croyait toléré et
l'import échouait plus loin, sur l'écriture, sans dire que le **service** manquait. La tolérance est
désormais restreinte (`already exists` ou `kind … exist`) ; « Service does not exist » redevient une
erreur franche, qui nomme le service essayé (D-42b).

### 3. Les ACG de la base n'étaient pas déclarées

`appinfo.json` ne demandait que `time.query`. Or l'accès à DB8 est soumis à ACG : **`database.operation`**
(écriture/lecture : `put`, `find`, `del`, `merge`) et **`database.management`** (`putKind`, `delKind`).
Sans elles, un appareil qui applique les ACG répond `-3963 db: permission denied`. Elles sont
maintenant déclarées — chacune justifiée par un appel réel du code, comme l'exige le §AppInfo de la
spécification.

### Ce que le diagnostic montre maintenant

| Champ | Signification |
|---|---|
| `db.service` | nom de service de base **retenu** (ou dernier essayé) : `com.palm.db`, `com.webos.service.db`… |
| `db.erreur` | cause exacte, avec le code et le texte du bus |
| `db.sonde` | `ok (ecriture puis relecture indexee)` quand la base répond **à cette requête** |

La bannière de la page de diagnostic a été réécrite dans le même esprit : elle affiche le nom de
service essayé, distingue « service inexistant » de « permission refusée » (ACG) et renvoie à
`docs/PHASE-0.md` §0A pour consigner le message exact.

### État des contrôles

| Contrôle | Résultat |
|---|---|
| `npm test` | **226 tests, 0 échec** (Node 20 **et** Node 8.12) |
| `npm run lint:node812` / `check:deps` / `typecheck` | OK |
| Banc headless (paquet public) | `verdict OK`, `theme: true`, 0 requête, 0 ressource manquante |
| Garde des pièces publiées (ipk) | « publiable » |
| Identifiants du compte de test | 0 occurrence (ipk et les deux archives) |

### Ce qu'il faut essayer, dans cet ordre

1. Installer 0.1.13 par-dessus l'installation existante.
2. Accueil : quatre cartes lisibles.
3. *Réglages* → **« Page de diagnostic (0A) »** : `db.ok` doit être `true`, `db.service` doit indiquer
   `com.palm.db`, la sonde `ok (ecriture puis relecture indexee)`.
4. *Live TV* : les catégories doivent s'afficher sans bandeau (les données déjà importées sont
   reprises : la clé maître n'a pas changé).
5. Si `db.ok` est encore `false` : recopier `db.erreur` **et** `db.service` tels quels. C'est
   désormais une cause précise (nom de service, ACG, index) et non plus un message générique.

> Les pictogrammes des tuiles viennent de la police système « LG Icons » des téléviseurs LG : hors TV
> LG (simulateur sur poste sans cette police), les noms s'affichent à la place des icônes. Ce n'est pas
> un défaut.
