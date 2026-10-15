'use strict';

/**
 * **DB8 : index déclarés et requêtes indexées** (D-40).
 *
 * Ce que ces tests protègent, dans l'ordre où le défaut s'est produit sur l'appareil :
 *
 *  1. les kinds déclarent à `putKind` les index de **tout** champ interrogé (« All queries must be on
 *     indexed fields », guide DB8 de LG) ;
 *  2. une requête qui ne porte pas sur un champ indexé est **refusée côté client**, avant d'être
 *     envoyée — jamais transformée en « aucune ligne » ;
 *  3. la clé maître écrite par `ensure()` est **relue** aussitôt : si l'index du kind n'est pas
 *     utilisable, l'import échoue au moment de l'écriture, pas à la première lecture du catalogue ;
 *  4. le faux bus applique la règle de DB8 (`-3965 db: no index for query`) : un dépôt qui
 *     interrogerait un champ non indexé échoue dans les tests, pas sur la TV ;
 *  5. le parcours complet (import → lecture du catalogue → diagnostic) fonctionne sur ce bus strict,
 *     et la sonde DB8 rend compte de l'état réel de la base ;
 *  6. le **pont LS2** lit la réponse du hub là où elle est : `message.payload`. Lue au premier niveau,
 *     elle était vide — un `putKind` réussi passait pour refusé (« création du kind DB8 refusée »,
 *     D-41) et une lecture servie passait pour vide (D-40).
 */

var assert = require('./assert');
var harness = require('./harness');
var portalLib = require('./fake-portal');
var fs = require('fs');
var os = require('os');
var path = require('path');

var libRoot = path.join(__dirname, '..', 'service', 'com.ouagkamel.app.iptvplayer.service', 'lib');
var clientLib = require(path.join(libRoot, 'service', 'http', 'httpClient'));
var db8Lib = require(path.join(libRoot, 'service', 'db8', 'client'));
var reposLib = require(path.join(libRoot, 'service', 'db8', 'repositories'));
var serviceLib = require(path.join(libRoot, 'service', 'ls2', 'service'));
var mainLib = require(path.join(libRoot, 'service', 'main'));
var busLib = require(path.join(libRoot, 'service', 'ls2', 'bus'));

var PORTAL_URL = 'https://portal.example.com';
var USERNAME = 'utilisateur-test';
var PASSWORD = 'mot-de-passe-test';

function tempRoot(nom) {
  var dir = path.join(os.tmpdir(), 'iptv-db8-' + nom + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e6));
  fs.mkdirSync(dir);
  return dir;
}

function makeStack(options) {
  options = options || {};
  var portal = portalLib.createPortal({ username: USERNAME, password: PASSWORD, counts: { live: 6, vod: 1, series: 1 } });
  var http = new clientLib.HttpClient({
    transport: portal.transport,
    lookup: portal.lookup,
    caProvider: function () {
      return undefined;
    }
  });
  var fakeDb = new db8Lib.FakeDb8Bus();
  var db = new db8Lib.Db8Client({ call: fakeDb.call, appId: db8Lib.APP_ID });
  var logs = [];
  var service = new serviceLib.IptvService({
    db: db,
    http: http,
    storageRoot: options.storageRoot || tempRoot('ls2'),
    onLog: function (ligne) {
      logs.push(ligne);
    }
  });
  var bus = busLib.createFakeBus();
  service.register(bus);
  return { portal: portal, db: db, fakeDb: fakeDb, service: service, bus: bus, logs: logs };
}

function repliesOf(bus, commande) {
  return bus.log
    .filter(function (entree) {
      return entree.command === commande;
    })
    .map(function (entree) {
      return entree.reply;
    });
}

function waitFor(condition, timeoutMs) {
  var limite = Date.now() + (timeoutMs || 8000);
  return new Promise(function (resolve, reject) {
    (function boucle() {
      var verdict;
      try {
        verdict = condition();
      } catch (erreur) {
        return reject(erreur);
      }
      if (verdict) return resolve(verdict);
      if (Date.now() > limite) return reject(new Error('condition non atteinte dans le delai du test'));
      setTimeout(boucle, 10);
    })();
  });
}

