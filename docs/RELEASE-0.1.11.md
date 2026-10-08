## Bandeau « cle maitre absente » : corrige (0.1.11)

Le bandeau observe apres l'import — **« categories : catalog/corrupt — cle maitre absente : index
illisible (reimporter la source) »** — ne venait ni du catalogue ni du chiffrement : la cle maitre
etait **ecrite** puis jamais **relue**. La cause est une regle de DB8 que nous n'appliquions pas.

### La cause

Le guide DB8 de LG est sans ambiguite : « **All queries must be on indexed fields** … You can only
query on an indexed property ». Les index d'un kind se declarent au moment de sa creation, par le
parametre `indexes` de `putKind` — et nos kinds etaient enregistres **sans aucun index**. Deux
consequences :

- les recherches `find('masterKeys', {profileId})`, `find('profiles', ...)`, `find('importJobs', ...)`
  ne peuvent rien renvoyer sur un appareil : DB8 repond `-3965 db: no index for query`, ou ne repond
  rien (`returnValue` absent) — les deux etaient pris pour « aucune ligne » ;
- `preferences`, et surtout l'index chiffre du catalogue, reposent sur la cle maitre rangee par
  `profileId` : sans relecture, l'application concluait « index illisible » et proposait de
  **reimporter**, ce qui n'aurait pas corrige la cause.

DB8 n'ajoute pas d'index a un kind deja enregistre : il faut recreer le kind. C'est pourquoi le
versionnement des kinds, prevu des le depart, sert maintenant a quelque chose.

### Ce qui est corrige

| Ref. | Constat | Correctif |
|---|---|---|
| **D-40a** | `putKind` sans `indexes` : rien n'est interrogeable | `KIND_INDEXES` declare les index de chaque kind — exactement les champs que les depots interrogent |
| **D-40b** | Un kind existant ne peut plus etre indexe | `KIND_VERSIONS` passe a **2** : kinds neufs, indexes (`probes:1` en plus, pour la sonde) |
| **D-40c** | Les donnees de l'ancien schema auraient ete perdues, cle maitre comprise — donc l'index deja importe | `migrateLegacyKinds()` : au premier lancement, les lignes des kinds v1 sont **reprises** dans les v2 (la lecture d'un kind herite se fait sans contrainte de champ). Journalise, jamais silencieux |
| **D-40d** | Un echec DB8 passait pour « aucune ligne » | `find` exige `returnValue === true` et relaie le code et le texte exacts de la plateforme; une requete sur un champ non indexe est **refusee avant tout appel** |
| **D-40e** | Deux depots interrogeaient des champs non indexes (`consents.kind`/`insecureHost`, `favorites.deleted`) : silencieusement vides sur un vrai DB8 | Requete sur `profileId` (indexe), comparaison des autres champs en memoire |
| **D-40f** | L'ecriture de la cle maitre n'etait jamais verifiee : le defaut n'apparaissait qu'a la premiere lecture du catalogue | `ensure()` relit la cle aussitot : si le kind n'est pas utilisable, **l'import echoue sur-le-champ** avec la cause, au lieu de produire un index illisible |
| **D-40g** | Aucun moyen de savoir ce que DB8 repond vraiment | Sonde dans `diagnostics` (enregistrement, ecriture, relecture **par index**, suppression) ; la page de diagnostic l'affiche et alerte si elle echoue |

### Pourquoi les tests ne l'avaient pas vu

`FakeDb8Bus` faisait une correspondance exacte sur n'importe quel champ : un DB8 **plus permissif que
le vrai**. Le faux bus applique desormais la regle du guide : seuls `_id`, `_kind` et les proprietes
**indexees** sont interrogeables (`-3965` sinon), un `putKind` sur un kind existant est refuse
(`61115`), un `put` sur un kind inconnu echoue (`-3970`). Rejoue sur les 14 operations des depots,
ce bus a designe **3 requetes fautives** — corrigees une par une (14/14).

Consequence a garder en tete : un kind qui « repond vide » n'est pas une preuve d'absence ; c'est
souvent un index manquant. Le garde client et la sonde existent pour cela — ne jamais les relacher
pour faire passer un cas.

### Les donnees existantes ne sont pas perdues

Au premier lancement de 0.1.11, la reprise v1 -> v2 recopie `profiles`, `preferences`, `epgMappings`,
`favorites`, `playbacks`, `importJobs`, `masterKeys`, `consents` depuis l'ancien kind **vers le
nouveau, vide** uniquement. La cle maitre etant identique, **l'index deja importe reste lisible sans
reimport**. Si la reprise echoue, le bandeau de diagnostic le dit et un import regulier suffit.

### Etat des controles

| Controle | Resultat |
|---|---|
| `npm test` | **215 tests, 0 echec** (Node 20 **et** Node 8.12) |
| `npm run lint:node812` / `check:deps` / `typecheck` | OK |
| Faux DB8 **strict** (14 operations des depots) | 14/14 |
| Banc headless (paquet public) | `verdict OK`, `theme: true`, `requetes: []`, `ressourcesManquantes: []` |
| Controle visuel (Chromium) | police `Sandstone`, texte `rgb(230,230,230)`, contraste 16,83, aucune ressource en echec |

### Ce qu'il faut essayer sur le simulateur, dans cet ordre

1. Installer 0.1.11 par-dessus l'installation existante (le profil et l'index deja importes sont
   attendus).
2. Accueil : quatre cartes, texte clair sur fond noir.
3. **Live TV** : les categories doivent s'afficher sans bandeau — c'est le point corrige.
4. Reglages -> « Importer (live) » seulement si les categories restent vides.
5. En cas de doute, Reglages -> « Page de diagnostic (0A) » : la ligne **sonde** indique ce que DB8
   repond reellement (`ok (etape)` / `echec ...`), et `kinds` la version des kinds lus.

> Les pictogrammes des tuiles viennent de la police systeme « LG Icons » des televiseurs LG : hors TV
> LG (simulateur sur poste sans cette police), les noms s'affichent a la place des icones. Ce n'est pas
> un defaut.
