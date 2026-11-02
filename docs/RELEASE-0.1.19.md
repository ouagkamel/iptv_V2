# 0.1.19 — VOD : grille et fiches (pré-release)

Pré-release de test du dépôt `ouagkamel/iptv_V2`, tag `v0.1.19-vod`, construite depuis la tranche V1-B autorisée. Elle est destinée à un essai manuel sur un téléviseur LG webOS 6+; ce n'est ni une certification LG ni un verdict de distribution.

## Inclus

- Écran Films avec catégories VOD et grille de films paginée/virtualisée.
- Affiches avec repli en cas d'URL invalide ou d'image indisponible, et métadonnées disponibles.
- Fiche détaillée par `getDetails`, fermeture par Retour, et bouton Lire raccordé au lecteur existant par `resolveStream`.
- Action « Importer (VOD) » séparée de l'import live dans Réglages; la grille se rafraîchit après la réussite de l'import VOD.
- Mise à jour des métadonnées de version vers 0.1.19.

Recherche indexée, saut alphabétique, favoris, reprise, EPG, séries et autres éléments de V1-B restent hors périmètre.

## Paquet public et validation

Le `.ipk` public et les archives `dist` sont construits avec `IPTV_SANS_SOURCES=1`; ils ne contiennent aucun profil fournisseur préconfiguré. Les pièces jointes sont le `.ipk`, `0.1.19.zip`, `0.1.19-simulateur.zip` et `SHA256SUMS.txt`. L'IPK public pèse 1 293 142 octets; son SHA-256 est `648f0f3b418c085a03ab5453900f650e5462ae5a1b5c63c72a2e379718e1af13` (également listé dans le manifeste de sommes). Les archives ont passé le contrôle d'intégrité ZIP et les profils dans l'IPK, le ZIP `dist` et le pack simulateur ont été contrôlés comme neutralisés.

Vérifications de build réussies : `npm run verify` (Node 8.12, dépendances, typecheck et **266 tests, 0 échec**), `npm --prefix ui run lint` et `npm run build:ui`.

Aucun import de portail ni essai VOD sur TV réelle n'a été réalisé pour cette pré-release. Le simulateur webOS ne remplace pas un téléviseur. La qualification média 0B et tout go/no-go de distribution restent distincts et non revendiqués ici.

## Parcours de test conseillé

Sur une source Xtream que l'utilisateur est autorisé à utiliser : installer le paquet, configurer la source, lancer séparément « Importer (VOD) », ouvrir Films, parcourir les catégories et la grille, vérifier une fiche et Retour, puis tester Lire si souhaité. Ne pas interpréter un essai ponctuel comme une certification.