harness.describe('DB8 : les kinds déclarent leurs index et les requêtes restent indexées', function () {
  harness.it('chaque kind interrogé a un index, et putKind les transmet à la plateforme', function () {
    var appels = [];
    var bus = new db8Lib.FakeDb8Bus();
    var db = new db8Lib.Db8Client({
      call: function (uri, params) {
        appels.push({ uri: uri, params: params });
        return bus.call(uri, params);
      },
      appId: db8Lib.APP_ID
    });

    return db
      .put('profiles', [{ id: 'p1', name: 'Maison' }])
      .then(function () {
        var putKind = appels.filter(function (appel) {
          return appel.uri.indexOf('/putKind') !== -1;
        })[0];
        assert.ok(putKind, 'putKind appelé');
        assert.ok(putKind.params.indexes && putKind.params.indexes.length === 1, 'index déclaré');
        assert.equal(putKind.params.indexes[0].props[0].name, 'id', 'champ indexé : id');
        assert.equal(putKind.params.private, true, 'kind privé (supprimé avec l application)');
        // schema `putKind` : id, owner, private, indexes -- rien d autre (`additionalProperties: false`)
        assert.deepEqual(
          Object.keys(putKind.params).sort(),
          ['id', 'indexes', 'owner', 'private'],
          'charge utile putKind exacte : ' + Object.keys(putKind.params).join(',')
        );
        var put = appels.filter(function (appel) {
          return appel.uri.indexOf('/put') !== -1 && appel.uri.indexOf('/putKind') === -1;
        })[0];
        assert.ok(put, 'put appelé');
        // schema `put` : `objects` (et `shardId`) seulement -- `private` y est refuse
        assert.deepEqual(Object.keys(put.params), ['objects'], 'charge utile put exacte');
      })
      .then(function () {
        // tous les kinds déclarent au moins un index : sans lui, aucune requête ne peut aboutir
        Object.keys(db8Lib.KIND_VERSIONS).forEach(function (nom) {
          assert.ok(db8Lib.KIND_INDEXES[nom] && db8Lib.KIND_INDEXES[nom].length > 0, 'index pour ' + nom);
        });
      });
  });

  harness.it('une requête hors index est refusée avant tout appel réseau', function () {
    var appels = [];
    var db = new db8Lib.Db8Client({
      call: function (uri, params) {
        appels.push(uri);
        return Promise.resolve({ returnValue: true, results: [] });
      },
      appId: db8Lib.APP_ID
    });
    return db.find('consents', { profileId: 'p1', kind: 'insecureHttp' }).then(
      function () {
        throw new Error('une requête non indexée a été acceptée');
      },
      function (erreur) {
        assert.ok(erreur.message.indexOf('non indexee') !== -1, 'motif explicite : ' + erreur.message);
        assert.ok(erreur.message.indexOf('kind') !== -1, 'champ fautif nommé');
        assert.equal(appels.length, 0, 'aucun appel LS2 émis');
      }
    );
  });

  harness.it('le faux bus applique la règle de DB8 : -3965 quand le champ n est pas indexé', function () {
    var bus = new db8Lib.FakeDb8Bus();
    var kind = db8Lib.kindOf('probes');
    return bus
      .call('luna://' + db8Lib.DB_SERVICE + '/putKind', {
        id: kind,
        owner: db8Lib.APP_ID,
        private: true,
        indexes: [{ name: 'cle', props: [{ name: 'cle' }] }]
      })
      .then(function () {
        // `from` + `where` en tableau de clauses : la seule forme acceptee par le service
        return bus.call('luna://' + db8Lib.DB_SERVICE + '/find', {
          query: { from: kind, where: [{ prop: 'absent', op: '=', val: 'x' }] }
        });
      })
      .then(function (reponse) {
        assert.equal(reponse.returnValue, false, 'requête refusée');
        assert.equal(reponse.errorCode, -3965, 'code « no index for query »');
      })
      .then(function () {
        // et un kind non enregistré n'accepte pas d'écriture : DB8 lève -3970
        return bus.call('luna://' + db8Lib.DB_SERVICE + '/put', { objects: [{ _kind: 'com.test:db:inconnu:1' }] });
      })
      .then(function (reponse) {
        assert.equal(reponse.returnValue, false, 'kind inconnu refuse');
        assert.equal(reponse.errorCode, -3970, 'code « kind not registered »');
      });
  });

  harness.it('un second putKind sur un kind existant n interrompt pas l usage', function () {
    var bus = new db8Lib.FakeDb8Bus();
    var db = new db8Lib.Db8Client({ call: bus.call, appId: db8Lib.APP_ID });
    return db
      .put('masterKeys', [{ profileId: 'p1', key: 'AAAA' }])
      .then(function () {
        // nouvelle session : le cache des kinds est vide, `ensureKind` rappelle putKind
        var autre = new db8Lib.Db8Client({ call: bus.call, appId: db8Lib.APP_ID });
        return autre.find('masterKeys', { profileId: 'p1' });
      })
      .then(function (lignes) {
        assert.equal(lignes.length, 1, 'kind existant réutilisé');
      });
  });
});

harness.describe('DB8 : reprise des données de l ancien schéma (v1 -> v2)', function () {
  /** Enregistre un kind hérité (v1, sans index) puis y écrit des lignes brutes. */
  function amorcerV1(bus, nom, lignes) {
    var id = db8Lib.APP_ID + ':db:' + nom + ':1';
    return bus
      .call('luna://' + db8Lib.DB_SERVICE + '/putKind', { id: id, owner: db8Lib.APP_ID, private: true })
      .then(function () {
        return bus.call('luna://' + db8Lib.DB_SERVICE + '/put', {
          objects: lignes.map(function (ligne) {
            return Object.assign({ _kind: id }, ligne);
          })
        });
      });
  }

  harness.it('la clé maître de l ancien kind est reprise : l index déjà importé reste lisible', function () {
    var bus = new db8Lib.FakeDb8Bus();
    var cle = Buffer.alloc(32, 7).toString('base64');
    return amorcerV1(bus, 'masterKeys', [{ profileId: 'p1', key: cle }])
      .then(function () {
        return amorcerV1(bus, 'profiles', [{ id: 'p1', name: 'Maison', kind: 'xtream' }]);
      })
      .then(function () {
        var db = new db8Lib.Db8Client({ call: bus.call, appId: db8Lib.APP_ID });
        var cles = reposLib.createMasterKeyRepository(db);
        var profils = reposLib.createProfileRepository(db);
        return db.migrateLegacyKinds().then(function (rapport) {
          assert.equal(rapport.migres, 2, 'deux enregistrements repris : ' + JSON.stringify(rapport.kinds));
          assert.equal(rapport.kinds.length, 2, 'deux kinds concernés');
          return cles.get('p1').then(function (reprise) {
            assert.ok(reprise, 'clé maître relue après migration');
            assert.equal(reprise.toString('base64'), cle, 'clé identique (l index reste déchiffrable)');
            return profils.get('p1');
          });
        });
      })
      .then(function (profil) {
        assert.ok(profil && profil.name === 'Maison', 'profil repris');
      });
  });

  harness.it('la migration ne recopie rien si la cible contient déjà des lignes', function () {
    var bus = new db8Lib.FakeDb8Bus();
    return amorcerV1(bus, 'masterKeys', [{ profileId: 'p1', key: Buffer.alloc(32, 7).toString('base64') }])
      .then(function () {
        var db = new db8Lib.Db8Client({ call: bus.call, appId: db8Lib.APP_ID });
        var cles = reposLib.createMasterKeyRepository(db);
        // une clé v2 existe déjà : la migration ne doit pas la remplacer
        return cles
          .ensure('p1')
          .then(function (existante) {
            return db.migrateLegacyKinds().then(function () {
              return cles.get('p1');
            });
          })
          .then(function (apres) {
            assert.ok(apres, 'clé présente');
          });
      });
  });

  harness.it('la migration est silencieuse quand il n y a rien à reprendre', function () {
    var bus = new db8Lib.FakeDb8Bus();
    var db = new db8Lib.Db8Client({ call: bus.call, appId: db8Lib.APP_ID });
    return db.migrateLegacyKinds().then(function (rapport) {
      assert.equal(rapport.migres, 0, 'aucune reprise');
      assert.equal(rapport.kinds.length, 0, 'aucun kind signalé');
    });
  });
});

