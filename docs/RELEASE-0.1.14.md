## `-3963 db: permission denied` sur `putKind` : le propriétaire du kind (0.1.14)

Le diagnostic de 0.1.13 a montré que le nom du service était le bon — **`com.palm.db` répond** — mais
que la base refuse la création du kind :

```
"erreur": "appel LS2 refuse (-3963) : db: permission denied (luna://com.palm.db/putKind)",
"sonde":  "echec (ecriture/relecture du temoin) : … permission denied"
```

`-3963 db: permission denied` n'est pas un refus du bus (une ACG refusée produit un autre message,
« Denied method call … ») : c'est le **moteur de permissions de DB8** qui refuse. La règle est dans
`MojDbKind::configure()`, appelée pour **toute** création de kind :

```cpp
m_owner = owner;                       // le paramètre `owner` de putKind
checkPermission(OpKindUpdate, req);    // -> if (hasOwnerPermission(req)) return;  else deny();
bool MojDbKind::hasOwnerPermission(req) { return (req.admin() || req.domain() == m_owner); }
```

Autrement dit : **`owner` doit être le domaine de l'appelant**. Nous envoyions l'identifiant de
l'**application** (`com.ouagkamel.app.iptvplayer`) alors que l'appelant est le **service** : la base
refuse, et aucune ACG ne rattrape cela.

### Le correctif

Le client essaie les deux valeurs plausibles de `owner`, **dans l'ordre** :

1. l'identifiant de l'application — c'est le domaine des applications, et c'est ce que la purge des
   kinds `private` attend à la désinstallation ;
2. le nom du service (`…iptvplayer.service`) — le domaine des services JS.

Le premier accepté est **retenu pour la session** et affiché par le diagnostic (`db.owner`). Un refus
`-3963` sur la première valeur déclenche le second essai ; toute autre erreur remonte telle quelle. Si
aucune des deux n'est acceptée, le message nomme **les deux** valeurs essayées — la prochaine capture
suffira à trancher.

### Deux corrections d'à-côté

| Réf. | Constat | Correctif |
|---|---|---|
| **D-43a** | `owner` valait toujours l'ID de l'application ; DB8 n'accepte que le domaine de l'appelant (`req.domain() == owner`), création comprise | Deux propriétaires essayés dans l'ordre, celui qui répond est retenu (`db.owner`) |
| **D-43b** | L'indice d'erreur du pont répétait la méthode : `luna://com.palm.db/putKind/putKind` — `hostLabel` rendait « hôte/méthode » et le remplaçait au même endroit | `hostLabel` rend **le seul nom du service** ; l'indice est `luna://com.palm.db/putKind` |
| **D-43c** | La bannière parlait d'ACG pour tout refus de permission, et ne distinguait pas le refus de DB8 de celui du bus | La bannière explique la règle du propriétaire, cite `db.owner`, et ne demande de vérifier les ACG que si le refus persiste |

### État des contrôles

| Contrôle | Résultat |
|---|---|
| `npm test` | **233 tests, 0 échec** (Node 20 **et** Node 8.12) |
| `npm run lint:node812` / `check:deps` / `typecheck` | OK |
| Garde des pièces publiées (ipk) | « publiable » |
| Identifiants du compte de test | 0 occurrence (ipk et les deux archives) |
| Paquet inspecté | `OWNERS_DB8`, règle `-3963`, indice d'erreur sans doublon, `db.owner` au diagnostic |

### Ce qu'il faut essayer, dans cet ordre

1. Installer 0.1.14 par-dessus l'installation existante.
2. *Réglages* → **« Page de diagnostic (0A) »** : attendu `db.ok: true`, `db.service: com.palm.db`,
   **`db.owner: com.ouagkamel.app.iptvplayer.service`** (le nom du service — c'est la valeur que DB8
   devrait accepter), sonde `ok (ecriture puis relecture indexee)`.
3. *Live TV* : les catégories doivent s'afficher sans bandeau.
4. Si `db.owner` vaut l'identifiant de l'application, la plateforme accepte ce domaine : tant mieux,
   mais c'est le nom du service qui devrait apparaître ici.
5. Si `db.ok` est encore `false` : recopier `db.service`, `db.owner` et `db.erreur` — le message
   nomme désormais les deux propriétaires essayés et la cause exacte.

> Les pictogrammes des tuiles viennent de la police système « LG Icons » des téléviseurs LG : hors TV
> LG (simulateur sur poste sans cette police), les noms s'affichent à la place des icônes. Ce n'est pas
> un défaut.
