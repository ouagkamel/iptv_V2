# Étude de faisabilité — performances d’import et de stockage sur webOS

**Date :** 18 octobre 2026<br>
**Base examinée :** dépôt `iptv_V2`, version 0.1.17, commit `585b6a5`<br>
**Périmètre :** confrontation des six propositions à `docs/SPEC-v1.3.md` et au code actuel.<br>
**Décision d’exécution :** étude seulement — aucune modification, migration, mesure TV ou publication n’a été lancée.

## Verdict exécutif

Les propositions ne doivent **pas** être appliquées en bloc. Leur prémisse principale — « l’import écrit chaque chaîne dans DB8, donc chaque chaîne déclenche un appel Luna » — ne correspond **pas** à cette application : les catalogues sont déjà construits dans un magasin de fichiers privé, compact, paginé et chiffré AES-256-GCM. DB8 conserve les petits objets d’état et de compte, dont le `ImportJob`.

**Conclusion :** garder l’architecture actuelle pour la V1.3. IndexedDB en remplacement, un `putBatch` de catalogue et un Web Worker ne sont pas des remèdes adaptés au chemin actuel. La stratégie « champs utiles seulement » et la pagination d’affichage sont déjà largement en place. La meilleure piste incrémentale est de mesurer d’abord le vrai coût sur le téléviseur, puis d’évaluer les validateurs HTTP `ETag`/`Last-Modified` plutôt que de stocker la réponse brute.

Le risque de performance que le code rend le plus plausible n’est pas une écriture DB8 par enregistrement : c’est le coût CPU et disque du service lors de l’ingestion, puis la **finalisation synchrone** de plusieurs index (notamment les tris) sur une TV modeste. Cela reste une hypothèse à mesurer, pas un verdict de lenteur : le test 0D sur téléviseur n’a pas encore établi les temps, le RSS ni le pic disque.

## Évaluation des six propositions

| Proposition | Faisabilité technique | Verdict pour ce dépôt |
|---|---|---|
| 1. Remplacer DB8 par IndexedDB pour les catalogues | IndexedDB est cohérent avec un moteur Chromium 79, mais déplacer le catalogue vers l’UI impose une autre architecture et une nouvelle preuve de stockage/sécurité. | **Non comme remplacement.** Conserver DB8 pour les petits objets et le magasin de fichiers du service pour le catalogue. PoC séparé seulement si un besoin mesuré le justifie. |
| 2. `putBatch` de 500–1000 objets | Le nom ne correspond pas à l’API LG : elle documente `batch`; `put` accepte déjà un tableau d’objets. Les limites de paquet ne justifient pas un lot arbitraire de 500–1000. | **Non applicable au catalogue actuel.** Quantifier uniquement les appels DB8 des checkpoints, sans retirer la vérification `_rev` de D-46. |
| 3. Chargement paresseux / par catégories | Le chargement par pages et les imports séparés par type sont compatibles avec l’architecture. Le téléchargement Xtream réellement « à la demande par catégorie » ne l’est pas encore par défaut. | **Partiellement oui.** Garder Live prioritaire; proposer la sélection de groupes comme option ou gestion de quota. Ne pas imposer une limite produit de 5 000 entrées sans réviser les critères de la spec. |
| 4. Web Worker pour le parsing | Worker navigateur possible en théorie; `worker_threads` n’existe pas dans le Node 8.12 du service. Le parsing courant s’exécute dans le service, pas sur le thread UI. | **Pas comme première mesure.** Profiler les points synchrones, puis découper/cooperer sur la boucle du service; worker UI seulement pour un besoin UI démontré. |
| 5. Réduire les payloads | Déjà largement appliqué à la frontière de parsing et à l’écriture d’index. | **Oui, poursuivre sans amincir les champs normatifs** (identité, référence, groupe, ordre, sécurité, métadonnées utiles). |
| 6. Cacher la liste brute | Un cache brut peut contenir des URL et identifiants, consomme du disque et ne sert que si le fournisseur fournit un validateur fiable. | **Non comme stratégie générale.** Préférer un essai conditionnel `ETag`/`Last-Modified`, avec repli complet si absent ou invalide. |

## Ce que fait déjà l’application

### 1. Le catalogue ne passe pas par DB8

