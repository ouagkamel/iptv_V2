# 0.1.18 — profil de test préconfiguré

**Date :** 2026-10-19<br>
**Base :** 0.1.17<br>
**Portée :** réglages et préparation de la qualification 0A/0B; aucun changement du lecteur média.

## Changement

- Le profil de test par défaut est disponible dans *Réglages* avec son libellé et ses champs préremplis. L'écran ouvre ce profil au démarrage; après installation, l'import live peut être lancé directement.
- Le profil est versionné dans `src/app/profils.js` conformément à la demande utilisateur. Les valeurs ne sont pas recopiées dans ces notes.
- `versionPage`, l'agent utilisateur du service et les métadonnées du paquet passent à 0.1.18.
- Le correctif DB8 D-46 de 0.1.17 est conservé; le contrôle d'import reste dans la fiche 0A.

## Fabrication des paquets

- Pour un paquet publiable **sans profil**, utiliser `IPTV_SANS_SOURCES=1 npm run dist`. Le paquet construit remplace le preset par une liste vide et `tools/publish-release.js` continue de refuser toute pièce qui déclare une source.
- Le paquet d'essai avec profil est construit séparément par `npm run dist:local` et reste dans `release/local/`; ne pas le joindre à une publication GitHub.

## Hors périmètre

- Aucun test de connexion ni import réel vers le portail n'a été exécuté pour cette version.
- La matrice 0B média reste à exécuter; aucun résultat ou label de certification n'est revendiqué.
- Aucun travail V1-B n'est inclus.
