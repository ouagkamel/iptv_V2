# Plan d'exécution de la spécification v1.3

Ce plan suit l'ordre du **§12** de la spécification : phase 0 (risques disqualifiants) → phase 1
par incréments (§1.4) → phase 2 (durcissement et distribution). Chaque ligne indique ce qui est
livré dans le dépôt et ce qui **doit** être vérifié sur un téléviseur ou auprès de LG : aucune
ligne n'est cochée sans preuve.

## État par étape

| Étape | Contenu | Livré dans le dépôt | Vérification appareil / externe |
|---|---|---|---|
| **Socle (étape 1)** | Contrats §15.1, crypto d'index §15.3, index/recherche §15.2, machines d'état §15.5, normalisation §9.3, scripts §9.1, hôtes §5.2, outillage CI | **oui** — `src/contracts`, `src/core`, `src/service/crypto`, `src/service/store`, `tests/`, `tools/` (77 tests) | non requis |
| **0A — socle plateforme** | Manifest §2.6 (`appinfo.json`, `services.json`, `commands` non publiques), socle CI (Node 8.12 + Chromium 79) | partie : manifest + CI ; les écrans factices arrivent avec V1-A | **oui** : `ares-install`, journaux LS2, DB8, écriture `/media/internal`, ACG réellement accordées (`docs/PHASE-0.md`) |
| **0B — lecteur** | Machine d'état lecteur + `NativeHtmlVideoPlayer` (V1-A) | machine d'état livrée et testée ; lecteur à écrire | **oui** : HLS, MPEG-TS progressif, MIME absent, redirects, codecs, 1080i — batterie *smoke* puis *qualification* (§11.2) |
| **0C — un fournisseur de chaque type** | Adaptateur Xtream (V1-A), import M3U (V1-D) | à écrire | **oui** : portail Xtream et playlist M3U autorisés, comptes de test dédiés |
| **0D — gros catalogue, secrets, réseau** | Index chiffré, `ImportJob`, quotas | crypto et index livrés et testés ; import reprenable à écrire | **oui** : 250 k entrées / 256 Mio, RSS, pic disque, TLS par pile, racine récente |
| **Contrôle de distribution** | Question écrite à LG Seller Lounge, self-checklist | trame de question dans `docs/PHASE-0.md` | **oui** — go/no-go bloquant, à trancher avant V1-B |
| **V1-A** | Xtream (profil, test, consentement, erreurs normalisées), Live TV (catégories/chaînes), lecteur `resolveStream()`, diagnostic local, quatre cartes, remote/Spotlight, routeur/Retour | service : `testProfile`, `getPage`, `getBuckets`, `resolveStream`, `diagnostics` — **à écrire à l'étape 2** ; interface Enact **étape 3** | mesures D-pad et p95 |
| **V1-B** | EPG, favoris, reprise, VOD (grille, fiche, recherche indexée, saut alphabétique), barre de navigation persistante | — | — |
| **V1-C** | Séries (saisons, épisodes, recherche sur titres), états d'écran normalisés | — | — |
| **V1-D** | M3U (identité `logicalKey`/`variantKey`), gros catalogues, import reprenable, sélection de groupes | — | — |
| **Phase 2** | Multi-modèles, soak, sécurité, privacy, checklist LG, captures | — | — |

## Traçabilité : contrat → code → test