- `XtreamProvider.streamContentType()` appelle l’action Xtream globale puis n’essaie le repli par catégorie que si l’appel global échoue avant d’avoir livré des entrées (`src/service/providers/xtream.ts:307-359`).
- La réponse est décodée avec `IncrementalJsonParser`; chaque objet est validé et remis immédiatement à l’importateur. Le code ne fait pas `JSON.parse()` de l’énorme tableau et n’en conserve pas tous les objets (`src/service/providers/xtream.ts:363-405`, `src/service/http/jsonStream.ts`).
- `CatalogIndexWriter.append()` encode les enregistrements et charges utiles dans des fichiers d’index chiffrés du répertoire privé du service (`src/service/store/writer.ts:302-378`). L’index est basculé après finalisation; le format de blocs AES-GCM et l’index de catalogue sont normatifs dans §15.2–15.3.
- Le writer accumule les octets dans des blocs chiffrés de 4 Kio et fait des écritures fichier par bloc (`src/service/crypto/indexCrypto.ts:315-344`), pas une requête DB8 par chaîne.
- Les pages de consultation sont locales, bornées par le contrat LS2; la spec fixe ≤ 200 objets et ≤ 256 Kio. La lecture par pages est donc déjà la forme de lazy loading d’affichage.

DB8 sert aux profils, clés, consentements, favoris/reprises et jobs. En particulier, un job est sauvegardé environ tous les 2 000 éléments ou 4 Mio, selon le seuil atteint (`src/service/import/xtreamImport.ts:68-69, 182-209`). Après D-46, une mise à jour d’un job existant implique normalement un `find` du dépôt, un `get` de sa révision et un `put` (`src/service/db8/repositories.ts:203-207`, `src/service/db8/client.ts:309-368`). C’est un coût à mesurer et éventuellement optimiser, mais **pas 250 000 écritures individuelles**. Le contrôle de révision doit rester : l’avoir supprimé réintroduirait précisément le refus TV `-3960` corrigé en 0.1.17.

### 2. Les données sont déjà assainies et compactées

`parseStreamRecord()` choisit explicitement les champs Xtream utiles; le writer conserve une charge courte compacte (titre, groupe, identifiant de référence, logo, EPG, année/durée, résumé plafonné) et met les détails/URL dans une charge lourde consultée séparément (`src/service/providers/xtreamSchema.ts`, `src/service/store/record.ts`, `src/service/store/writer.ts:328-348`). Les URL de flux restent dans les modes sécurisés définis par la spec, pas dans une réponse de liste à l’UI.

On ne peut toutefois pas réduire chaque objet aux seuls `name`, `stream_id`, `url`, `logo`, `category_id` : l’identité, le rang source, les compteurs/plages de groupe, la recherche, la résolution, les favoris/reprises et la politique d’hôte ont aussi des contrats. Une URL peut elle-même contenir des secrets; elle ne doit jamais devenir une donnée « lean » en clair.

### 3. Les hypothèses les plus justes sur le risque actuel

L’import s’exécute dans le service Node; l’UI reçoit surtout des états/progressions LS2. Un parsing lourd en JavaScript dans le thread UI — scénario auquel répond la proposition Worker — n’est donc pas le chemin actuel. En revanche, deux étapes synchrones du service méritent une mesure à 250 k éléments :

- `CatalogIndexWriter.finish()` lance successivement la construction de l’ordre de titres, des tranches, de l’index titres et de l’index de références (`src/service/store/writer.ts:448-458`).
- `buildTitleOrder()` trie une table d’indices avec un comparateur personnalisé; la production de `refs.idx` effectue aussi un tri. La construction des tranches relit et décode les titres (`src/service/store/writer.ts:561-590`). Ces travaux peuvent retarder les autres tâches LS2 pendant leur exécution, même si l’UI demeure dans un autre processus.

Le réseau et l’écriture séquentielle peuvent également compter. Le client HTTP décompresse en flux, impose des plafonds et remet les blocs au parseur (`src/service/http/httpClient.ts`); la taille configurée Xtream est élevée pour permettre le test de capacité, mais ce n’est **pas** une preuve de débit, de mémoire ou de capacité disque sur TV. Le pic doit inclure ancien index, staging, nouvel index et éventuel cache, comme l’exige déjà §2.4/0D.

## Analyse détaillée

### IndexedDB : viable comme technologie, mauvais remplacement ici

Le moteur webOS TV 6 est Chromium 79 selon LG [7](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine). IndexedDB côté navigateur est donc une piste techniquement plausible. Cela ne signifie pas que son quota, sa rétention en paquet webOS, son comportement sous pression disque ou sa performance sur les téléviseurs ciblés soient garantis par cette seule version du moteur; il faudrait les vérifier sur appareil réel.

