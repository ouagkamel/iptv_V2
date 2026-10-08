## Correctif écran noir — 0.1.9

### Le défaut

Dans le simulateur, la 0.1.8 affichait une **page noire** juste après
`[iptv-ui] application prete (pont LS2 : PalmServiceBridge)` :

```
main.js:2 DOMException: Failed to execute 'send' on 'XMLHttpRequest':
  Failed to load '.../app/node_modules/ilib/locale/ilibmanifest.json'
```

### La cause, en cinq lignes

Enact charge des données de langue au premier `$L()` d'un composant Sandstone (`Header`, `useScroll`…)
— et il le fait **en synchrone** :

```
$L() → toIString() → createResBundle() → new ilib.ResBundle        (sync: true)
     → IString.loadPlurals() → Utils.loadData({sync: true})
     → EnyoLoader.loadFiles(paths, sync=true) → loadManifestsSync()
     → XMLHttpRequest SYNCHRONE sur « <base>/locale/ilibmanifest.json »
```

La 0.1.8 ne livrait aucune donnée iLib (locales exclues à la construction, 72 Mio évités) : le
manifeste était donc **absent**. Or, en `file://`, un XHR synchrone vers un fichier absent lève une
exception — au milieu d'un rendu React. L'arbre est démonté : écran noir.

### Le correctif

`ui/src/services/sansLocales.js`, appelé **avant le premier rendu** :

1. **chargeur inerte** — `ilib.setLoaderCallback()` reçoit un objet qui répond « donnée absente »
   sans jamais émettre de requête : plus rien à charger, donc plus rien à échouer ;
2. **paquet de chaînes vide** — `setResBundle()` : `$L()` renvoie la chaîne source, exactement ce
   qu'Enact fait pour une traduction absente. Plus de `ResBundle`, donc plus d'appel au chargeur.

Les textes de l'application sont écrits en français dans le code : rien de visible ne change. Les
libellés internes de Sandstone (accessibilité, lecteur média) restent en anglais — assumé, documenté.

### Comment le vérifier sans simulateur

Un **banc headless** (`tools/render-app.js`, jsdom) exécute le paquet réel — `index.html`,
`profils.js`, `ui/main.js` — avec un `XMLHttpRequest` qui imite Chromium en `file://` (fichier
présent : statut 0 + corps ; fichier absent : exception). Il rapporte requêtes, requêtes ratées,
erreurs et DOM rendu :

```bash
node tools/render-app.js release/package
# { "verdict": "OK", "requetes": [], "requetes_ratees": [], "erreurs": [],
#   "texte_rendu": "IPTV V2 … Live TV … Films … Séries … Réglages …" }
```

Trois tests le verrouillent (`tests/render.test.js`) : neutralisation avant rendu, aucun module de
`ui/src` ne demande de fichier de langue, et le bundle construit démarre **sans aucune requête** en
rendant les quatre cartes. **Contre-épreuve** : correctif retiré → 195 OK, **1 échec**.

### État des contrôles

| Contrôle | Résultat |
|---|---|
| `npm test` | **196 tests, 0 échec** (Node 20 **et** Node 8.12) |
| `npm run lint:node812` / `check:deps` / `typecheck` | OK |
| Banc headless sur le paquet d'essai | `requetes: []`, `erreurs: []`, accueil rendu, source préconfigurée lue |
| Banc headless sur la livraison publique | idem, sans source (aucun identifiant) |

### Installer cette version

```bash
ares-install --device tv com.ouagkamel.app.iptvplayer_0.1.9_all.ipk
ares-launch  --device tv com.ouagkamel.app.iptvplayer
```

Simulateur : extraire `0.1.9-simulateur.zip` dans un dossier personnel, *File > Add Service*
(`service/com.ouagkamel.app.iptvplayer.service`), *Tools > Service List* pour démarrer, puis
*File > Launch App* (`app/`).

**Le paquet d'essai** (champs préremplis avec le compte de test) vit hors dépôt :
`release/local/com.ouagkamel.app.iptvplayer_0.1.9_all.ipk` et
`release/local/0.1.9-simulateur-source.zip` — jamais publiés, avec le mode d'emploi
`release/local/LISEZ-MOI-ESSAI.txt`.

### Ce qui reste à faire

L'essai **sur TV réelle** reste le critère bloquant de la phase 0A (`docs/PHASE-0.md`) : installation,
journaux LS2, DB8, écrans à la télécommande, puis qualification du lecteur en 0B.
