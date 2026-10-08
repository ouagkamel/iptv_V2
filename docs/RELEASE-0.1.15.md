## Lecture d'une chaîne : « MediaError 4 » — le conteneur servi ne suivait pas le lecteur (0.1.15)

Le flux était **bien servi** : le journal réseau montre `…/229564.ts` → **302**, suivi de **200**
`video/mp2t`, 1,1 Mo — deux fois, parce que le lecteur réessaie une fois avant d'afficher l'erreur.
Le refus ne venait donc ni du portail, ni de l'index, ni du réseau : le pipeline média a répondu
`MediaError 4` (`MEDIA_ERR_SRC_NOT_SUPPORTED`) sur un conteneur qu'il ne décode pas.

### La cause

Le lecteur demandait **toujours** `requestedFormat: 'auto'`, et le service répondait — par défaut —
une URL **MPEG-TS progressive** (`.ts`). Or la plateforme **déclare elle-même** ce qu'elle sait lire
(`HTMLMediaElement.canPlayType`) : cette information n'était jamais consultée, et le `preferredMime`
renvoyé par `resolveStream` jamais utilisé. Le format partait donc à pile ou face — et la 0B, qui doit
qualifier **HLS puis MPEG-TS**, n'avait même pas commencé.

### Ce qui est corrigé

| Réf. | Constat | Correctif |
|---|---|---|
| **D-44a** | Format de direct figé sur MPEG-TS, sans consulter le lecteur | `src/app/mediaformats.js` : l'ordre d'essai suit `canPlayType` — **HLS d'abord** (adaptatif, pris en charge nativement), **MPEG-TS** dès qu'il est le seul déclaré, l'autre format **toujours** essayé ensuite. `canPlayType` absent, muet ou capricieux ⇒ ordre par défaut HLS → TS, jamais d'exception |
| **D-44b** | Un échec média ne se distinguait pas d'une URL expirée | Message par nature : `4` = format non pris en charge, `3` = décodage, `2` = flux interrompu ou expiré — **suivi des formats réellement essayés** (`formats essayés : hls, ts`), comme l'exige la consignation 0B |
| **D-44c** | Aucun repli : un conteneur refusé condamnait la chaîne | Séquence **bornée** : même format re-résolu une fois (URL expirée), puis l'autre conteneur une fois, puis message. Jamais de boucle |
| **D-44d** | Le `preferredMime` de `resolveStream` était ignoré | Le lecteur en déduit le conteneur **effectivement servi** (un index `storedSecret` peut rendre une URL dans un autre format que celui demandé) : il ne recharge pas deux fois la même URL sous deux étiquettes |
| **D-44e** | Défaut de direct du service : `auto` ⇒ `.ts` | `auto` ⇒ **HLS** (la préférence du profil reste prioritaire ; `'ts'` reste demandable explicitement). La forme conservée en mode `derived` suit la même règle |
| **D-44f** | Un index **déjà importé** mémorise des URL `.ts` : le correctif seul n'aurait rien changé | `resolveStream` sert une URL mémorisée dans le conteneur demandé **si elle est directe** (sans paramètres de requête) ; une URL signée est laissée intacte. **Aucun réimport n'est nécessaire** |
| **D-44g** | Rien ne prouvait ce que la plateforme sait lire | Page de diagnostic : ligne **« formats de flux déclarés »** (`canPlayType`, avec l'ordre d'essai qui en découle) — c'est la preuve à consigner en §0B |

### État des contrôles

| Contrôle | Résultat |
|---|---|
| `npm test` | **243 tests, 0 échec** (Node 20 **et** Node 8.12) |
| `npm run lint:node812` / `check:deps` / `typecheck` | OK |
| Banc headless (paquet public) | `verdict OK`, `theme: true`, 0 requête, 0 ressource manquante |
| Garde des pièces publiées (ipk) | « publiable » |
| Identifiants du compte de test | 0 occurrence (ipk et les deux archives) |
| Paquet inspecté | `mediaformats.js` embarqué et chargé par la page de diagnostic ; bundle : HLS/TS + message enrichi ; service : `auto` → HLS |

### Ce qu'il faut essayer, dans cet ordre

1. Installer 0.1.15 par-dessus l'installation existante. **Pas besoin de réimporter** : une URL de
   direct directe est servie dans le format demandé par le lecteur.
2. *Réglages* → **« Page de diagnostic (0A) »** : relever la ligne **« formats de flux déclarés »**
   (elle dit par exemple `HLS : maybe ; MPEG-TS : non`) — c'est la preuve §0B.
3. *Live TV* → une chaîne : la lecture doit démarrer ; en cas d'échec, le message **nomme** désormais
   les formats essayés (`formats essayés : hls, ts`), ce qui distingue « conteneur refusé » de
   « flux interrompu ou expiré ». Le recopier tel quel dans `docs/PHASE-0.md` §0B.
4. Si HLS échoue et TS réussit (ou l'inverse), c'est un **résultat** : il fixe la cellule 0B de cet
   appareil et se consigne.

> Les pictogrammes des tuiles viennent de la police système « LG Icons » des téléviseurs LG : hors TV
> LG (simulateur sur poste sans cette police), les noms s'affichent à la place des icônes. Ce n'est pas
> un défaut.
