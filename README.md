# Lecteur IPTV — LG webOS TV 6+

Lecteur IPTV destiné aux téléviseurs **LG webOS 6 et suivants**, entièrement pilotable à la
télécommande. L'application lit **uniquement les sources fournies par l'utilisateur** : elle ne
fournit, ne découvre, ne partage et ne vend ni playlist, ni identifiant, ni flux audiovisuel.

Ce dépôt implémente la spécification `docs/SPEC-v1.3.md` **par incréments** (§1.4) :

| Incrément | Contenu | État |
|---|---|---|
| Socle | contrats `§15.1`, crypto d'index `§15.3`, index/recherche `§15.2`, machines d'état `§15.5`, outillage CI | **livré (étape 1)** |
| Service | client HTTP `§2.5`, parseur JSON incrémental, DB8 `§2.4`, adaptateur Xtream `§5.1`, import reprenable `§15.5`, protocole LS2 `§15.4`, diagnostic local | **livré (étape 2)** |
| V1-A | Xtream (profil, test) + Live TV (catégories, chaînes) + lecteur + `resolveStream()` + diagnostic local | interface Enact en cours (étape 3) ; **service complet** |
| V1-B | EPG, favoris, reprise, VOD (grille, fiche, recherche indexée, saut alphabétique) | à venir |
| V1-C | Séries (saisons, épisodes) + navigation globale persistante | à venir |
| V1-D | M3U (second moteur, identité `logicalKey`/`variantKey`), gros catalogues, index chiffré, reprise d'import | à venir |

L'état réel de chaque brique, les écarts et ce qui reste **à valider sur téléviseur** sont tenus à
jour dans `docs/PLAN.md` et `docs/JOURNAL.md`.

## Choix techniques (imposés par la spécification §2 et §14)

- **Enact 3.4.9 + Sandstone 1.4.6** (dernière branche couvrant webOS 6.0), `@enact/spotlight` pour le
  5-way, **TypeScript** compilé.
- **Service JS webOS** (Node.js 8.12 embarqué, cible ES2017) : réseau fournisseur, parsing par lots,
  index catalogue compact **chiffré au repos** (AES-256-GCM, dérivation `§15.3`) dans le répertoire
  privé du service.
- **DB8** pour profils, préférences, favoris, reprises et `ImportJob` — jamais le catalogue.
- **`<video>` HTML natif** unique, alimenté exclusivement par `resolveStream()` (l'URL de flux est
  une donnée de session, jamais persistée par l'interface).
- **Zéro dépendance d'exécution** côté service (§2.3) : HKDF-SHA256 et le format de fichier chiffré
  sont implémentés dans le dépôt, testés par vecteurs RFC 5869.

## Paquetage webOS

```
/                                  # APP_DIR  (application Enact, appinfo.json)
service/<id-de-service>/           # SERVICE_DIR (package.json, services.json, lib/ compilé)
```

```bash
npm ci                  # outillage de développement
npm run build           # compile le service (ES2017/Node 8.12) puis l'interface
npm test                # tests unitaires + contrats (node, sans dépendance)
npm run lint:node812    # interdit toute API absente de Node 8.12
npm run check:deps      # refuse une dépendance d'exécution non justifiée
npm run pack:webos      # produit l'.ipk (nécessite @enact/cli + ares-cli)
```

Installation en mode développeur : `ares-install --device tv dist/<paquet>.ipk`.
Le détail des vérifications à faire **sur la TV** (phase 0A/0B, §12) est dans `docs/PHASE-0.md`.

> **CI** : `.github/workflows/ci.yml` s'exécute à chaque envoi. Deux cibles : l'outillage et la
> compilation sur Node 20, puis l'artefact du service testé sur **Node 8.12.0** — la version
> réellement embarquée par webOS 6. Un test qui échoue seulement en 8.12 est un bug de cible, pas
> un test à désactiver.

## Le service en trois phrases

Le service est la seule partie qui touche au réseau, au disque et à DB8. `importPlaylist` construit
un index chiffré par type de contenu et le publie par bascule atomique ; l'interface ne reçoit
jamais d'URL — elle demande une page (`getPage`), une recherche (`search`) ou une tranche
alphabétique (`getBuckets`), puis une résolution de flux (`resolveStream`) juste avant la lecture.
Tous les appels partagent la même enveloppe `{ returnValue, indexVersion?, data?, error? }`, bornée
en objets **et** en octets, et le diagnostic local ne contient jamais un identifiant ni une adresse
de portail complète.

## Sécurité et vie privée

- Aucun secret (URL de flux, identifiant, token) n'est journalisé, ni renvoyé à l'interface, ni
  stocké en clair : l'index est chiffré par blocs de taille fixe, la clé maître vit dans DB8
  app-aware (§8.2, §15.3).
- L'index protège contre une autre application et une lecture non privilégiée des fichiers — **pas**
  contre un appareil rooté ni un attaquant privilégié (§8.1). Cette limite est affichée dans la page
  « À propos ».
- Marquage et refus des URL de flux privées/loopback (§5.2) avant toute affectation de `video.src`.

## Conformité

L'utilisateur doit posséder ou être autorisé à utiliser les sources qu'il configure. L'application
ne contourne ni DRM, ni abonnement, ni restriction régionale. Le contrôle de distribution LG
(phase 0, §12) doit être tranché **par écrit** avant de poursuivre au-delà de V1-A.