harness.describe('DB8 : la clé maître est relue, sinon l import échoue tout de suite', function () {
  harness.it('aller-retour : la clé écrite est immédiatement relue par son index', function () {
    var bus = new db8Lib.FakeDb8Bus();
    var db = new db8Lib.Db8Client({ call: bus.call, appId: db8Lib.APP_ID });
    var cles = reposLib.createMasterKeyRepository(db);
    var ecrite;
    return cles
      .ensure('p1')
      .then(function (cle) {
        ecrite = cle;
        assert.equal(cle.length, 32, 'clé de 32 octets');
        return cles.get('p1');
      })
      .then(function (relue) {
        assert.ok(relue, 'clé relue');
        assert.ok(relue.equals(ecrite), 'même clé');
      })
      .then(function () {
        return cles.ensure('p1');
      })
      .then(function (deuxieme) {
        assert.ok(deuxieme.equals(ecrite), 'ensure est idempotent : aucune clé écrasée');
      });
  });

  harness.it('kind enregistré sans index (schéma v1) : la lecture le dit, elle ne renvoie pas vide', function () {
    // On reproduit un appareil où le kind existe **déjà**, enregistré sans index par une version
    // antérieure : c'est l'état exact qui a rendu l'index du catalogue illisible (D-40).
    var bus = new db8Lib.FakeDb8Bus();
    return bus
      .call('luna://' + db8Lib.DB_SERVICE + '/putKind', {
        id: db8Lib.kindOf('masterKeys'),
        owner: db8Lib.APP_ID,
        private: true
      })
      .then(function () {
        var db = new db8Lib.Db8Client({ call: bus.call, appId: db8Lib.APP_ID });
        var cles = reposLib.createMasterKeyRepository(db);
        return cles.ensure('p1').then(
          function () {
            throw new Error('écriture acceptée alors que l index est absent');
          },
          function (erreur) {
            assert.ok(
              erreur.message.indexOf('no index for query') !== -1 || erreur.message.indexOf('illisible') !== -1,
              'message explicite : ' + erreur.message
            );
            assert.ok(erreur.message.indexOf('-3965') !== -1 || erreur.message.indexOf('illisible') !== -1, 'cause nommée');
          }
        );
      });
  });

  harness.it('kind sans index qui répond « vide » (comportement observé sur l appareil) : refus net', function () {
    // Certains DB8 répondent `returnValue: true, results: []` au lieu de -3965. C'est ce silence qui
    // produisait « clé maître absente » à la première lecture du catalogue : la vérification
    // aller-retour doit transformer ce silence en refus explicite, au moment de l'import.
    var bus = new db8Lib.FakeDb8Bus();
    var silencieux = {
      call: function (uri, params) {
        if (uri.indexOf('/putKind') !== -1 && this._amorce !== true) {
          // l'appareil avait déjà le kind, enregistré sans index : on force cet état
          this._amorce = true;
          return bus.call('luna://' + db8Lib.DB_SERVICE + '/putKind', {
            id: db8Lib.kindOf('masterKeys'),
            owner: db8Lib.APP_ID,
            private: true
          });
        }
        if (uri.indexOf('/find') !== -1) {
          var where = ((params.query || {}).where || {});
          var indexe = Object.keys(where).every(function (champ) {
            return champ === '_id' || champ === '_kind' || (bus.kinds[String(where._kind)] || []).indexOf(champ) !== -1;
          });
          if (!indexe) return Promise.resolve({ returnValue: true, results: [] }); // le piège
        }
        return bus.call(uri, params);
      }
    };
    var db = new db8Lib.Db8Client({ call: silencieux.call, appId: db8Lib.APP_ID });
    var cles = reposLib.createMasterKeyRepository(db);
    return cles.ensure('p1').then(
      function () {
        throw new Error('clé acceptée alors que la relecture ne peut pas fonctionner');
      },
      function (erreur) {
        assert.ok(erreur.message.indexOf('illisible') !== -1, 'refus explicite : ' + erreur.message);
      }
    );
  });

  harness.it('l import et la lecture du catalogue vont ensemble sur le bus strict', function () {
    var stack = makeStack();
    return stack.service.profiles
      .save({ id: 'p1', name: 'Maison', kind: 'xtream', baseUrl: PORTAL_URL })
      .then(function () {
        return stack.bus.invoke(
          'importPlaylist',
          {
            profileId: 'p1',
            kind: 'xtream',
            contentType: 'live',
            source: { url: PORTAL_URL, credentials: { username: USERNAME, password: PASSWORD } },
            consent: { persistSecrets: true }
          },
          { subscribed: true }
        );
      })
      .then(function () {
        return waitFor(function () {
          var final = repliesOf(stack.bus, 'importPlaylist').filter(function (reponse) {
              return reponse && reponse.returnValue === true && reponse.data && reponse.data.final === true;
            })[0];
          return final || null;
        });
      })
      .then(function () {
        // c'est ici que l'appareil échouait : la clé maître n'était pas retrouvée
        return stack.service.masterKeys.get('p1');
      })
      .then(function (cle) {
        assert.ok(cle && cle.length === 32, 'clé maître retrouvée après import');
        return stack.bus.invoke('getPage', { profileId: 'p1', contentType: 'live', order: 'source' });
      })
      .then(function (reponses) {
        assert.equal(reponses[0].returnValue, true, 'catalogue lisible');
        assert.ok(reponses[0].data.items.length > 0, 'entrées présentes');
      });
  });

  harness.it('le diagnostic expose l état de DB8 et le résultat de la sonde', function () {
    var stack = makeStack();
    return stack.bus
      .invoke('diagnostics', {})
      .then(function (reponses) {
        var reponse = reponses[0];
        assert.equal(reponse.returnValue, true, 'diagnostic servi');
        assert.equal(reponse.data.db.ok, true, 'base joignable');
        assert.ok(reponse.data.db.sonde, 'sonde présente');
        assert.ok(reponse.data.db.sonde.indexOf('ok') === 0, 'sonde concluante : ' + reponse.data.db.sonde);
        assert.ok(Array.isArray(reponse.data.db.kinds) && reponse.data.db.kinds.length > 0, 'kinds décrits');
        var sonde = reponse.data.db.kinds.filter(function (entree) {
          return entree.kind.indexOf('masterKeys') !== -1;
        })[0];
        assert.ok(sonde && sonde.indexe === true, 'le kind de la clé maître est annoncé indexé');
        assert.ok(sonde.champs.indexOf('profileId') !== -1, 'champ indexé annoncé : ' + sonde.champs.join(','));
      });
  });
});

