## Paquet de diagnostic — phase 0A (0.1.3)

Version à installer : elle contient **toutes** les corrections nécessaires au premier essai sur la TV,
y compris celles découvertes en analysant votre capture d'écran.

### Ce qui était cassé

1. **D-09 — « Service does not exist »** : le service démarrait derrière `require.main === module`.
   Quand webOS charge le fichier `main` par `require()`, ce test est faux et le service ne
   s'enregistre jamais auprès du hub LS2. Le démarrage a lieu maintenant **au chargement du module**,
   et `index.js` (JavaScript brut, zéro dépendance) est le `main` du paquet.
2. **D-17 — `net::ERR_FILE_NOT_FOUND webOSTV.js`** : la page chargeait la bibliothèque du SDK LG, qui
   n'était pas empaquetée ; `window.webOS` restait vide, donc aucun appel LS2 ne partait de
   l'application. Un pont LS2 **embarqué** (`webos-bridge.js`) la remplace.
3. **D-18 à D-20** : manifestes du service en ASCII pur (fichier lu par le hub pour enregistrer le
   service) ; archive `dist/` complète (elle oubliait `webos-bridge.js`) ; garde-fous contre un
   fichier livré vide, et **journal de démarrage du service**.

### Diagnostic embarqué dans la page

Au chargement, la page affiche le pont réellement utilisé, la présence de `PalmServiceBridge` et
`PalmSystem`, le nom exact du service appelé, puis exécute un **appel de contrôle**. Si le bus répond
« Service does not exist », une bannière rouge affiche les gestes exacts à faire. Un bouton
**Témoin du bus LS2** interroge un service *du système* : s'il répond, le pont fonctionne et le
défaut est propre au service ; sinon, aucun appel LS2 ne sort de la page.

### Vérifications

- `npm test` : **157 tests, 0 échec** sur Node 20 **et** sur Node 8.12 (cible réelle du service) ;
- validation hors TV sur un portail Xtream réel, **exécutée sur Node 8.12** : test de connexion,
  import de 5 299 chaînes live en 1,2 s, page de 200 objets en 6 ms, tranches, recherche, détail sans
  secret, `resolveStream`, puis lecture réelle du flux (302 → `HTTP 200 video/mp2t`, `0x47` tous les
  188 octets) ;
- `.ipk` ouvert et vérifié fichier par fichier (service présent avec ses 11 commandes, page complète).
