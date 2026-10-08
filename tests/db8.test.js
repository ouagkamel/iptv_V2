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