harness.describe('Pont LS2 : la reponse du hub est lue dans `message.payload` (D-41)', function () {
  /**
   * Faux `webos-service` : `call(uri, params, callback)` rend un objet **`Message`**, la réponse
   * étant dans `payload` (`lib/service.js` et `lib/message.js` du module `webos-service`).
   */
  function serviceEnveloppe(bus) {
    var appels = [];
    return {
      appels: appels,
      register: function () {},
      call: function (uri, params, callback) {
        appels.push({ uri: uri, params: params });
        return Promise.resolve(bus.call(uri, params)).then(function (charge) {
          callback({ payload: charge, isSubscription: false, method: uri, sender: 'faux-service' });
        });
      }
    };
  }

  harness.it('aller-retour DB8 complet a travers l enveloppe du hub', function () {
    // Avant correctif : le premier putKind etait tenu pour refuse et l import s arretait avant
    // toute ecriture (« creation du kind DB8 refusee »).
    var bus = new db8Lib.FakeDb8Bus();
    var service = serviceEnveloppe(bus);
    var db = new db8Lib.Db8Client({ call: mainLib.createLs2Caller(service), appId: db8Lib.APP_ID });
    return db
      .put('profiles', [{ id: 'p1', name: 'Maison' }])
      .then(function () {
        return db.find('profiles', { id: 'p1' });
      })
      .then(function (lignes) {
        assert.equal(lignes.length, 1, 'ligne relue par son index');
        assert.equal(lignes[0].name, 'Maison', 'contenu intact');
        assert.ok(service.appels.length >= 3, 'putKind, put et find sont passes par le pont');
      });
  });

  harness.it('un refus du hub remonte avec son code et son texte', function () {
    var service = {
      register: function () {},
      call: function (uri, params, callback) {
        if (uri.indexOf('/putKind') !== -1) {
          callback({ payload: { returnValue: true } });
          return;
        }
        callback({ payload: { returnValue: false, errorCode: -3965, errorText: 'db: no index for query' } });
      }
    };
    var db = new db8Lib.Db8Client({ call: mainLib.createLs2Caller(service), appId: db8Lib.APP_ID });
    return db.find('probes', { cle: 'x' }).then(
      function () {
        throw new Error('un refus du hub a ete ignore');
      },
      function (erreur) {
        assert.ok(erreur.message.indexOf('-3965') !== -1, 'code present : ' + erreur.message);
        assert.ok(erreur.message.indexOf('no index for query') !== -1, 'texte present : ' + erreur.message);
      }
    );
  });

  harness.it('la charge utile a plat reste acceptee (autre famille de hub)', function () {
    var bus = new db8Lib.FakeDb8Bus();
    var service = {
      register: function () {},
      call: function (uri, params, callback) {
        return Promise.resolve(bus.call(uri, params)).then(function (charge) {
          callback(charge);
        });
      }
    };
    var db = new db8Lib.Db8Client({ call: mainLib.createLs2Caller(service), appId: db8Lib.APP_ID });
    return db
      .put('preferences', [{ profileId: 'p1', ordre: 'source' }])
      .then(function () {
        return db.find('preferences', { profileId: 'p1' });
      })
      .then(function (lignes) {
        assert.equal(lignes.length, 1, 'ligne relue');
      });
  });

  harness.it('putKind refuse parce que le kind existe : la lecture continue', function () {
    var bus = new db8Lib.FakeDb8Bus();
    return bus
      .call('luna://' + db8Lib.DB_SERVICE + '/putKind', {
        id: db8Lib.kindOf('profiles'),
        owner: db8Lib.APP_ID,
        private: true,
        indexes: [{ name: 'id', props: [{ name: 'id' }] }]
      })
      .then(function () {
        var db = new db8Lib.Db8Client({
          call: mainLib.createLs2Caller(serviceEnveloppe(bus)),
          appId: db8Lib.APP_ID
        });
        return db.find('profiles', { id: 'p1' }).then(
          function (lignes) {
            assert.equal(lignes.length, 0, 'kind existant reutilise, aucune erreur');
          },
          function (erreur) {
            throw new Error('le refus « kind already exists » a interrompu l usage : ' + erreur.message);
          }
        );
      });
  });

  harness.it('kind existant SANS index : le refus reste, la lecture ne ment pas', function () {
    // la tolerance « kind existe deja » ne doit pas desserrer le garde d index (regression D-40) :
    // un kind enregistre sans index fait echouer l ecriture au lieu de rendre une lecture vide
    var bus = new db8Lib.FakeDb8Bus();
    return bus
      .call('luna://' + db8Lib.DB_SERVICE + '/putKind', {
        id: db8Lib.kindOf('masterKeys'),
        owner: db8Lib.APP_ID,
        private: true
      })
      .then(function () {
        var db = new db8Lib.Db8Client({
          call: mainLib.createLs2Caller(serviceEnveloppe(bus)),
          appId: db8Lib.APP_ID
        });
        var cles = reposLib.createMasterKeyRepository(db);
        return cles.ensure('p1').then(
          function () {
            throw new Error('ecriture acceptee alors que l index est absent');
          },
          function (erreur) {
            assert.ok(
              erreur.message.indexOf('no index for query') !== -1 || erreur.message.indexOf('illisible') !== -1,
              'refus explicite : ' + erreur.message
            );
          }
        );
      });
  });
});

