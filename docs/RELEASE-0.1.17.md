# 0.1.17 — l'import sur le téléviseur : DB8 exige le `_rev` des objets existants (D-46)

**Date** : 2026-10-11 · **Base** : 0.1.16 · **Symptôme** : `importPlaylist` refusé sur TV réelle

## Ce qui a été observé (TV réelle, paquet 0.1.16)

```
importplaylist (progression) : internal/unexpected - appel LS2 refuse (-3960) :
db : _rev must be specified for existing objects (Luna://com.palm.db/put) [reessayable]
```

L'import démarrait puis s'arrêtait à la **première mise à jour** de son état.

## La cause

Le service relit une ligne DB8 (trouvée par son index), la modifie et la réécrit **en repassant son
`_id`** — sans `_rev`. C'est le cas de la ligne de progression d'un import (écrite à chaque phase),
du profil, de la clé maître, des consentements, des favoris, des reprises.

DB8 refuse exactement cela : `-3960 db: _rev must be specified for existing objects`. Et si la
révision est fournie mais périmée, il répond `-3961 db: revision mismatch - expected <n>, got <m>`,
en demandant de **relire puis réessayer** (documentation DB8, méthode `put`). Le service ne fournissait
aucune des deux.

Pourquoi les tests ne l'avaient pas vu : le **faux bus** des tests écrasait silencieusement une ligne
existante, `_id` ou pas, `_rev` ou pas. Il était plus permissif que DB8 — donc le défaut ne pouvait
apparaître que sur l'appareil.

## Le correctif

| Réf. | Décision | Motif |
| --- | --- | --- |
| **D-46a** | Toute écriture sur un objet portant un `_id` lit d'abord sa révision par **`get`** (la méthode DB8 pour lire par identifiant) | C'est le seul protocole que DB8 accepte ; il est appliqué au même endroit pour tous les dépôts |
| **D-46b** | Un conflit (`-3960`/`-3961`) est rejoué **une fois** après relecture, puis l'échec remonte | Comportement documenté par DB8 ; une seule reprise suffit et une boucle masquerait une base réellement indisponible |
| **D-46c** | Un `_id` **inconnu de la base** est retiré : l'objet est créé (DB8 attribue l'identifiant) | La ligne a disparu entre la lecture et l'écriture : mieux vaut la recréer que d'écrire sur un identifiant fantôme |
| **D-46d** | Le **faux bus** applique la règle de DB8 : `_rev` attribué à chaque écriture, `put`/`merge` refusés sans `_rev` (`-3960`) ou avec un `_rev` périmé (`-3961`), `get` rendant `_rev` | Un client qui parle un dialecte à lui doit échouer **dans les tests**, pas sur l'appareil — c'est la leçon de ce défaut |
| **D-46e** | Le client reconnaît le conflit **quelle que soit la forme** de l'échec : réponse `returnValue: false` (appel direct) ou erreur rejetée par le pont LS2 (« appel LS2 refuse (-3960) : … ») | Sur la TV, c'est le pont qui rejette : un test qui ne couvrirait qu'une forme serait aveugle |

## Fichiers

- `src/service/db8/client.ts` — `put`/`merge` passent par `ecrireAvecRevisions()` (lecture des
  révisions par `get`, jointure du `_rev`, reprise bornée), `avecRevisions()`, `revisions()`,
  `conflitDeRevision()`, et le faux bus enrichi (`get`, révisions, refus `-3960`/`-3961`).
- `tests/db8.test.js` — 7 cas ajoutés : refus du bus sans `_rev` (`-3960`) et avec un `_rev` périmé
  (`-3961`), relecture prouvée par le journal des appels, **ligne de job réécrite à chaque phase**
  (le chemin exact du défaut), conflit réel rejoué une fois, `_id` disparu recréé, parcours complet
  (profil réécrit, import, catégories, résolution) sur le bus strict.

## Contrôles

- Les nouveaux cas **échouent sans le correctif** (vérifié en neutralisant la jointure du `_rev` dans
  le code compilé : 5 échecs, dont « l'écriture rejouée d'une ligne de job » et l'import complet).
- `npm run verify` : **260 tests, 0 échec** — y compris sous **Node 8.12**.
- Paquet reconstruit, contenu et empreintes contrôlés ; aucune source déclarée dans les pièces
  publiques.

## Ce qu'il faut faire sur la TV

Réinstaller le paquet de cette version et **relancer l'import** : c'est la marche qui échouait.
L'import déjà tenté n'a rien laissé d'incohérent (l'écriture de progression a été refusée avant
toute publication d'index) ; en cas de doute, *Réglages* → « Importer (live) » suffit.