| Exigence de la spécification | Code | Test |
|---|---|---|
| §15.1 types exacts (`ContentRef`, `Cursor`, `StreamResolution`, `ImportJob`, `ScreenState`, `BucketSet`, `ProviderAdapter`) | `src/contracts/types.ts` | `tests/store.test.js`, `tests/machines.test.js` |
| §7.2/§15.4 codes d'erreur normalisés, sans secret dans les messages | `src/contracts/errors.ts` | `tests/normalize.test.js` (fuite de secrets) |
| §15.3 dérivation `masterKey → indexKey → nonce`, AAD liée au contexte | `src/service/crypto/indexCrypto.ts` | `tests/crypto.test.js` (RFC 5869 cas 1–3, bloc déplacé, tag altéré, versions distinctes) |
| §15.3 format de fichier par blocs de 4096, accès aléatoire O(1), longueur réelle en tête de clair | `src/service/crypto/indexCrypto.ts` (`BlockFileWriter`, `BlockFileRandomReader`) | `tests/crypto.test.js`, `tests/store.test.js` |
| §15.2 enregistrement 128 octets + charge, `records.bin` en ordre source | `src/service/store/record.ts` | `tests/store.test.js` |
| §15.2 index épars 1/32 + table dense, `getPage(order)`, plafond 200 objets / 256 Kio | `src/service/store/reader.ts`, `src/core/pages.ts` | `tests/store.test.js` |
| §15.2 recherche binaire + balayage borné, aucun `filter()`, aucune construction du tableau complet | `src/service/store/reader.ts` | `tests/store.test.js` (lectures d'enregistrements < 260 pour 3 000 entrées, requête hors catalogue < 40) |
| §2.4 bascule atomique, rétention 30 s, annulation sans effet sur l'index validé | `src/service/store/manifest.ts`, `src/service/store/writer.ts` | `tests/store.test.js` |
| §15.5 machine d'état du lecteur (coalescence 400 ms, timeout 20 s, re-résolution unique) | `src/core/machines.ts` | `tests/machines.test.js` |
| §15.5 machine d'état de l'import, checkpoint à chaque lot, reprise, TTL 7 jours | `src/core/machines.ts` | `tests/machines.test.js` |
| §9.3 normalisation partagée (préfixes fournisseur, suffixes qualité, articles, NFKD) | `src/core/normalize.ts` | `tests/normalize.test.js` |
| §9.1 scripts et tranches par stratégie explicite, scripts issus des données | `src/core/scripts.ts` | `tests/normalize.test.js`, `tests/store.test.js` |
| §5.2 marquage des hôtes privés (décimal/octal/hex, IPv6, IPv4 encapsulée), autorisation LAN | `src/core/hostSafety.ts` | `tests/normalize.test.js` |
| §5.2 `hasCredential` par analyse, préfixe porteur d'identifiants | `src/core/urltools.ts` | `tests/normalize.test.js` |
| §2.3 zéro dépendance d'exécution, API Node 8.12 uniquement | `tools/node812-compat.js`, `tools/deps-audit.js` | CI (les deux cibles) |

## Écarts et décisions prises (à valider par l'auteur de la spécification)

1. **Discriminant de fichier dans la dérivation de clé** (`IndexKeyParams.fileKind`). La formule
   littérale du §15.3 dériverait la même clé et les mêmes nonces pour deux fichiers d'un même
   `(profil, indexVersion, contentType)` — ce qui rouvrirait le défaut P0 au niveau inter-fichiers.
   Le type de fichier entre donc dans le **sel** ; l'AAD reste exactement celle du contrat.
   Test : « deux fichiers du même index ne partagent ni clé ni nonce ».
2. **Index de titres : table dense + clé de 16 octets.** Le §15.2 décrit un index épars
   `(prefix8, ordinal)` toutes les 32 entrées. Un tel index ne peut pas, à lui seul, *marcher* dans
   l'ordre alphabétique (il manque la correspondance ordinal alphabétique → secteur), et un `prefix8`
   saturé (« chaine 0042 », « chaine 1500 »…) rend le balayage quasi linéaire. L'implémentation
   conserve donc le `prefix8` normatif **et** ajoute (a) une table dense d'ordinaux et (b) une
   extension de 8 octets de la clé de tri, déclarée dans le manifeste (`titleSparseKeyBytes`).
   Les deux points sont mesurés en 0D (§15.2 exige p95 ≤ 250 ms sur 250 k entrées).
3. **`slot.idx` implicite.** Le §15.2 stocke `payloadOffset`/`payloadLength` par secteurs fixes ;
   ici, la charge lourde vit dans `payload.bin` et ces champs sont des offsets relatifs vers ce
   fichier — la réalisation explicite des offsets que la spécification suppose.
4. **`ImportJob` : `swapping` seule transition de version.** Implémenté tel quel ; `commit()` est
   la seule fonction qui publie une version (rename + manifeste).
5. **Plafonds de page.** Le plafond en objets (200) se déclenche en pratique avant le plafond en
   octets pour des entrées d'index bornées (charge courte ≤ 512 octets) ; le plafond en octets est
   testé directement sur l'accumulateur, et le service le re-vérifie avant de renvoyer une page.

## Ce que ce dépôt ne peut pas faire seul

- Installer et mesurer sur une **TV webOS 6 réelle** (phase 0A/0B) : `ares-install`, journaux LS2,
  capacités média, budgets D-pad et zapping.
- Obtenir la **réponse écrite de LG** sur le modèle de distribution (§12) : sans elle, le GO est
  *suspendu*, pas contourné.
- Mesurer les budgets du §15.2 sur 250 k entrées (le format est testé sur des catalogues
  synthétiques ; la mesure de temps sur appareil reste à faire en 0D).