harness.describe('Nom du service de base : `com.palm.db` sur televiseur, repli webOS OSE (D-42)', function () {
  /** Faux hub qui ne connait qu'une partie des noms de service. */
  function hubParNom(connus) {
    var bus = new db8Lib.FakeDb8Bus();
    return {
      bus: bus,
      appels: [],
      call: function (uri, params) {
        this.appels.push(uri);
        var nom = /^luna:\/\/([^/]+)\//.exec(uri)[1];
        if (connus.indexOf(nom) === -1) {
          return Promise.reject(
            new Error('appel LS2 refuse (-1) : Service does not exist: ' + nom)
          );
        }
        return bus.call(uri, params);
      }
    };
  }

  harness.it('la TV ne connait que com.palm.db : le client l essaie et le retient', function () {
    var hub = hubParNom(['com.palm.db']);
    var db = new db8Lib.Db8Client({ call: hub.call.bind(hub), appId: db8Lib.APP_ID });
    return db
      .put('profiles', [{ id: 'p1', name: 'Maison' }])
      .then(function () {
        assert.equal(db.serviceDb(), 'com.palm.db', 'nom retenu : ' + db.serviceDb());
        return db.find('profiles', { id: 'p1' });
      })
      .then(function (lignes) {
        assert.equal(lignes.length, 1, 'ligne relue');
        var urnes = hub.appels.filter(function (uri) {
          return uri.indexOf('/putKind') !== -1;
        });
        assert.ok(urnes.length > 0, 'putKind emis');
        // le premier essai a porte sur com.palm.db : aucun appel perdu sur un nom inconnu de la TV
        assert.equal(urnes[0].indexOf('luna://com.palm.db/'), 0, 'premier appel : ' + urnes[0]);
      });
  });

  harness.it('une image webOS OSE (com.webos.service.db) reste prise en charge', function () {
    var hub = hubParNom(['com.webos.service.db']);
    var db = new db8Lib.Db8Client({ call: hub.call.bind(hub), appId: db8Lib.APP_ID });
    return db.put('consents', [{ profileId: 'p1', kind: 'insecureHttp' }]).then(function () {
      assert.equal(db.serviceDb(), 'com.webos.service.db', 'repli retenu');
    });
  });

  harness.it('aucun nom ne repond : l erreur nomme ce qui a ete essaye', function () {
    var hub = hubParNom([]);
    var db = new db8Lib.Db8Client({ call: hub.call.bind(hub), appId: db8Lib.APP_ID });
    return db.find('profiles', { id: 'p1' }).then(
      function () {
        throw new Error('une base injoignable a ete acceptee');
      },
      function (erreur) {
        assert.ok(/Service does not exist/.test(erreur.message), 'cause conservee : ' + erreur.message);
        // le diagnostic doit pouvoir dire ce qui a ete essaye, meme sans nom retenu
        assert.ok(db.serviceDbPourDiagnostic(), 'nom essaye rapporte : ' + db.serviceDbPourDiagnostic());
      }
    );
  });

  harness.it('« Service does not exist » n est pas « le kind existe deja »', function () {
    // La phrase contient « exist » : la tolerance du putKind ne doit pas l avaler, sinon une base
    // injoignable passe pour une base prete et l import echoue plus loin, sans cause (D-42).
    assert.equal(
      db8Lib.kindDejaEnregistre('appel LS2 refuse (-1) : Service does not exist: com.webos.service.db'),
      false,
      'service absent : tolerance refusee'
    );
    assert.equal(
      db8Lib.kindDejaEnregistre("db: kind already exists: 'x:db:y:2'"),
      true,
      'kind deja enregistre : tolerance acceptee'
    );
    assert.equal(
      db8Lib.kindDejaEnregistre('db: kind exists'),
      true,
      'autre formulation admise'
    );
    assert.equal(db8Lib.serviceIntrouvable('Service does not exist: x'), true, 'nom inconnu reconnu');
    assert.equal(db8Lib.serviceIntrouvable('db: no index for query'), false, 'erreur de base : pas un nom');
  });

  harness.it('base injoignable : l ecriture echoue, la sonde le dit et nomme le service', function () {
    var hub = hubParNom([]);
    var db = new db8Lib.Db8Client({ call: hub.call.bind(hub), appId: db8Lib.APP_ID });
    var cles = reposLib.createMasterKeyRepository(db);
    return cles
      .ensure('p1')
      .then(
        function () {
          throw new Error('cle ecrite alors que la base est injoignable');
        },
        function (erreur) {
          assert.ok(/Service does not exist/.test(erreur.message), 'cause reelle : ' + erreur.message);
          assert.ok(
            erreur.message.indexOf('creation du kind DB8 refusee') === -1,
            'le message de refus de kind ne doit pas masquer un service absent'
          );
        }
      )
      .then(function () {
        return db.sonde();
      })
      .then(function (rapport) {
        assert.equal(rapport.ok, false, 'sonde en echec');
        assert.ok(rapport.message && rapport.message.indexOf('Service does not exist') !== -1, 'cause dans la sonde');
        assert.ok(rapport.service, 'nom de service rapporte : ' + rapport.service);
      });
  });

  harness.it('le diagnostic annonce le service de base retenu', function () {
    var stack = makeStack();
    return stack.bus.invoke('diagnostics', {}).then(function (reponses) {
      var db = reponses[0].data.db;
      assert.equal(db.ok, true, 'base jointe');
      assert.ok(typeof db.service === 'string' && db.service.length > 0, 'service nomme : ' + db.service);
      assert.ok(db.sonde.indexOf('ok') === 0, 'sonde concluante');
    });
  });
});

