# Essai 0B — qualification du lecteur et du pipeline média

**Version cible du protocole :** 0.1.17<br>
**État :** protocole préparé; résultats 0B non consignés.<br>
**Références normatives :** `docs/PHASE-0.md` §0B et `docs/SPEC-v1.3.md` §§6.1, 11.2 et 12.<br>
**Contexte :** le 18 octobre 2026, l’utilisateur a confirmé que les essais réalisés sur TV réelle sont OK. Ce retour valide l’étape 0A/D-46 au niveau communiqué; il ne fournit pas les nombres d’essais ni la matrice média de 0B.

> **Portée : qualification média uniquement.** Ce document ne démarre pas le développement fonctionnel V1-B. La qualification se fait d’abord sur les capacités natives de la TV; le repli MSE est relevé séparément et ne compte pas comme preuve de lecture native sur TV.

La 0B vérifie que le lecteur réutilise son unique `<video>`, choisit un conteneur que le téléviseur sait lire, ferme l’ancien flux avant le suivant et donne des délais acceptables. Les causes D-44/D-45 déjà tranchées (portail, codec du flux 159335, User-Agent, ordre HLS/TS et limites du simulateur) ne sont **pas** rouvertes ici. On enregistre les résultats de nouvelles cellules de test sans repartir à zéro sur ces investigations.

## 1. Règles et verdicts

### 1.1 Trois niveaux d’essai

| Niveau | Essais par cellule (modèle × format × codec) | Verdict |
|---|---:|---|
| **Smoke** | 1–3 | Détecte rapidement une incompatibilité; ne permet pas d’annoncer une prise en charge générale. |
| **Qualification** | 10 | Retenir la cellule seulement si **10/10** démarrages affichent une première image; à 9/10 ou moins, la cellule reste non retenue et la cause est consignée. |
| **Certification** | **30 avec ≥29 succès, ou 20/20** | Seul niveau qui autorise le terme « certifié » pour la famille de modèles testée. |

Ne pas mélanger les résultats de deux modèles dans une seule cellule. Une cellule qui n’atteint pas le seuil requis reste non qualifiée/non certifiée; consigner l’échec sans extrapoler à toute une famille.

### 1.2 Délais et critères

- Première image : **p95 ≤ 15 s** sur réseau de labo stable; après 20 s sans image, l’application doit afficher un message d’échec avec une action **Réessayer** (Retour peut aussi être proposé).
- Zapping : **p50 ≤ 4 s** et **p95 ≤ 8 s**, mesurés depuis la dernière touche d’une rafale jusqu’à l’image de la nouvelle chaîne.
- Fermeture du flux précédent : oui avant l’ouverture du suivant; aucun ancien son/flux ou second décodeur ne subsiste.
- À la TV réelle, compter la cellule comme native seulement si elle lit sans passer au mode `mse`. En cas de repli MSE, noter le résultat séparément.
- Pour le smoke, conserver les durées brutes; avec 1–3 essais, ne pas traiter un p95 comme un résultat statistique. Appliquer les seuils p50/p95 à la campagne de qualification/certification, en gardant les valeurs individuelles.
- La certification doit couvrir **au moins deux familles de téléviseurs** selon §0B/§11.2. Le téléviseur disponible valide sa famille; le simulateur webOS 26 ne remplace pas une seconde famille réelle.

## 2. Préparation

1. Sur la TV réelle, confirmer l’application **0.1.17** :
   ```bash
   ares-install --device tv --listfull
   ```
   Le paquet d’essai préconfiguré, s’il est utilisé, est `release/local/com.ouagkamel.app.iptvplayer_0.1.17_all.ipk`. Il contient les champs du compte de test et ne doit jamais être publié, poussé ni transmis.
2. Utiliser uniquement un compte de test autorisé et dédié; consigner `max_connections` si disponible. Ne pas lancer les essais simultanés au-delà de la limite annoncée par le portail.
3. Sélectionner des flux dont l’accès et le conteneur annoncé sont connus. Ne pas modifier le User-Agent ni réordonner les formats pendant cette campagne : ces pistes sont closes pour D-44/D-45.
4. Choisir un réseau stable; relever Wi-Fi/Ethernet, débit/latence approximatifs et toute interruption. Chaque essai commence lecteur fermé et se termine par arrêt effectif du lecteur.
5. Dans *Réglages* → **Page de diagnostic (0A)**, copier seulement les lignes sans secret : version, valeurs `canPlayType`, support MSE. Ne jamais recopier URL, nom d’utilisateur, mot de passe, token ou URL complète du journal.

## 3. Matrice à exécuter

Créer une ligne par cellule réellement disponible. Si le fournisseur ne propose pas une variante, inscrire **non disponible / non testé**; ne pas la remplacer par une supposition.

