# Phase 0 — vérifications à exécuter sur le téléviseur et auprès de LG

Ces vérifications ne peuvent pas être faites dans un environnement de développement : elles
conditionnent la faisabilité du produit (§12). Chaque case se coche **avec sa preuve** (journal,
copie d'écran, réponse écrite), jamais par extrapolation.

## 0A — Socle applicatif et plateforme

- [ ] `ares-package` + `ares-install` du paquet sur la TV webOS 6 moyenne/faible.
- [ ] Spotlight : D-pad complet sur quatre écrans factices, mode pointeur, clavier virtuel.
- [ ] Touche **Back (461)** : une pression = un niveau ; comportement à la racine.
- [ ] Service JS joignable en LS2 ; `services.json` accepté avec `commands` **et** `public: false`
      (vérifier qu'aucune commande n'est appelable depuis une autre application).
- [ ] **ACG réellement accordées** : relever dans les journaux LS2 les permissions refusées, en
      particulier pour DB8 (`com.webos.service.db`) et `time.query`. Consigner les noms exacts
      obtenus — le §2.6 les traite comme « à valider en 0A », pas comme acquises.
- [ ] Écriture dans le répertoire privé du service sous `/media/internal`, relecture après mort du
      service, persistance après redémarrage de la TV.
- [ ] `process.versions.node` et `process.versions.openssl` lus **sur l'appareil** (sans donnée
      sensible) : confirmer Node 8.12 et la version d'OpenSSL du firmware.
- [ ] Appel sortant `player_api.php` depuis le service : aucun port en écoute côté service.

## 0B — Lecteur et pipeline média

Pour chaque cellule (modèle × format × codec) : *smoke* 1–3 essais en développement, puis
**qualification 10/10** ; seul le niveau **certification 30 (≥ 29/30) ou 20/20** autorise le mot
« certifié » (§11.2).

- [ ] HLS (`.m3u8`) ; MPEG-TS progressif (`.ts`) ; URL **sans extension** avec `Content-Type`
      correct, absent, puis générique.
- [ ] Redirect 302 même hôte, puis autre hôte. HTTP clair (avertissement une fois par profil/hôte).
- [ ] H.264, HEVC, MPEG-2, AAC, AC-3, E-AC-3, 1080i, plus au moins un cas non supporté à consigner.
- [ ] Zapping coalescé : le flux précédent est **fermé** avant le suivant (aucun second décodeur).
- [ ] Zapping : p50 ≤ 4 s et p95 ≤ 8 s, mesurés depuis la dernière pression de la rafale.
- [ ] Première image : p95 ≤ 15 s sur réseau de labo stable ; 20 s sans image ⇒ message + Réessayer.
- [ ] Batterie par **famille de modèles** : deux TV de même version webOS mais de gammes
      différentes ne se couvrent pas l'une l'autre.
- [ ] Comptes de test **dédiés** (`max_connections` documenté), jamais un compte utilisateur.

## 0C — Un fournisseur de chaque type

- [ ] Portail Xtream autorisé, catalogue jouet (1 catégorie, 10–20 chaînes, 1 film, 1 série) :
      `player_api`, appel « tous les flux », construction des `streamRef`.
- [ ] `resolveStream()` : URL de session, expiration, re-résolution sur `403`, jamais journalisée.
- [ ] Playlist M3U autorisée : identité `logicalKey`/`variantKey` sur un catalogue jouet contenant
      `TF1 HD` / `TF1 FHD` / `TF1 4K`, un `tvg-id` dupliqué, deux variantes de serveurs distincts.
- [ ] Classification `hasCredential` : URL de CDN public non classée secrète.

## 0D — Gros catalogue, secrets, réseau

- [ ] Import de **250 000 entrées / 256 Mio décompressés** : temps, RSS et heap du service, espace
      disque, **pic disque incluant l'ancien index** (≈ 2 × index + temporaire).
- [ ] Annulation d'import en cours : l'index validé reste en place et lisible.
- [ ] `ImportJob` reprenable après mort du service à ~60 % (relecture par `getImportJob`).
- [ ] Bascule d'index pendant une pagination : `catalog/indexChanged`, rejeu au même ancrage.
- [ ] Recherche sur 250 k entrées : première page p95 ≤ 250 ms ; `getPage` p95 ≤ 120 ms ;
      `getBuckets` ≤ 50 ms. **Sans ces mesures, `titleSparseKeyBytes` et `searchIndexKind` restent
      ouverts (§15.6).**
- [ ] Coût du chiffrement par bloc mesuré sur la TV de référence (pas de KDF sur le chemin chaud).
- [ ] TLS par pile : `process.versions.openssl`, TLS 1.2, TLS 1.3-only, **chaîne à racine récente**
      (ISRG Root X2). Si le magasin figé échoue, embarquer un bundle de racines publiques (source,
      date, licence consignées) et **sans aucun contournement** (`rejectUnauthorized` jamais false).
- [ ] Refus de loopback/IP privée à la lecture (y compris `2130706433`, `0177.0.0.1`, `[::1]`),
      puis lecture possible après **autorisation LAN explicite du profil**.
- [ ] Sondes MIME : métadonnées d'abord, sonde interdite si `max_connections ≤ 1`.

## Contrôle de distribution — go/no-go bloquant

À lancer **au début de 0A** et à trancher **avant V1-B**. Trame de question à envoyer par écrit via
LG Seller Lounge :

> Notre application est un lecteur : elle ne fournit, ne découvre, ne partage et ne vend aucun
> contenu, aucune playlist et aucun identifiant. L'utilisateur configure lui-même une source
> (portail compatible Xtream ou playlist M3U) qu'il déclare être autorisé à utiliser. L'application
> ne contourne aucun DRM, ne met en place aucun proxy, n'intègre aucun SDK tiers publicitaire et
> n'utilise aucune ressource de l'appareil en dehors de la lecture demandée par l'utilisateur.
> Questions : (1) ce modèle est-il acceptable pour une publication sur le Content Store ;
> (2) quelles mentions obligatoires doivent figurer (page confidentialité, mention « cette
> application ne fournit aucun contenu ») ; (3) quels pays de distribution sont autorisés ;
> (4) quelles sont les exigences et le calendrier de revue (pretest, function test, content test) ?

- [ ] Question envoyée, accusé de réception conservé.
- [ ] **Réponse écrite** obtenue (acceptabilité, mentions, pays, revue).
- [ ] Self-checklist LG remplie et **téléversée** avec la soumission (son absence entraîne un rejet).
- [ ] Applications comparables déjà publiées vérifiées sur le Content Store.

Un refus ou une condition inacceptable **n'a pas de repli silencieux** : il change le produit ou le
mode de distribution, et se tranche ici.
