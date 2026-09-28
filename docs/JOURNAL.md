# Journal d'exécution

## 2026-09-28 — Étape 1 : socle et contrats

**Périmètre livré** (voir `docs/PLAN.md` pour la traçabilité complète) :

- dépôt initialisé, manifeste §2.6 (`appinfo.json`, `services.json` avec `commands` non publiques),
  configuration TypeScript à **deux cibles** : service `ES2017`/CommonJS pour Node 8.12, interface
  `ES2019` séparée ;
- contrats §15.1 transposés en TypeScript (`src/contracts/types.ts`), codes d'erreur §7.2/§15.4
  avec assainissement des messages (`src/contracts/errors.ts`) ;
- crypto d'index §15.3 : HKDF-SHA256 écrit à la main (vecteurs RFC 5869 en CI), dérivation
  `masterKey → indexKey → nonce`, AAD liée au contexte, format par blocs de 4096 à offsets fixes,
  lecture à accès aléatoire tenant **un seul bloc en clair** en mémoire ;
- index §15.2 : secteurs fixes de 128 octets, `payload.bin` pour les charges lourdes, index de
  titres épars + table dense, tranches alphabétiques calculées à l'indexation, dictionnaire de
  groupes avec plages d'ordinaux, manifeste non secret, bascule atomique et rétention ;
- recherche indexée : recherche binaire sur l'index épars puis balayage borné à la page, avec
  compteurs instrumentés prouvant l'absence de parcours linéaire ;
- machines d'état §15.5 (lecteur et import) et coalescence de zapping testables sans TV ;
- normalisation partagée §9.3, scripts/tranches §9.1, marquage d'hôtes §5.2, analyse
  `hasCredential` §5.2/§15.6 ;
- outillage : harnais de test sans dépendance exécutable sur Node 8.12, contrôle d'API interdites
  (`tools/node812-compat.js`) portant sur la source **et** l'artefact compilé, contrôle de
  dépendances (`tools/deps-audit.js`), CI à deux cibles (Node 20 pour l'outillage, Node 8.12 pour
  l'artefact).

**Envoi sur GitHub** : commit initial poussé sur `main`. Le fichier de workflow a été déplacé dans
`ci/github-workflows-ci.yml` : le jeton fourni n'a pas la portée `workflow`, exigée par GitHub pour
créer `.github/workflows/ci.yml`. Aucun secret n'est présent dans le dépôt.

**Résultat** : `npm test` → **77 tests, 0 échec** ; `npm run lint:node812` → OK ;
`npm run check:deps` → OK (zéro dépendance d'exécution).

### Décisions et écarts

| Réf. | Décision | Motif | Statut |
|---|---|---|---|
| **D-01** | `fileKind` ajouté au **sel** de dérivation de clé (l'AAD reste celle du §15.3) | Sans lui, `records.bin` et `payload.bin` d'un même `(profil, version, type)` partageraient clé **et** nonces : réintroduction du défaut P0 au niveau inter-fichiers | testé (clés et nonces distincts, bloc déplacé rejeté) — à confirmer par l'auteur de la spec |
| **D-02** | Index de titres = `prefix8` normatif **+** extension de 8 octets **+** table dense d'ordinaux | Le seul index épars du §15.2 ne permet ni de *marcher* dans l'ordre alphabétique, ni de discriminer des titres partageant leurs 8 premiers octets (balayage quasi linéaire) | testé ; budgets à mesurer en 0D |
| **D-03** | Charges lourdes dans `payload.bin`, offsets relatifs dans le secteur | Réalise explicitement les `payloadOffset`/`payloadLength` du §15.2 ; une page de liste ne lit jamais une charge lourde | testé |
| **D-04** | Charge courte ajustée par coupes successives (résumé puis logo) avec avertissement d'import | Garantit qu'une entrée « ventrue » ne casse pas l'indexation tout en gardant la page bornée en octets | testé |
| **D-05** | `payload.bin` chiffré avec le même format de blocs mais un `fileKind` distinct | Voir D-01 ; le manifeste reste le seul fichier en clair | testé |

### Points restés ouverts (conformément au §15.6)

- seuils mémoire exacts du service (RSS, taille de lot de parsing) : après mesures 0D ;
- `searchIndexKind` par défaut : `title` retenu provisoirement ; `title+tokens` dépend du budget disque ;
- seuil de longueur du « segment porteur d'identifiant » : valeur par défaut **24 caractères**,
  exposée dans `urltools.DEFAULT_CREDENTIAL_SEGMENT_MIN_LENGTH` et couverte par un test
  d'acceptation (les URL de CDN publiques ne doivent pas être classées secrètes).

### Prochaine étape (étape 2)

1. Service LS2 §15.4 : `testProfile`, `getPage`, `search`, `getBuckets`, `getDetails`,
   `resolveStream`, `diagnostics`, enveloppe unique, plafonds objets/octets, aucune URL vers l'UI ;
2. adaptateur Xtream (`player_api.php`, appel « tous les flux » avant le découpage par catégorie),
   client HTTP du service (§2.5 : redirects bornés, schémas revalidés, IP épinglée, bundle de
   racines embarqué) ;
3. persistance DB8 (profils, préférences, `ImportJob`, clé maître) et pipeline d'import Xtream
   reprenable ;
4. diagnostic local sans secret.
