# Contrôle de distribution — LG Seller Lounge (go/no-go bloquant)

À **lancer dès le début de la 0A** et à **trancher avant V1-B** (`docs/PHASE-0.md`). Aucun repli
silencieux : un refus ou une condition inacceptable change le produit ou le mode de distribution.

Ce document est la version « prête à envoyer » de la trame du plan : le message est rédigé
ci-dessous en français et en anglais (LG répond en anglais), suivi de la liste exacte de ce qu'il
faut récupérer et de la fiche de relevé.

## 1. Avant d'écrire : relire et noter (une demi-journée)

- [ ] **Self Checklist** LG (webOS TV App Self Checklist) — la structure dicte les pièces à joindre ;
      **son absence entraîne un rejet** de la soumission.
- [ ] **Processus d'approbation** : pretest, function test, content test — noter les délais annoncés.
- [ ] **Privacy Guideline** LG : ce qu'une application doit déclarer en matière de confidentialité.
- [ ] `docs/SPEC-v1.3.md` §15.3 (§15.4) : ce que l'application **ne fait pas** — ne collecte aucune
      donnée d'usage, ne journalise aucun identifiant, ne fournit aucun contenu. C'est l'argumentaire.
- [ ] **Applications comparables** déjà publiées sur le Content Store (lecteurs de playlists
      fournies par l'utilisateur) : nom, éditeur, pays, date — c'est le précédent le plus utile.

## 2. Message à envoyer (français)

> **Objet : positionnement d'une application « lecteur » sur le LG Content Store**
>
> Bonjour,
>
> Nous préparons la publication d'une application pour téléviseurs LG webOS 6 et suivants et
> souhaitons faire valider son positionnement **avant** de poursuivre le développement.
>
> L'application est un **lecteur** : elle ne fournit, ne découvre, ne partage et ne vend aucun
> contenu, aucune playlist et aucun identifiant. L'utilisateur configure lui-même une source
> (portail compatible Xtream ou playlist M3U) qu'il déclare être autorisé à utiliser. L'application
> ne contourne aucun DRM, ne met en place aucun proxy, n'intègre aucun SDK tiers publicitaire et
> n'utilise aucune ressource de l'appareil en dehors de la lecture demandée par l'utilisateur.
>
> Questions :
> 1. ce modèle est-il acceptable pour une publication sur le Content Store ;
> 2. quelles mentions obligatoires doivent figurer (page confidentialité, mention « cette application
>    ne fournit aucun contenu ») ;
> 3. quels pays de distribution sont autorisés ;
> 4. quelles sont les exigences et le calendrier de revue (pretest, function test, content test) ?
>
> Nous conserverons votre réponse comme référence contractuelle du positionnement de l'application.
>
> Cordialement,

## 3. Message à envoyer (anglais)

> **Subject: positioning of a "player-only" app on LG Content Store**
>
> Hello,
>
> We are preparing the release of an app for LG webOS 6 and later TVs, and we would like the
> positioning validated **before** going further in development.
>
> The app is a **player**: it provides, discovers, shares and sells no content, no playlist and no
> credentials. The user configures a source (an Xtream-compatible portal or an M3U playlist) that
> they declare they are entitled to use. The app circumvents no DRM, runs no proxy, embeds no
> third-party advertising SDK, and uses no device resource other than the playback the user asks
> for.
>
> Questions:
> 1. Is this model acceptable for publication on the Content Store?
> 2. What mandatory statements are required (privacy page, "this app provides no content")?
> 3. Which distribution countries are allowed?
> 4. What are the review requirements and timeline (pretest, function test, content test)?
>
> We will keep your answer as the reference for the app's positioning.
>
> Best regards,

## 4. Fiche de relevé (à remplir au retour)

```
Date d'envoi : ........   Canal : ( ) Seller Lounge  ( ) courriel  ( ) forum développeur
Accusé de réception : ( ) reçu le ........   ( ) aucun
Réponse écrite : ( ) reçue le ........   ( ) non

1. Modèle accepté ?
   ( ) oui   ( ) oui, sous conditions -> ............................................
   ( ) non   -> ......................................  (décision produit à prendre)
2. Mentions obligatoires exigées : ................................................
3. Pays de distribution autorisés : ..............................................
4. Revue : pretest ........ ; function test ........ ; content test ........ ;
   calendrier annoncé : ...........................................................
5. Self Checklist : ( ) récupérée  ( ) remplie  ( ) téléversée le ........
6. Applications comparables relevées : nom / éditeur / pays / date
   ................................................................................
```

## 5. Ce qu'on en fait

- **Réponse écrite obtenue et conditions acceptables** → GO distribution ; recopier la fiche dans
  `docs/JOURNAL.md` (entrée 0A) et conserver la réponse hors dépôt (elle peut contenir des
  informations commerciales).
- **Refus, ou condition inacceptable** (mention impossible, pays exclu, exigence de contenu) → le
  GO est **suspendu**, pas contourné : la décision (produit ou mode de distribution) se prend ici,
  avant d'engager la V1-B.
- **Silence** → relancer une fois, consigner la date dans le journal ; le GO reste suspendu.
