## Paquet de diagnostic — phase 0A (0.1.6)

Deux erreurs rapportées (`security/insecurescheme` au test de source, `internal/unexpected` à
l'import) avaient **la même cause** : l'autorisation « portail en HTTP clair » (§8.2).

| Réf. | Défaut | Correctif |
|---|---|---|
| D-26 | Le refus `security/insecureScheme` n'était **actionnable nulle part** : aucun contrôle dans la page, aucun hôte à confirmer, et l'import partait quand même pour échouer plus loin | la page porte une case **« Portail en HTTP clair : j'autorise »** ; le service répond `security/insecureScheme` **avec l'hôte à confirmer** (`hint: hote:<hôte>`) au test de source **comme** à l'import, et l'import **refuse immédiatement** (aucun job lancé). La demande du service coche la case, ouvre un bandeau d'explication et propose **Relancer** en un clic ; le choix est mémorisé par hôte |
| D-27 | `importPlaylist` répondait `internal/unexpected — « import interrompu avant la bascule »` pour **n'importe quel** échec : la cause réelle (`auth/*`, `network/*`, `security/*`) disparaissait | la réponse finale transporte la cause réelle : `outcome.error` est une forme sérialisée, elle est **relue et reconstituée** en erreur typée ; test dédié (échec fournisseur pendant l'import → `auth/invalidCredentials`) |

### Ce qui change à l'usage

1. **Tester la source** sur un portail `http://` : le service répond qu'il faut l'autoriser, la case se
   coche, un bandeau explique le risque et propose **Relancer**. Une fois confirmé, le service
   l'enregistre **par hôte et par profil** : les appels suivants passent sans question.
2. **Importer** : si l'autorisation manque, l'import est refusé **tout de suite** avec l'hôte à
   confirmer — plus de job qui échoue après coup sans explication.
3. Tout échec d'import affiche désormais son **code réel** (`auth/expired`, `auth/invalidCredentials`,
   `network/http`, `security/insecureScheme`…) et son indication de reprise.

### Validation sur portail réel (compte de test neuf)

`npm run verify:portal` sur le portail HTTP fourni : **CONTROLE REUSSI** — compte `Active` (échéance
05/11/2026), formats `m3u8`/`ts`, import live **5 659 entrées en 1,6 s**, page de 200 objets,
27 tranches, détail sans secret, `resolveStream` → **302** → `HTTP 200 video/mp2t` (MPEG-TS vérifié),
lecture réelle de 1 051 643 octets. Hors ligne : **178 tests, 0 échec** sur Node 20 **et** Node 8.12.

### Rappel simulateur

`0.1.6-simulateur.zip` : extraire dans un dossier personnel, puis *File > Add Service*
(`service/com.ouagkamel.app.iptvplayer.service`), *Tools > Service List* pour démarrer, *File > Launch
App* (`app/`). Un `.ipk` n'enregistre jamais le service sur un simulateur.
