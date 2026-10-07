# Vérification de la livraison 0.1.8 — l'artefact publié correspond-il au dépôt ?

Question posée : la livraison téléchargée depuis GitHub (`v0.1.8-phase0a`) est-elle **exactement** ce
que produit le dépôt au commit `5d058ae` ? Une archive publiée qui ne correspond pas à sa source est
le défaut le plus coûteux à découvrir plus tard, sur la TV, en pleine phase 0A.

## Méthode

1. les quatre pièces jointes publiées sont **retéléchargées depuis l'URL publique** ;
2. la livraison est **reconstruite ici** (`npm ci`, `npm --prefix ui ci`, `IPTV_SANS_SOURCES=1 npm run dist`) ;
3. les deux `SHA256SUMS.txt` sont comparés ligne à ligne, après retrait des lignes `.ipk`/`.zip`
   (une archive n'est pas reproductible octet à octet : `gzip` y inscrit un horodatage) ;
4. l'`.ipk` publié est dépaqueté et son `app/ui/main.js` est comparé au bundle reconstruit ;
5. les deux arbres sont fouillés à la recherche des identifiants du compte de test.

## Résultat

| Contrôle | Résultat |
|---|---|
| Fichiers de la livraison comparés | **98** |
| Identiques octet à octet | **97** |
| Seul écart | `app/ui/main.js` (bundle webpack) |
| Écart résiduel après neutralisation de l'horodatage | **aucun** — les deux bundles font 947 007 octets et deviennent identiques dès que `n.ilib_cache_id="<horodatage>"` est masqué |
| Identifiants du compte de test dans `dist/0.1.8/` | **aucun** (0 fichier) |
| Identifiants dans l'`.ipk` publié | **aucun** (0 fichier) |
| `app/profils.js` livré | identique au fichier du dépôt : `window.iptvProfils = window.iptvProfils \|\| { sources: [] }` |
| Tests | **192 OK, 0 échec** (Node 20 **et** Node 8.12) |
| `lint:node812`, `check:deps`, `typecheck` | OK |

L'écart unique a une cause connue : le greffon iLib d'Enact inscrit `n.ilib_cache_id = "<millisecondes>"`
dans le bundle, pour invalider le cache des données de langue côté navigateur. C'est donc le **seul**
octet non reproductible, et il ne change pas une ligne du programme.

Les archives (`.ipk`, `.zip`) diffèrent de quelques octets entre publication et reconstruction
(492 362 → 492 356 pour l'`.ipk`) : `gzip`/`zip` y inscrivent la date de création. Le **contenu**,
lui, est celui vérifié ci-dessus.

## Ce que cela établit — et ce que cela n'établit pas

**Établi** : l'`.ipk` publié est le produit du commit `5d058ae`, sans identifiant, reconstruit à
l'identique ici à l'horodatage iLib près.

**Non établi** : que l'application *fonctionne* sur un téléviseur. C'est l'objet de la phase 0A/0B
(`docs/PHASE-0.md`), et cela ne peut pas se mesurer dans ce dépôt : installation `ares-install`,
journaux LS2, DB8, parcours de l'interface à la télécommande, qualification du lecteur.

## Reproduire ce contrôle

```bash
npm ci && npm --prefix ui ci
IPTV_SANS_SOURCES=1 ARES_PACKAGE=$(command -v ares-package) npm run dist
# puis comparer dist/0.1.8/SHA256SUMS.txt avec le fichier publié (hors .ipk/.zip)
```

Le paquet d'**essai**, lui, vit hors dépôt (`release/local/`) : il porte la source préconfigurée
(`app/profils.js`), et le bundle reste sans identifiant — vérifié : `ui/main.js` ne contient aucune
occurrence de l'adresse du portail de test.