| Cellule | Variante à tester | Notes importantes |
|---|---|---|
| HLS natif | `.m3u8`, H.264 + AAC | Baseline lecture native; noter première image et le format choisi. |
| MPEG-TS progressif natif | `.ts`, H.264 + AAC | Test distinct de HLS; un repli MSE n’est pas applicable au TS brut. |
| HLS sans extension | URL sans suffixe avec MIME correct, absent, puis générique | Trois lignes distinctes si les trois réponses existent. |
| TS sans extension | URL sans suffixe avec MIME correct, absent, puis générique | Trois lignes distinctes si les trois réponses existent. |
| Redirection | Obligatoire : 302 même hôte et 302 vers un autre hôte. En extension si la source de test le permet : 301/307/308 et redirection HTTP↔HTTPS | Noter le statut et le nombre de redirections, jamais l’URL. La pile `<video>` peut masquer les détails au lecteur. |
| Transport | HTTPS; HTTP avec consentement explicite | Pour HTTP, vérifier l’avertissement une fois par profil/hôte; ne pas désactiver la sécurité TLS. Les changements de schéma pendant une redirection sont une cellule distincte. |
| Vidéo / audio | H.264, HEVC, MPEG-2; AAC, AC-3, E-AC-3 | Tester les combinaisons effectivement fournies, pas le produit cartésien complet par défaut. |
| Entrelacé | 1080i | À noter comme cellule distincte; le résultat dépend du modèle et du débit. |
| Cas négatif | Au moins un flux connu comme non pris en charge | Vérifier un échec clair et récupérable, sans blocage ni crash. |
| Zapping | rafale Haut/Bas sur une file de chaînes autorisées | La dernière sélection doit gagner; le flux précédent doit être arrêté avant le suivant. |

**Important :** les cellules sont définies comme `(famille TV, format, codec vidéo/audio, variante MIME/protocole pertinente)`. Ne pas inscrire « HLS supporté » si seul un flux précis a été testé; garder le détail de la cellule.

## 4. Procédure d’une cellule

1. Ouvrir une chaîne correspondant à la cellule et démarrer le chronomètre à la validation OK.
2. Arrêter le chronomètre à la première image visible; noter aussi le son et tout message.
3. Fermer le lecteur, attendre l’arrêt, puis recommencer. Pour la qualification, répéter jusqu’à **10 démarrages indépendants**; pour la certification, suivre le seuil 30 (≥29) ou 20/20.
4. En cas d’échec, recopier le texte d’erreur exact et les formats essayés **sans URL**. Ne pas réessayer en changeant simultanément le portail, le codec, le User-Agent et le format : une seule variable par essai.
5. Pour le zapping, déclencher une rafale de touches sur plusieurs chaînes. Mesurer de la dernière pression à l’image de la chaîne finale. Vérifier que l’ancien son disparaît et que le nouveau flux ne démarre qu’après fermeture du précédent.
6. Relever la voie observée : `native HLS`, `native TS`, `MSE` si identifiable, ou `échec`. Sur la TV réelle, un résultat `MSE` est utile à diagnostiquer mais ne compte pas comme succès natif.

### Banc simulateur webOS 26 — ligne séparée

Le simulateur est une régression complémentaire, pas une famille TV certifiée. Le moteur webOS 26/Chromium 132 n’a pas la même compatibilité média qu’une TV réelle; le repli MSE/hls.js peut y être la voie de lecture. Consigner son résultat dans une section distincte et ne pas le fusionner avec les résultats natifs TV.

## 5. Fiche de relevé par cellule

```text
App : 0.1.17                 Date/heure : ........................
TV marque/modèle : .......... Famille/gamme : .......... webOS : ..........
Réseau : .................... Source d’essai autorisée : (nom neutre, sans identifiant) ..........

Format : ( ) HLS  ( ) TS   Extension : ( ) oui  ( ) non
Content-Type annoncé : ....................  Redirect : ( ) non ( ) même hôte ( ) autre hôte
Transport : ( ) HTTPS  ( ) HTTP accepté   Codec vidéo : .......... Audio : .......... Résolution : ..........
Voie observée : ( ) native HLS  ( ) native TS  ( ) MSE  ( ) échec

Niveau : ( ) smoke  ( ) qualification  ( ) certification
Essais : succès ..... / .....   Première image (secondes) : .................................
p50 première image : ........ s       p95 première image : ........ s
Zapping, dernier appui → image : ............................................................
p50 zap : ........ s                 p95 zap : ........ s
Ancien flux fermé : ( ) oui ( ) non   Ancien son présent : ( ) oui ( ) non
Message exact sans URL/identifiant : ..........................................................
Verdict de la cellule : ( ) retenue pour qualification  ( ) non retenue  ( ) certifiée  ( ) non testée
Notes / réseau / anomalie reproductible : .....................................................
```

## 6. Tableau de campagne multi-modèles

| Famille/modèle | webOS | Cellule | Niveau | Essais/succès | p95 image | p50/p95 zap | Voie native ou MSE | Verdict |
|---|---|---|---|---:|---:|---:|---|---|
| TV disponible : à remplir |  |  |  |  |  |  |  |  |
| Deuxième famille réelle : à planifier |  |  |  |  |  |  |  |  |
| Simulateur webOS 26 (séparé) | 26 / Chromium 132 |  | smoke seulement |  |  |  |  | non certifiant |

## 7. Suite et critères d’arrêt

- Toute cellule à 9/10 ou moins est **non retenue** pour la compatibilité annoncée; documenter l’échec, sans l’attribuer au portail ou au codec sans preuve.
- Si le natif fonctionne sur la TV, conserver le natif comme verdict; le repli MSE n’est pas un motif pour modifier l’ordre natif.
- Ne pas modifier le lecteur après un essai isolé. Une modification nécessite un cas reproductible, un test de régression et une nouvelle campagne sur la cellule affectée.
- Après la qualification des cellules retenues, la 0D (gros catalogue/chiffrement/performance) reste une étape séparée. Le **contrôle de distribution LG**, `docs/DISTRIBUTION-LG.md`, demeure un go/no-go avant V1-B; son envoi/réponse n’est pas remplacé par un succès média.
- Les résultats peuvent être consignés dans `docs/JOURNAL.md` sous forme agrégée et sans données sensibles. La réponse LG, si reçue, doit être conservée hors du dépôt si elle contient des informations commerciales.
