## Paquet de diagnostic — phase 0A (0.1.7)

### Portail en HTTP clair : plus besoin de chercher pourquoi

Vos deux erreurs (`security/insecurescheme` au test de source, `internal/unexpected` à l'import)
avaient **la même cause** : l'autorisation « portail en HTTP clair » (§8.2), que rien ne permettait
d'accorder et que le service ne savait pas expliquer.

| Réf. | Défaut | Correctif |
|---|---|---|
| D-26 | Le refus `security/insecureScheme` n'était **actionnable nulle part** : ni case à cocher, ni hôte à confirmer, et l'import partait quand même pour échouer plus loin | le service répond `security/insecureScheme` **avec l'hôte à confirmer** (`hint: hote:<hôte>`) au test **comme** à l'import ; l'import **refuse immédiatement** (aucun job lancé) ; la page porte la case **« Portail en HTTP clair : j'autorise »**, la coche automatiquement sur demande du service, affiche un bandeau d'explication avec bouton **Relancer** et mémorise le choix par hôte |
| D-27 | `importPlaylist` répondait `internal/unexpected — « import interrompu avant la bascule »` pour **n'importe quel** échec | la réponse finale transporte la **cause réelle** (`auth/*`, `network/*`, `security/*`) : `outcome.error` est une forme sérialisée, désormais relue et reconstituée en erreur typée |
| D-28 | Il fallait ressaisir identifiants et adresse à chaque essai | une **source préconfigurée** : la page propose le portail dans une liste et remplit adresse, profil et identifiants (l'autorisation HTTP clair se coche si l'adresse est en `http://`) ; il ne reste qu'à cliquer **Tester la source** puis **Importer (live)** |

Les identifiants d'une source préconfigurée vivent dans `secrets.local/profils.js`, **hors dépôt**
(`.gitignore`) ; ce fichier remplace `src/app/profils.js` au moment de l'empaquetage. `npm run dist`
intègre la source s'il existe ; `IPTV_SANS_SOURCES=1 npm run dist` construit sans elle, et
`tools/publish-release.js` **refuse de publier** une livraison qui l'embarque (vérifié : refus
explicite, aucune écriture sur GitHub).

### Validation sur portail réel (compte de test)

`npm run verify:portal` → **CONTROLE REUSSI** : compte `Active` (échéance 05/11/2026), formats
`m3u8`/`ts`, import live **5 659 entrées en 1,6 s** (1 858 527 octets), page de 200 objets, 27
tranches, recherche, détail sans secret (mode `derived`), `resolveStream` → **302** → `HTTP 200
video/mp2t`, **1 051 643 octets réellement lus**, MPEG-TS vérifié (`0x47` tous les 188 octets).
Hors ligne : **183 tests, 0 échec** sur Node 20 **et** Node 8.12.

### Rappel simulateur

`0.1.7-simulateur.zip` (sans source préconfigurée, comme toute livraison publiée) : extraire dans un
dossier personnel, puis *File > Add Service* (`service/com.ouagkamel.app.iptvplayer.service`),
*Tools > Service List* pour démarrer, *File > Launch App* (`app/`). Un `.ipk` n'enregistre jamais le
service sur un simulateur.
