## Page noire : corrigée (0.1.10)

Trois défauts distincts se masquaient derrière le même écran noir. Les trois sont corrigés, et chacun
est désormais couvert par un contrôle automatique.

### 1. Chargement des données de langue (corrigé en 0.1.9)

Enact charge ses données de langue au premier `$L()` d'un composant Sandstone — et il le fait **en
synchrone** :

```
$L(...) → createResBundle({sync:true}) → new ilib.ResBundle
        → IString.loadPlurals() → Utils.loadData({sync:true})
        → EnyoLoader.loadFiles(sync) → loadManifestsSync()
        → XMLHttpRequest SYNCHRONE sur « <base>/locale/ilibmanifest.json »
```

En `file://`, un XHR synchrone vers un fichier absent **lève une exception** ; elle remontait au milieu
d'un rendu React, qui démontait l'arbre. Le paquet ne contenait aucune donnée de langue : le fichier
manquait. `ui/src/services/sansLocales.js` neutralise désormais ce chargement avant tout rendu
(chargeur inerte + paquet de chaînes vide) : plus aucune requête, donc plus d'échec possible.

### 2. Thème Sandstone jamais appliqué (corrigé en 0.1.10)

L'application se rendait directement dans `#root`, sans `ThemeDecorator`. Ce décorateur est ce qui pose
la police (`Sandstone`), la couleur du texte, le fond, le **Spotlight** (navigation à la télécommande) et
la résolution. Résultat : police Times New Roman, **texte noir sur fond noir** — quatre cartes
parfaitement dessinées et parfaitement invisibles, **sans aucune erreur**.

`ui/src/index.js` applique maintenant `ThemeDecorator(App)` avant le rendu, et `ui/src/App/App.js`
transmet la classe reçue à son nœud racine, comme Sandstone l'exige.

### 3. Polices du thème absentes des livrables (corrigé en 0.1.10)

Le build laisse les polices sous `ui/dist/node_modules/@enact/sandstone/fonts/` et `main.css` les
réclame par un chemin relatif — mais l'empaquetage ne recopiait que `main.js` et `main.css`
(`copyTree` ignore `node_modules`, à juste titre pour les dépendances). Trois polices répondaient 404,
dont `Sandstone_Icons`, sans repli sur la TV : les pictogrammes auraient été absents. L'empaquetage
copie désormais ces ressources (1,28 Mo, polices comprises) et **échoue** si `Sandstone_Icons.ttf`
manque.

### Ce qui a été mis en place pour le voir

| Outil | Rôle |
|---|---|
| `tools/render-app.js` | Banc headless (jsdom) : exécute le paquet réel avec un `XMLHttpRequest` imitant Chromium en `file://`. Rapporte requêtes, requêtes ratées, erreurs, **présence du thème**, **ressources manquantes** du CSS, texte rendu |
| `tools/inspecter-rendu.js` | Contrôle **visuel** (Chromium, facultatif) : styles calculés, **contraste texte/fond**, capture d'écran |
| `tests/render.test.js` | Verrouille les trois défauts : neutralisation i18n, thème appliqué, polices présentes dans le bundle **et** dans le paquet |

Contre-épreuves exécutées : correctif i18n retiré → échec ; `ThemeDecorator` retiré du bundle → échec
(sans erreur ni requête) ; polices retirées de l'arborescence → échec.

### État des contrôles

| Contrôle | Résultat |
|---|---|
| `npm test` | **203 tests, 0 échec** (Node 20 **et** Node 8.12) |
| `npm run lint:node812` / `check:deps` / `typecheck` | OK |
| Banc headless (paquet d'essai et livraison publique) | `verdict OK`, `theme: true`, `requetes: []`, `ressourcesManquantes: []` |
| Contrôle visuel (Chromium) | police `Sandstone`, texte `rgb(230,230,230)`, **contraste 16,83** (1,00 = noir sur noir), aucune ressource en échec, capture jointe à la version |

### À savoir

Les pictogrammes des tuiles utilisent la police système **« LG Icons »**, fournie par les téléviseurs LG.
Hors TV LG (simulateur sur poste sans cette police), Sandstone affiche le nom de l'icône à la place
(« liv », « mo »…). C'est le comportement prévu par Enact, pas un défaut du paquet.

### Installer

```bash
ares-install --device tv com.ouagkamel.app.iptvplayer_0.1.10_all.ipk
ares-launch  --device tv com.ouagkamel.app.iptvplayer
```

Le paquet d'essai (champs préremplis avec le compte de test) est hors dépôt :
`release/local/` — jamais publié, avec son mode d'emploi `LISEZ-MOI-ESSAI.txt`.

L'essai sur **TV réelle** reste le critère bloquant de la phase 0A (`docs/PHASE-0.md`).
