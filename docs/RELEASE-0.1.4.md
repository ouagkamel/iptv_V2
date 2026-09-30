## Paquet de diagnostic — phase 0A (0.1.4)

**À lire avant d'installer** : sur un **simulateur webOS**, un `.ipk` n'enregistre **jamais** le
service. Le simulateur lance l'application depuis un **dossier** (*File > Launch App*) et n'accepte
un service que s'il est **ajouté explicitement** (*File > Add Service*, puis *Tools > Service List*
pour le démarrer). Sans ces deux gestes, le bus répond `Service does not exist` alors que
l'application tourne — ce n'est pas un défaut du paquet.

### Deux livraisons dans cette publication

| Fichier | Pour quoi |
|---|---|
| `com.ouagkamel.app.iptvplayer_0.1.4_all.ipk` | **téléviseur** : `ares-install --device tv …` |
| `0.1.4-simulateur.zip` | **simulateur** : à extraire dans un dossier personnel, puis *Add Service* + *Launch App* |
| `0.1.4.zip` | livraison complète (`dist/`) : ipk, contenu dépaqueté, pack simulateur, sommes |

### Procédure simulateur

```bash
unzip 0.1.4-simulateur.zip -d ~/iptv-simulateur     # sous votre dossier personnel (exigence du simulateur)
```

1. **File > Add Service** → `~/iptv-simulateur/service/com.ouagkamel.app.iptvplayer.service`
   (la racine du service est le dossier qui contient `package.json`) ;
2. **Tools > Service List** → cliquer sur le service pour le **démarrer** ;
3. **File > Launch App** → `~/iptv-simulateur/app` ;
4. dans la page : « Témoin du bus LS2 » (service du système) doit répondre, puis
   « Diagnostic du service » doit afficher `runtime.node`, `roots` et `indexes`.

Hors téléviseur, `/media/internal` n'existe pas : le service bascule sur un répertoire temporaire et
le journalise (le répertoire privé réel reste à valider sur la TV, §0A/0D).

### Correctifs de cette version

- **D-21** : pack et mode d'emploi pour le simulateur (`npm run stage:simulator`,
  `dist/<version>-simulateur.zip`), et rappel de la procédure dans la bannière de la page ;
- **D-22** : repli du répertoire de travail hors téléviseur — l'enregistrement du service auprès du
  bus n'en dépend jamais ;
- rappel des correctifs 0.1.1 → 0.1.3 : démarrage du service au chargement du module (D-09),
  pont LS2 embarqué au lieu de `webOSTV.js` absent (D-17), manifestes du service en ASCII (D-18),
  archive `dist/` complète (D-19), garde-fous et journal de démarrage (D-20).

### Vérifications

`npm test` : **161 tests, 0 échec** sur Node 20 **et** Node 8.12 (cible réelle du service) ;
pipeline complet rejoué hors TV sur un portail Xtream réel : connexion, 59/60/44 catégories live/VOD/
séries, import de 5 299 chaînes en 1,2 s, page de 200 objets en 6 ms, tranches, recherche, détail sans
secret, `resolveStream`, puis lecture réelle du flux (302 → `HTTP 200 video/mp2t`, `0x47` tous les
188 octets).