Plus important : le service JS est le propriétaire du réseau, de l’écriture de fichiers et du traitement du catalogue. LG précise que les fichiers téléchargés par un service ne sont pas accessibles directement aux web apps [1](https://webostv.developer.lge.com/develop/guides/js-service-basics). Remplacer le magasin du service par IndexedDB côté app demande donc soit de transférer les enregistrements par LS2 (réintroduisant une frontière IPC et une nouvelle enveloppe de transport), soit de déplacer téléchargement et validation réseau vers l’UI (CORS, politique HTTP clair §8.2, redirections/DNS/anti-SSRF, traitement des secrets et accès aux fichiers à revoir). Il faudrait aussi préserver le chiffrement au repos AES-256-GCM de §15.3. Ce n’est pas un changement local de moteur de stockage.

IndexedDB peut être évalué séparément pour un petit cache UI non sensible, mais il ne faut pas promettre « des dizaines de fois plus rapide » sans benchmark webOS réel. Et remplacer DB8 entièrement serait une mauvaise interprétation : DB8 doit rester le registre durable des profils, consentements et jobs.

### DB8 : corriger le nom de l’API et viser le bon volume

La référence LG expose `batch`, pas une méthode `putBatch`. `batch` accepte notamment `put`, `get`, `del`, `find` et `merge`, et LG précise que l’atomicité n’est pas garantie entre opérations groupées. La méthode `put` reçoit elle-même un tableau d’objets [1](https://webostv.developer.lge.com/develop/references/database). La documentation TV annonce aussi une limite globale partagée de 10 Mo pour DB8 et Media DB [8](https://webostv.developer.lge.com/develop/guides/db8-faq). Cela confirme qu’un catalogue de plusieurs centaines de milliers d’entrées n’a pas sa place dans DB8, mais le magasin de fichiers actuel a déjà résolu ce problème.

Les lots « 500–1000 » ne sont pas un seuil fourni par LG et ne doivent pas être imposés sans tester taille JSON, délai LS2, coût de sérialisation et erreurs de quota. Un `batch` ne résout pas à lui seul le protocole D-46 : les `_rev` courants requis pour les mises à jour doivent être connus; le wrapper DB8 ne rend pas une transaction multi-opérations atomique.

### Chargement paresseux : distinguer import, filtrage et affichage

Le découpage de livraison « Live d’abord, VOD puis Séries » concorde avec §1.4. L’import est par type de contenu, et l’UI peut lire le catalogue local par pages. En revanche, le provider lance normalement une action globale Xtream; le filtre `groups` est appliqué après réception/parsing des enregistrements (`src/service/import/xtreamImport.ts:182-209`). Le repli catégorie n’est pas le mode de performance par défaut : la spec §5.1 le réserve aux portails qui refusent l’action globale, aux limites de réponse ou à la sélection locale après quota.

Une règle « ne jamais importer plus de 5 000 VOD/séries » contredirait la qualification à 250 000 éléments de §5.2/§12 et pourrait casser la recherche globale prévue pour VOD/séries. Elle est possible seulement comme **décision produit explicite** : catalogue partiel par catégorie, indication « résultats incomplets », navigation réseau/dépendance à la disponibilité du portail, et critères de recherche redéfinis. Elle ne doit pas être introduite comme optimisation invisible. La variante de moindre risque est une sélection de groupes opt-in si le quota est atteint, comme le prévoit déjà §5.2; le gain réseau n’est réel que si l’adaptateur demande effectivement les catégories retenues plutôt que de télécharger l’action globale.

### Web Worker : mauvais côté de la frontière

LG documente le runtime du service en Node 8.12 pour webOS 6; le contrat du dépôt exclut `worker_threads` dans cette cible [1](https://webostv.developer.lge.com/develop/guides/js-service-basics), et la spec §2.3 le rappelle. Un Worker navigateur est une autre API et ne peut pas, à lui seul, lire le magasin privé du service ni remplacer les contrôles réseau du client Node.

Pour l’import actuel, le meilleur équivalent est de garder le parseur incrémental côté service, vérifier les temps de traitement d’un fragment HTTP et de `finish()`, puis découper les longues tâches en tranches coopératives avec backpressure/annulation (`setImmediate` côté Node 8, après preuve). Un Worker navigateur ne devient utile que si un traitement appartenant réellement à l’UI bloque la navigation; le test pertinent est alors le p95 D-pad/focus, non la seule affirmation « 60 FPS ».

### Cache : validateurs HTTP avant stockage brut

Le client HTTP renvoie déjà `ETag`, `Last-Modified` et l’indication de prise en charge des plages; le manifeste possède déjà un champ `etag` optionnel (`src/service/http/httpClient.ts`, `src/service/store/manifest.ts:16-35`). En revanche, le chemin d’import ne transmet pas encore ces validateurs au manifeste et le traitement Xtream attend une réponse JSON valide : un `304 Not Modified` doit être pris en charge explicitement avant de pouvoir réutiliser l’index.

Une expérience raisonnable est donc : vérifier sur des portails de test autorisés si l’action Xtream de liste produit un validateur stable et répond `304` à `If-None-Match`; si oui, conserver le validateur dans le manifeste et réutiliser l’index chiffré existant. Sinon, re-télécharger et reconstruire comme aujourd’hui. Ne pas supposer qu’ETag, Range ou une pagination serveur sont offerts par tous les portails Xtream.

Une copie brute peut contenir `direct_source`, URL de flux ou autres secrets, doit elle aussi être protégée au repos et augmente le pic disque précisément sur les appareils à eMMC lente. `CacheStorage` côté navigateur n’est pas le magasin privé du service. Sans validateur fiable, stocker toute la réponse retarde seulement le coût (et le parsing restera nécessaire après redémarrage); ce n’est donc pas le choix par défaut.

## Plan de vérification recommandé (sans modifier l’architecture)

1. **Ne pas migrer le stockage** et ne pas ajouter de `putBatch` dans cette étape. Garder le correctif D-46 et son contrôle strict.
2. Après validation de l’import 0.1.17 sur la TV, effectuer la campagne 0D prévue par la spec, uniquement lorsque les prérequis et le feu vert de progression sont réunis : jeux synthétiques 10 k / 50 k / 250 k, taille décompressée jusqu’à 256 Mio, plusieurs nombres de catégories et au moins un catalogue avec métadonnées lourdes.
3. Chronométrer séparément : réseau décompressé; parsing/normalisation; écriture des fichiers; `finish()` (tri titres, buckets, références); chiffrement et `fsync`; appels DB8 et latence par appel. Relever RSS/heap du service et de l’app, durée de blocage/retard des réponses LS2, p95 D-pad/focus, espace disque avant/pendant/après et pic ancien index + staging + nouvel index.
4. Si la finalisation est le pic, étudier d’abord le découpage coopératif et/ou l’algorithme de construction des index; si DB8 pèse réellement dans la durée, optimiser seulement les checkpoints, en gardant les tests `_rev`/conflit de révision; si le réseau domine, tester ETag conditionnel sur les portails autorisés.
5. Ne considérer un remplacement IndexedDB ou un Worker navigateur qu’avec un prototype séparé sur le paquet installé, mesurant quota/éviction, persistance après mise à jour, confidentialité, RSS, latence et compatibilité de la TV cible. Ce serait une révision d’architecture/spec, pas une optimisation transparente.

**Limite de cette étude :** elle établit l’adéquation au code et à la spec, pas les performances d’une gamme LG donnée. Aucun import de 250 k entrées n’a été mesuré sur TV; aucune promesse de vitesse n’est donc faite. Cette étude ne lance ni développement V1-B ni essai 0B. Après sa rédaction, l’utilisateur a autorisé uniquement la préparation documentaire de la 0B média; aucun essai 0B n’a encore été exécuté ou consigné.

## Références internes

- `docs/SPEC-v1.3.md` — §§1.4, 2.3–2.4, 5.1–5.2, 8.2, 11.2, 12, 15.2–15.5.
- `src/service/providers/xtream.ts` — import incrémental et repli par catégorie.
- `src/service/http/jsonStream.ts` — automate de parsing JSON incrémental.
- `src/service/import/xtreamImport.ts` — checkpoints et écriture dans le magasin de fichiers.
- `src/service/store/writer.ts`, `src/service/crypto/indexCrypto.ts` — index compact, tri, chiffrement et écriture par blocs.
- `src/service/db8/repositories.ts`, `src/service/db8/client.ts` — persistance des `ImportJob` et révisions D-46.
- `src/service/http/httpClient.ts`, `src/service/store/manifest.ts` — métadonnées HTTP disponibles et champ `etag` non encore relié à l’import.

## Références LG

- [1](https://webostv.developer.lge.com/develop/references/database) — méthodes DB8 documentées (`batch`, `put`) et sémantique des appels.
- [8](https://webostv.developer.lge.com/develop/guides/db8-faq) — limite DB8/Media DB partagée de 10 Mo.
- [7](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine) — Chromium 79 sur webOS TV 6.x.
- [1](https://webostv.developer.lge.com/develop/guides/js-service-basics) — Node 8.12 sur webOS 6; distinction service/app et accès aux fichiers.