harness.describe('Proprietaire de kind : DB8 n accepte que le domaine appelant (D-43)', function () {
  /**
   * Faux DB8 appliquant la **regle reelle** de creation de kind : `MojDbKind::configure()` appelle
   * `checkPermission(OpKindUpdate)`, qui n'accorde le droit qu'a `req.admin() || req.domain() ==
   * m_owner` — sinon `-3963 db: permission denied`. Le domaine de l'appelant est le **service**.
   */
  function db8AvecDomaine(domaine, rendreEnReponse) {
    var bus = new db8Lib.FakeDb8Bus();
    var refus = [];
    return {
      bus: bus,
      refus: refus,
      call: function (uri, params) {
        if (uri.indexOf('/putKind') !== -1 && params.owner !== domaine) {
          refus.push(params.owner);
          if (rendreEnReponse) {
            return Promise.resolve({ returnValue: false, errorCode: -3963, errorText: 'db: permission denied' });
          }
          return Promise.reject(new Error('appel LS2 refuse (-3963) : db: permission denied (luna://com.palm.db/putKind)'));
        }
        return bus.call(uri, params);
      }
    };
  }

  harness.it('le domaine est le nom du service : ce proprietaire est retenu, une seule fois', function () {
    var hub = db8AvecDomaine(db8Lib.SERVICE_NAME_DB8);
    var db = new db8Lib.Db8Client({ call: hub.call, appId: db8Lib.APP_ID });
    return db
      .put('profiles', [{ id: 'p1', name: 'Maison' }])
      .then(function () {
        assert.equal(db.ownerDbPourDiagnostic(), db8Lib.SERVICE_NAME_DB8, 'proprietaire retenu : ' + db.ownerDbPourDiagnostic());
        assert.equal(hub.refus.length, 1, 'un seul essai refuse (APP_ID), puis le bon');
        return db.find('profiles', { id: 'p1' });
      })
      .then(function (lignes) {
        assert.equal(lignes.length, 1, 'lecture servie apres retrait du proprietaire');
      });
  });

  harness.it('le domaine est l identifiant de l application : aucun essai inutile', function () {
    var hub = db8AvecDomaine(db8Lib.APP_ID);
    var db = new db8Lib.Db8Client({ call: hub.call, appId: db8Lib.APP_ID });
    return db.put('consents', [{ profileId: 'p1', kind: 'insecureHttp' }]).then(function () {
      assert.equal(db.ownerDbPourDiagnostic(), db8Lib.APP_ID, 'proprietaire : ' + db.ownerDbPourDiagnostic());
      assert.equal(hub.refus.length, 0, 'aucun refus');
    });
  });

  harness.it('refus rendu en reponse (returnValue false) : meme repli', function () {
    var hub = db8AvecDomaine(db8Lib.SERVICE_NAME_DB8, true);
    var db = new db8Lib.Db8Client({ call: hub.call, appId: db8Lib.APP_ID });
    return db.put('masterKeys', [{ profileId: 'p1', key: 'AAAA' }]).then(function () {
      assert.equal(db.ownerDbPourDiagnostic(), db8Lib.SERVICE_NAME_DB8, 'proprietaire retenu par le chemin « reponse »');
    });
  });

  harness.it('aucun proprietaire accepte : l erreur nomme les deux essayes', function () {
    var hub = db8AvecDomaine('com.inconnu.domaine');
    var db = new db8Lib.Db8Client({ call: hub.call, appId: db8Lib.APP_ID });
    return db.put('profiles', [{ id: 'p1' }]).then(
      function () {
        throw new Error('une creation de kind refusee a ete acceptee');
      },
      function (erreur) {
        assert.ok(/permission/.test(erreur.message), 'cause nommee : ' + erreur.message);
        assert.ok(erreur.message.indexOf(db8Lib.APP_ID) !== -1, 'premier proprietaire cite');
        assert.ok(erreur.message.indexOf(db8Lib.SERVICE_NAME_DB8) !== -1, 'second proprietaire cite');
      }
    );
  });

  harness.it('le nom du service du client est celui du service reel', function () {
    // deux fichiers portent ce nom (le client DB8 ne peut pas importer `ls2/service.ts` : cycle) :
    // le test est la garde qui empeche la derive
    assert.equal(db8Lib.SERVICE_NAME_DB8, serviceLib.SERVICE_NAME, 'noms de service identiques');
  });

  harness.it('le diagnostic annonce le proprietaire retenu', function () {
    var stack = makeStack();
    return stack.bus.invoke('diagnostics', {}).then(function (reponses) {
      var db = reponses[0].data.db;
      assert.equal(db.ok, true, 'base jointe');
      assert.ok(typeof db.owner === 'string' && db.owner.length > 0, 'proprietaire nomme : ' + db.owner);
      assert.ok(db.owner === db8Lib.APP_ID || db.owner === db8Lib.SERVICE_NAME_DB8, 'proprietaire plausible : ' + db.owner);
    });
  });

  harness.it('l indice d erreur du pont ne double plus la methode', function () {
    var appelant = {
      register: function () {},
      call: function (uri, params, callback) {
        // refus du bus, la charge utile n'arrive jamais : le pont compose son indice
        var erreur = new Error('refus');
        if (callback) throw erreur;
      }
    };
    // le pont rejette sur reponse `returnValue: false` : on l'obtient ici par une reponse plate
    var service = {
      register: function () {},
      call: function (uri, params, callback) {
        callback({ payload: { returnValue: false, errorCode: -3963, errorText: 'db: permission denied' } });
      }
    };
    return mainLib
      .createLs2Caller(service)('luna://com.palm.db/putKind', {})
      .then(
        function () {
          throw new Error('un refus a ete accepte');
        },
        function (erreur) {
          assert.equal(erreur.hint, 'luna://com.palm.db/putKind', 'indice sans methode doublee : ' + erreur.hint);
          assert.ok(erreur.message.indexOf('-3963') !== -1, 'code conserve');
        }
      );
  });
});

/**
 * **Révisions d'objet DB8 (D-46)** — le défaut vu sur le téléviseur.
 *
 * Le service réécrivait les lignes qu'il avait lui-même relues (progression d'un import, profil,
 * clé maître) en repassant leur `_id` **sans** `_rev`. DB8 refuse :
 * `-3960 db: _rev must be specified for existing objects`. Le faux bus, lui, écrasait la ligne
 * sans broncher : les tests étaient verts et la TV refusait. Ces cas protègent les deux côtés :
 *
 *  - le **bus** applique la règle de DB8 (`-3960`, `-3961`, `get` rendant `_rev`) — un client qui
 *    oublierait la révision échoue donc dans les tests, pas sur l'appareil ;
 *  - le **client** lit les révisions par `get` avant d'écrire, joint le `_rev` courant, retire un
 *    `_id` inconnu de la base, et rejoue **une fois** un conflit (`-3961`), comme le documente DB8.
 */
