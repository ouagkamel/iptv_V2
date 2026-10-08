## « creation du kind DB8 refusee » : la reponse du hub etait lue au mauvais niveau (0.1.12)

Le bandeau observe sur le simulateur avec 0.1.11 — **« Le service repond, mais la base DB8 ne l'est
pas : creation du kind DB8 refusee »** — ne venait pas de DB8. Le service interrogeait bien la base ;
il ne lisait simplement pas la reponse la ou elle se trouve.

### La cause

Le module `webos-service` livre la reponse d'un appel dans un objet **`Message`**, dont la charge
utile est le champ **`payload`** :

```js
// lib/service.js (webos-service) — l'appel a un service
request.addListener("response", function (msg) { callback(new Message(msg, handle)); });
// lib/message.js — ce que contient ce Message
this.payload = JSON.parse(message.payload());
```

Notre pont LS2 lisait `message.returnValue`, `message.errorCode`, `message.results` **au premier
niveau** : ces champs n'y sont pas. Trois consequences, dont deux etaient deja visibles :

| Ref. | Constat | Correctif |
|---|---|---|
| **D-41a** | Un `putKind` **reussi** passait pour refuse (`returnValue` lu `undefined`, donc `!== true`) : l'import s'arretait sur « creation du kind DB8 refusee », sans code ni texte — exactement le message observe | `createLs2Caller` deplie `message.payload` ; la forme « a plat » reste acceptee (deux familles de hub) |
| **D-41b** | Une lecture **servie** passait pour vide (`results` absent) : c'est la meme cause que le bandeau « cle maitre absente » de 0.1.11 — la cle etait ecrite puis relue dans le vide | `find` / `put` / `del` / `merge` travaillent desormais sur la charge utile reelle ; un refus remonte **toujours** avec son code et son texte |
| **D-41c** | La tolerance « le kind existe deja » (versions de DB8 qui refusent au lieu de mettre a jour) vivait sur le chemin « reponse », jamais sur le chemin « rejet » du pont : elle etait inoperante | Tolerance conservee **sur les deux chemins**, et **sans desserrer le garde d'index** (un kind sans index fait toujours echouer l'ecriture, jamais une lecture vide) |
| **D-41d** | Le faux bus parlait un dialecte plus permissif que le service : `find` avec `where` en objet, `incDel` hors requete, `private` envoye a `put` | Le faux bus applique les **schemas reels** (`MojDbServiceSchemas.cpp`) : `from` obligatoire, `where` en tableau de `{prop, op, val}`, `limit` 0-500 dans la requete, `put` limite a `objects`/`shardId`, cles inattendues refusees (`-4029`) |

### Pourquoi les tests ne l'avaient pas vu

Le banc branchait `Db8Client` **directement** sur le faux bus : le pont n'etait jamais traverse, donc
l'enveloppe du hub non plus. Le banc passe maintenant aussi par un faux `webos-service` qui livre ses
reponses **dans `message.payload`**, comme l'appareil : cinq tests couvrent l'aller-retour complet, la
propagation d'un refus avec code et texte, la forme « a plat », la tolerance « kind deja la » et le
maintien du garde d'index.

### Ce qui n'a pas change

Les kinds (v2), les index declares, la reprise v1 vers v2 et le chiffrement de l'index sont
inchanges : 0.1.12 est une correction de **transport**, pas de schema. Le catalogue deja importe
reste lisible (la cle maitre reprise par 0.1.11 reste celle de l'index).

### Etat des controles

| Controle | Resultat |
|---|---|
| `npm test` | **220 tests, 0 echec** (Node 20 **et** Node 8.12) |
| `npm run lint:node812` / `check:deps` / `typecheck` | OK |
| Banc headless (paquet public `dist/0.1.12/app`) | `verdict OK`, `theme: true`, `requetes: []`, `ressourcesManquantes: []` |
| Garde des pieces publiees (ipk) | « publiable » — aucune source preconfiguree, aucun identifiant |
| Identifiants du compte de test | 0 occurrence dans l'ipk **et** les deux archives (controle sur pieces re-telechargees) |

### Ce qu'il faut essayer, dans cet ordre

1. Installer 0.1.12 par-dessus l'installation existante (profil et index deja importes attendus).
2. Accueil : quatre cartes lisibles ; rien a reimporter.
3. **Live TV** : les categories s'affichent sans bandeau — c'est le point corrige.
4. Reglages -> « Importer (live) » uniquement si les categories restent vides.
5. En cas de doute : Reglages -> « Page de diagnostic (0A) ». La ligne **sonde** doit afficher
   `ok (ecriture puis relecture indexee)` et `db.ok` doit valoir `true` ; toute autre reponse est a
   consigner telle quelle dans `docs/PHASE-0.md` §0A.

> Les pictogrammes des tuiles viennent de la police systeme « LG Icons » des televiseurs LG : hors TV
> LG (simulateur sur poste sans cette police), les noms s'affichent a la place des icones. Ce n'est pas
> un defaut.
