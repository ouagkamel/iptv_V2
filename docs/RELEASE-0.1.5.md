## Paquet de diagnostic — phase 0A (0.1.5)

Le service répond désormais dans le simulateur (le pack `0.1.5-simulateur.zip` explique comment
l'ajouter). Cette version corrige **trois défauts** révélés par le premier essai qui a fonctionné,
et rend les erreurs enfin lisibles : la page affichait `[object Object]` au lieu du message du
service.

| Réf. | Défaut | Correctif |
|---|---|---|
| D-23 | Le **premier import échouait toujours** sur un appareil neuf (« profil inconnu ») : aucune commande LS2 ne crée de profil | `importPlaylist` **crée le profil au premier import** (il porte déjà `kind` et `source.url`), répond `profilCree: true` |
| D-24 | `[object Object]` à l'écran dès qu'une commande échouait ; ligne « ok » en vert alors que le compte était expiré | affichage `code — message (indication)` pour l'enveloppe du service comme pour les erreurs du bus ; le journal suit le **verdict métier** (`data.ok`) et affiche le premier code d'erreur |
| D-25 | Compte expiré : cascade d'erreurs réseau au lieu d'une cause | **contrôle préalable** de l'import : un refus non réessayable `auth/*` interrompt l'import avec `auth/expired` ou `auth/invalidCredentials` et l'indication de vérifier l'abonnement ; `diagnostics` sonde DB8 (`db.ok`) sans jamais échouer |

### À savoir pour l'essai

- **Le compte de test fourni est arrivé à échéance** : le portail répond `status: Expired` puis
  **HTTP 451** à tous les appels. `testProfile` le dit maintenant explicitement, et l'import est
  refusé avec `auth/expired` — il faut un abonnement à jour pour rejouer la validation 0C.
- Sur simulateur, un `.ipk` n'enregistre pas le service : extraire `0.1.5-simulateur.zip` dans un
  dossier personnel, puis *File > Add Service* (dossier `service/com.ouagkamel.app.iptvplayer.service`),
  *Tools > Service List* pour le démarrer, *File > Launch App* (dossier `app/`).
- Enchaînement à faire dans la page : **Diagnostic du service** (montre `db.ok`, les index, le
  runtime) → **Tester la source** (verdict `Active`/`Expired`) → **Importer (live)** → **Page** →
  **Détail** → **Résoudre le flux**.

### Vérifications

`npm test` : **171 tests, 0 échec** sur Node 20 **et** sur Node 8.12 (cible réelle du service),
dont : création implicite du profil au premier import, refus `auth/expired` / `auth/invalidCredentials`
sur compte inutilisable, sonde DB8 du diagnostic, mise en texte des erreurs (enveloppe du service,
erreur du bus, `Error`, objet inattendu), structure du pack simulateur.