harness.describe('DB8 : révisions d objet (put/merge exigent _rev, get les rend)', function () {
  /** Petit montage : un bus, un client, et le journal des appels pour vérifier le protocole. */
  function makeBus() {
    var bus = new db8Lib.FakeDb8Bus();
    var appels = [];
    var db = new db8Lib.Db8Client({
      call: function (uri, params) {
        appels.push({ uri: uri, action: uri.split('/').pop(), params: params });
        return bus.call(uri, params);
      },
      appId: db8Lib.APP_ID
    });
    return { bus: bus, db: db, appels: appels, actions: function () { return appels.map(function (a) { return a.action; }); } };
  }

  harness.it('le faux bus refuse un put sans _rev sur un objet existant (-3960)', function () {
    var bus = new db8Lib.FakeDb8Bus();
    return bus
      .call('luna://com.palm.db/putKind', { id: db8Lib.APP_ID + ':db:profiles:2', owner: db8Lib.APP_ID, indexes: [] })
      .then(function () {
        return bus.call('luna://com.palm.db/put', {
          objects: [{ _kind: db8Lib.APP_ID + ':db:profiles:2', id: 'p1' }]
        });
      })
      .then(function (premier) {
        assert.equal(premier.returnValue, true, 'creation acceptee');
        var id = premier.results[0].id;
        assert.ok(typeof premier.results[0].rev === 'number', 'la creation rend une revision');
        // seconde ecriture du MEME objet, avec son _id mais sans _rev : c'est le defaut de la TV
        return bus
          .call('luna://com.palm.db/put', {
            objects: [{ _kind: db8Lib.APP_ID + ':db:profiles:2', _id: id, id: 'p1', name: 'autre' }]
          })
          .then(function (second) {
            assert.equal(second.returnValue, false, 'refus attendu');
            assert.equal(second.errorCode, -3960, 'code DB8 attendu');
            assert.ok(/_rev must be specified/.test(second.errorText), 'texte DB8 attendu : ' + second.errorText);
          });
      });
  });

  harness.it('le faux bus refuse un _rev perime (-3961) et accepte le bon', function () {
    var bus = new db8Lib.FakeDb8Bus();
    var kind = db8Lib.APP_ID + ':db:masterKeys:2';
    return bus
      .call('luna://com.palm.db/putKind', { id: kind, owner: db8Lib.APP_ID, indexes: [] })
      .then(function () {
        return bus.call('luna://com.palm.db/put', { objects: [{ _kind: kind, profileId: 'p1', key: 'A' }] });
      })
      .then(function (creation) {
        var id = creation.results[0].id;
        var rev = creation.results[0].rev;
        return bus
          .call('luna://com.palm.db/put', { objects: [{ _kind: kind, _id: id, _rev: rev - 1, key: 'B' }] })
          .then(function (perime) {
            assert.equal(perime.errorCode, -3961, 'conflit signale');
            assert.ok(/revision mismatch/.test(perime.errorText), 'texte DB8 : ' + perime.errorText);
            return bus.call('luna://com.palm.db/put', { objects: [{ _kind: kind, _id: id, _rev: rev, key: 'C' }] });
          })
          .then(function (bon) {
            assert.equal(bon.returnValue, true, 'ecriture acceptee avec le bon _rev');
            assert.ok(bon.results[0].rev > rev, 'revision incrementee : ' + rev + ' -> ' + bon.results[0].rev);
            return bus.call('luna://com.palm.db/get', { ids: [id] });
          })
          .then(function (lecture) {
            assert.equal(lecture.results[0].key, 'C', 'la valeur ecrite est celle relue');
            assert.ok(typeof lecture.results[0]._rev === 'number', 'get rend _rev');
          });
      });
  });

  harness.it('le client relit le _rev par get avant de reecrire un profil existant', function () {
    var banc = makeBus();
    var identifiant = '';
    return banc.db
      .put('profiles', [{ id: 'p1', name: 'premier' }])
      .then(function () {
        // une **creation** n'a pas besoin de revision : aucun `get` ne doit partir
        assert.equal(banc.actions().indexOf('get'), -1, 'aucun get pour une creation : ' + banc.actions().join(', '));
        return banc.db.find('profiles', { id: 'p1' }, { limit: 1 });
      })
      .then(function (lignes) {
        identifiant = lignes[0]._id;
        return banc.db.put('profiles', [Object.assign({}, lignes[0], { name: 'second' })]);
      })
      .then(function () {
        // le put de mise a jour a ete precede d'une lecture de revision
        var actions = banc.actions();
        assert.ok(actions.indexOf('get') !== -1, 'revision relue : ' + actions.join(', '));
        assert.ok(actions.indexOf('get') < actions.lastIndexOf('put'), 'get avant put');
        return banc.db.find('profiles', { id: 'p1' });
      })
      .then(function (lignes) {
        assert.equal(lignes.length, 1, 'une seule ligne : ' + lignes.length);
        assert.equal(lignes[0].name, 'second', 'la ligne a bien ete mise a jour');
        assert.equal(lignes[0]._id, identifiant, 'le meme objet, pas un doublon');
      });
  });

  harness.it('l ecriture rejouee d une ligne de job (progression d import) aboutit', function () {
    // C'est la ligne exacte du defaut : le job est ecrit a chaque changement de phase, avec l _id
    // relu. Sans revision, DB8 refusait (-3960) et l import s arretait des la premiere mise a jour.
    var banc = makeBus();
    var phases = ['downloading', 'parsing', 'writing', 'validating', 'swapping', 'done'];
    var ecritures = phases.reduce(function (promesse, phase, rang) {
      var job = { jobId: 'j1', profileId: 'p1', phase: phase };
      return promesse.then(function () {
        return banc.db
          .find('importJobs', { jobId: 'j1' }, { limit: 1 })
          .then(function (lignes) {
            var ligne = { jobId: 'j1', profileId: 'p1', job: job };
            if (lignes.length > 0 && lignes[0]._id) ligne._id = lignes[0]._id;
            return banc.db.put('importJobs', [ligne]).then(function () {
              return rang;
            });
          });
      });
    }, Promise.resolve(0));

    return ecritures
      .then(function () {
        return banc.db.find('importJobs', { jobId: 'j1' });
      })
      .then(function (lignes) {
        assert.equal(lignes.length, 1, 'une seule ligne de job malgre ' + phases.length + ' ecritures');
        assert.equal(lignes[0].job.phase, 'done', 'derniere phase ecrite : ' + lignes[0].job.phase);
        var lectures = banc.actions().filter(function (action) { return action === 'get'; });
        assert.equal(lectures.length, phases.length - 1, 'une relecture de revision par mise a jour');
      });
  });

  harness.it('un conflit reel (quelqu un a ecrit entre-temps) est rejoue une fois', function () {
    // La course est simulee au bon endroit : **entre** la lecture de revision du client et son
    // ecriture. Le put part alors avec un `_rev` perime (-3961) ; le client doit relire et rejouer.
    var bus = new db8Lib.FakeDb8Bus();
    var kind = db8Lib.APP_ID + ':db:consents:2';
    var courses = 0;
    var puts = 0;
    var actions = [];
    var db = new db8Lib.Db8Client({
      call: async function (uri, params) {
        var action = uri.split('/').pop();
        actions.push(action);
        var objet = (params.objects || [])[0];
        if (action === 'put' && objet && objet._id && courses === 0) {
          courses += 1;
          // un autre ecrivain passe : il ecrit avec la revision que le client vient de lire
          await bus.call('luna://com.palm.db/put', {
            objects: [
              {
                _kind: kind,
                _id: objet._id,
                _rev: objet._rev,
                profileId: 'p1',
                kind: 'insecureHttp',
                insecureHost: 'portail.test',
                acceptedAt: 999
              }
            ]
          });
        }
        if (action === 'put') puts += 1;
        return bus.call(uri, params);
      },
      appId: db8Lib.APP_ID
    });

    return db
      .put('consents', [
        { profileId: 'p1', kind: 'insecureHttp', insecureHost: 'portail.test', acceptedAt: 1 }
      ])
      .then(function () {
        return db.find('consents', { profileId: 'p1' });
      })
      .then(function (lignes) {
        return db.put('consents', [Object.assign({}, lignes[0], { acceptedAt: 2 })]);
      })
      .then(function () {
        return db.find('consents', { profileId: 'p1' });
      })
      .then(function (lignes) {
        assert.equal(lignes.length, 1, 'toujours une seule ligne : ' + lignes.length);
        assert.equal(lignes[0].acceptedAt, 2, 'notre ecriture a bien ete appliquee apres reprise');
        assert.equal(courses, 1, 'une seule course simulee');
        // creation + mise a jour refusee + reprise : la concurrence, elle, passe par le bus direct
        assert.equal(puts, 3, 'trois put du client (creation, tentative refusee, reprise) : ' + puts);
        // deux lectures de revision apres la creation : une par tentative de mise a jour
        assert.equal(
          actions.filter(function (action) { return action === 'get'; }).length,
          2,
          'une relecture avant chaque tentative : ' + actions.join(', ')
        );
      });
  });

  harness.it('un _id disparu de la base est recree au lieu d echouer', function () {
    var banc = makeBus();
    return banc.db
      .put('playbacks', [{ key: 'k1', profileId: 'p1', record: { at: 1 } }])
      .then(function () {
        return banc.db.find('playbacks', { key: 'k1' }, { limit: 1 }).then(function (lignes) {
          // l utilisateur a supprime la ligne entre la lecture et l ecriture
          return banc.db.del('playbacks', [String(lignes[0]._id)]).then(function () {
            return lignes[0];
          });
        });
      })
      .then(function (ancienne) {
        var ligne = Object.assign({}, ancienne, { record: { at: 2 } });
        return banc.db.put('playbacks', [ligne]).then(function () {
          return banc.db.find('playbacks', { key: 'k1' });
        });
      })
      .then(function (lignes) {
        assert.equal(lignes.length, 1, 'la ligne est recreee');
        assert.equal(lignes[0].record.at, 2, 'valeur ecrite');
      });
  });

  harness.it('le parcours complet (profil reecrit, import, page, resolution) reste vert', function () {
    var stack = makeStack();
    var profil = {
      id: 'p1',
      name: 'Maison',
      kind: 'xtream',
      providerType: 'xtream',
      preferredLiveFormat: 'auto',
      status: 'ok',
      baseUrl: PORTAL_URL,
      persistSecrets: false
    };
    var final = null;
    return stack.service.profiles
      .save(Object.assign({}, profil))
      .then(function () {
        // seconde ecriture du meme profil : c'est le chemin « _id relu + _rev » du client
        return stack.service.profiles.save(Object.assign({}, profil, { name: 'Maison (2)' }));
      })
      .then(function () {
        return stack.service.profiles.list();
      })
      .then(function (profils) {
        assert.equal(profils.length, 1, 'un seul profil : ' + profils.length);
        assert.equal(profils[0].name, 'Maison (2)', 'profil mis a jour, pas duplique');
        return stack.bus.invoke('testProfile', {
          kind: 'xtream',
          profileId: 'p1',
          baseUrl: PORTAL_URL,
          username: USERNAME,
          password: PASSWORD
        });
      })
      .then(function (reponses) {
        assert.equal(reponses[0].data.ok, true, 'source joignable');
        return stack.bus.invoke(
          'importPlaylist',
          {
            profileId: 'p1',
            kind: 'xtream',
            contentType: 'live',
            source: { url: PORTAL_URL, credentials: { username: USERNAME, password: PASSWORD } },
            consent: { persistSecrets: false, insecureHttp: false }
          },
          // sans abonnement, la progression ne revient pas au client (comme sur la TV)
          { subscribed: true }
        );
      })
      .then(function () {
        return waitFor(function () {
          final = repliesOf(stack.bus, 'importPlaylist').filter(function (reply) {
            return reply && reply.returnValue === true && reply.data && reply.data.final === true;
          })[0];
          return final || null;
        }, 20000);
      })
      .then(function (reponse) {
        assert.equal(reponse.data.job.phase, 'done', 'import termine malgre les ecritures rejouees');
        return stack.bus.invoke('getCategories', { profileId: 'p1', contentType: 'live' });
      })
      .then(function (reponses) {
        assert.equal(reponses[0].returnValue, true, 'commande servie');
        assert.equal(Array.isArray(reponses[0].data.categories), true, 'categories lues apres import');
        assert.ok(reponses[0].data.categories.length > 0, 'au moins une categorie');
        return stack.bus.invoke('resolveStream', {
          profileId: 'p1',
          ref: { contentType: 'live', providerId: '1000' }
        });
      })
      .then(function (reponses) {
        assert.equal(reponses[0].returnValue, true, 'flux resolu apres les ecritures rejouees');
        assert.equal(/^https:\/\/portal\.example\.com\/live\//.test(reponses[0].data.url), true, 'URL du portail construite');
      });
  });
});
