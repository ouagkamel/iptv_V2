## Paquet de diagnostic — phase 0A (0.1.2)

Cette version corrige un défaut **découvert sur la TV** : la page chargeait `webOSTV.js`, la
bibliothèque du SDK LG, **absente du paquet** — la console répondait
`Failed to load resource: net::ERR_FILE_NOT_FOUND webOSTV.js` et `window.webOS` restait vide, donc
aucun appel LS2 ne pouvait partir de l'application.

### Correctifs

| Réf. | Défaut | Correctif |
|---|---|---|
| D-17 | `net::ERR_FILE_NOT_FOUND webOSTV.js`, `window.webOS` absent | `webos-bridge.js` embarqué : pont LS2 maison (sans dépendance) qui fournit `webOS.service.request`, `webOS.deviceInfo` et `webOS.platformBack` ; il ne remplace jamais un `webOS` fourni par la plateforme. Un test vérifie que **toute ressource citée par la page existe dans le paquet** |
| D-18 | risque d'enregistrement silencieux | `services.json` et `package.json` du service en **ASCII pur** : le hub lit ce fichier pour enregistrer le service |
| — | diagnostic difficile à distance | la page affiche le pont réellement utilisé, la présence de `PalmServiceBridge`/`PalmSystem`, le nom exact du service appelé, puis exécute un **appel de contrôle** et, si le bus répond « Service does not exist », affiche les gestes exacts à faire ; bouton **Témoin du bus LS2** (service *du système*) pour distinguer « pont cassé » de « service inconnu » |

Rappel de la version précédente (0.1.1) : démarrage du service au chargement du module
(le défaut `Service does not exist` côté service), en-tête `User-Agent`, gzip, lookup épinglé,
consentement HTTP clair, index `refs.idx` (résolution par dichotomie), contrôle de sûreté qui ne
prend plus les URL de logos pour des secrets.

### Si le message persiste après installation

Il vient alors de l'**enregistrement du service par la TV**, pas du paquet :

```bash
ares-install --device tv --listfull                                  # version reellement installee
ares-install --device tv -r com.ouagkamel.app.iptvplayer             # desinstallation complete
ares-install --device tv com.ouagkamel.app.iptvplayer_0.1.2_all.ipk  # reinstallation
# redemarrer la TV (le hub relit ses services au demarrage)
ares-inspect --device tv -s com.ouagkamel.app.iptvplayer.service -o   # lance le service, ouvre sa console
```

### Vérifications

- `npm test` : **154 tests, 0 échec**, sur Node 20 **et** sur Node 8.12 (cible réelle du service) ;
- `npm run verify:portal` sur un portail Xtream réel, exécuté **sur Node 8.12** : test de connexion,
  import de 5 299 chaînes live en 1,5 s, page de 200 objets, détail sans secret, `resolveStream` puis
  lecture réelle du flux (`HTTP 200 video/mp2t`, `0x47` tous les 188 octets) ;
- `.ipk` vérifié : le service est présent (`usr/palm/services/…`, `index.js`, `lib/`), la page ne
  référence plus que des fichiers embarqués.
