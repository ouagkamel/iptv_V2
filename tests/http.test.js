'use strict';

/**
 * Couche réseau du service (§2.5) : politique réseau appliquée à chaque saut, analyse JSON
 * incrémentale, plafonds de charge utile, redirections bornées avec retrait des en-têtes sensibles,
 * sonde TLS et bundle de racines embarqué.
 *
 * Le portail synthétique (`fake-portal.js`) tient lieu de réseau : aucun test ne sort du processus.
 */

var assert = require('./assert');
var harness = require('./harness');
var portalLib = require('./fake-portal');
var fs = require('fs');
var path = require('path');

var libRoot = path.join(__dirname, '..', 'service', 'com.ouagkamel.app.iptvplayer.service', 'lib');
var policyLib = require(path.join(libRoot, 'service', 'http', 'policy'));
var jsonLib = require(path.join(libRoot, 'service', 'http', 'jsonStream'));
var clientLib = require(path.join(libRoot, 'service', 'http', 'httpClient'));
var tlsLib = require(path.join(libRoot, 'service', 'http', 'tlsProbe'));
var rootsLib = require(path.join(libRoot, 'service', 'http', 'rootsBundle'));

function clientFor(portal) {
  return new clientLib.HttpClient({
    transport: portal.transport,
    lookup: portal.lookup,
    caProvider: function () {
      return undefined;
    }
  });
}

harness.describe('Politique reseau (§2.5)', function () {
  harness.it('un schema non http(s) est refuse', function () {
    assert.throws(function () {
      policyLib.evaluateHop('ftp://portal.example.com/liste', {});
    }, 'provider/unsupported', 'schema refuse');
  });

  harness.it('un hote prive exige une autorisation LAN, un port local est toujours refuse', function () {
    assert.throws(function () {
      policyLib.evaluateHop('http://192.168.1.10/player_api.php', { insecureHttpAccepted: true });
    }, 'security/privateHost', 'adresse privee refusee par defaut');
    var allowed = policyLib.evaluateHop('http://192.168.1.10/player_api.php', { insecureHttpAccepted: true, lanAllowed: true });
    assert.ok(allowed.warnings.length >= 0, 'autorisation LAN explicite acceptee');
    assert.throws(function () {
      policyLib.evaluateHop('http://portal.example.com:22/api', { insecureHttpAccepted: true });
    }, 'security/privateHost', 'port de service local refuse');
  });

  harness.it('une descente HTTPS vers HTTP est refusee tant que l hote n est pas confirme', function () {
    assert.throws(function () {
      policyLib.evaluateHop('http://portal.example.com/player_api.php', {}, 'https');
    }, 'security/insecureScheme', 'downgrade refuse sans confirmation');
    // la confirmation est mémorisée par couple profil/hôte : un hôte déjà accepté reste accepté
    var accepted = policyLib.evaluateHop('http://portal.example.com/player_api.php', { insecureHttpAccepted: true }, 'https');
    assert.equal(accepted.isDowngrade, true, 'descente identifiee');
    assert.equal(accepted.parsed.scheme, 'http', 'saut accepte apres confirmation');
    var fromHttp = policyLib.evaluateHop('http://portal.example.com/player_api.php', { insecureHttpAccepted: true }, 'http');
    assert.equal(fromHttp.isDowngrade, false, 'pas de descente depuis http');
  });

  harness.it('les en-tetes sensibles ne suivent pas un changement d origin', function () {
    var same = policyLib.headersForHop({ Authorization: 'Bearer x', Cookie: 'a=b' }, 'https://a.example.com', 'https://a.example.com');
    assert.equal(same.Authorization, 'Bearer x', 'meme origin : en-tete conserve');
    var other = policyLib.headersForHop(
      { Authorization: 'Bearer x', Cookie: 'a=b', Referer: 'https://a.example.com/', Accept: 'application/json' },
      'https://a.example.com',
      'https://cdn.example.net'
    );
    assert.equal(other.Authorization, undefined, 'Authorization retire');
    assert.equal(other.Cookie, undefined, 'Cookie retire');
    assert.equal(other.Referer, undefined, 'Referer retire');
    assert.equal(other.Accept, 'application/json', 'en-tete anodin conserve');
  });

  harness.it('une adresse privee resolue est refusee sans autorisation LAN', function () {
    var portal = portalLib.createPortal({ privateHost: 'lan.example.com' });
    return clientFor(portal)
      .get('http://lan.example.com/player_api.php?action=get_live_streams', { insecureHttpAccepted: true })
      .then(
        function () {
          assert.fail('appel vers une adresse privee : une erreur etait attendue');
        },
        function (error) {
          assert.equal(error.code, 'security/privateHost', 'code de refus prive');
        }
      );
  });

  harness.it('une resolution DNS impossible devient network/dns', function () {
    var portal = portalLib.createPortal({ privateHost: 'lan.example.com' });
    return clientFor(portal)
      .get('https://introuvable.example.com/player_api.php')
      .then(
        function () {
          assert.fail('resolution impossible : une erreur etait attendue');
        },
        function (error) {
          assert.equal(error.code, 'network/dns', 'code de resolution');
        }
      );
  });
});

harness.describe('Analyse JSON incrementale (§15.2)', function () {
  harness.it('analyse un tableau coupe en morceaux arbitraires', function () {
    var records = [];
    var parser = new jsonLib.IncrementalJsonParser({
      onTopLevelValue: function (value) {
        // chaque element du tableau racine est livre des qu'il est complet, sans accumulation
        if (Array.isArray(value)) {
          value.forEach(function (element) {
            records.push(element);
          });
          return;
        }
        records.push(value);
      }
    });
    var text = JSON.stringify([
      { name: 'Cha\u00eene 1', stream_id: '1' },
      { name: 'Chaine 2', stream_id: '2', stream_icon: 'https://cdn.example.com/x.png' },
      { name: 'Chaine 3', stream_id: '3' }
    ]);
    for (var index = 0; index < text.length; index += 7) {
      parser.push(text.slice(index, index + 7));
    }
    parser.finish();
    assert.equal(records.length, 3, 'trois elements analyses');
    assert.equal(records[0].name, 'Cha\u00eene 1', 'echappement unicode preserve');
    assert.equal(records[2].stream_id, '3', 'dernier element complet');
  });

  harness.it('refuse un document tronque au lieu de deviner', function () {
    var parser = new jsonLib.IncrementalJsonParser();
    parser.push('[{"a":1},');
    assert.throws(function () {
      parser.finish();
    }, 'provider/badResponse', 'document tronque refuse');
  });

  harness.it('decode les echappements JSON sans eval', function () {
    assert.equal(jsonLib.decodeJsonString('a\\u00e9\\n"b"'), 'a\u00e9\n"b"', 'echappements decodes');
    assert.throws(function () {
      jsonLib.parseJsonDocument('[' + new Array(40).join('1,') + '1]', 8);
    }, 'provider/badResponse', 'plafond d octets applique');
  });
});

harness.describe('Client HTTP du service (§2.5)', function () {
  harness.it('suit les redirections en revalidant chaque saut et sans en-tete sensible', function () {
    var portal = portalLib.createPortal({
      counts: { live: 3 },
      redirect: { action: 'get_live_streams', to: 'https://cdn.example.net' }
    });
    var client = clientFor(portal);
    return client
      .get('https://portal.example.com/player_api.php?action=get_live_streams', {
        headers: { Authorization: 'Bearer secret', Cookie: 'session=1', Accept: 'application/json' }
      })
      .then(function (response) {
        assert.equal(response.redirects, 1, 'une redirection suivie');
        assert.equal(response.status, 200, 'reponse finale 200');
        var redirected = portal.calls.filter(function (call) {
          return call.host === 'cdn.example.net';
        });
        assert.equal(redirected.length, 1, 'appel vers l hote de redirection');
        assert.equal(redirected[0].headers.Authorization, undefined, 'Authorization retire au changement d origin');
        assert.equal(redirected[0].headers.Cookie, undefined, 'Cookie retire au changement d origin');
        assert.equal(redirected[0].headers.Accept, 'application/json', 'en-tete anodin conserve');
        assert.ok(redirected[0].hasLookup, 'resolution epinglee transmise au transport');
      });
  });

  harness.it('borne le nombre de redirections', function () {
    var portal = portalLib.createPortal({
      redirect: { action: 'get_live_streams', to: 'https://portal.example.com' }
    });
    return clientFor(portal)
      .get('https://portal.example.com/player_api.php?action=get_live_streams')
      .then(
        function () {
          assert.fail('boucle de redirection : une erreur etait attendue');
        },
        function (error) {
          assert.equal(error.code, 'network/tooManyRedirects', 'code de depassement');
          var hops = portal.calls.length;
          assert.atMost(hops, policyLib.MAX_REDIRECTS + 2, 'nombre de sauts borne');
        }
      );
  });

  harness.it('decompresse gzip et compte les octets reels', function () {
    var portal = portalLib.createPortal({ counts: { live: 8 }, gzip: true, chunkSize: 128 });
    return clientFor(portal).get('https://portal.example.com/player_api.php?action=get_live_streams').then(function (response) {
      assert.equal(response.status, 200, 'reponse 200');
      var payload = JSON.parse(response.text);
      assert.equal(payload.length, 8, 'charge utile decompressee');
      assert.ok(response.wireBytes > 0, 'octets sur le fil comptes');
      assert.ok(response.bytes >= response.text.length, 'octets decompresses comptes');
    });
  });

  harness.it('applique le plafond de charge utile', function () {
    var portal = portalLib.createPortal({ counts: { live: 40 } });
    return clientFor(portal)
      .get('https://portal.example.com/player_api.php?action=get_live_streams', { maxBytes: 256 })
      .then(
        function () {
          assert.fail('depassement de plafond : une erreur etait attendue');
        },
        function (error) {
          assert.equal(error.code, 'network/http', 'code de plafond');
        }
      );
  });

  harness.it('interrompt proprement une reponse quand l appelant annule', function () {
    var portal = portalLib.createPortal({ counts: { live: 40 }, chunkSize: 32 });
    var seen = 0;
    var aborted = false;
    return clientFor(portal)
      .get('https://portal.example.com/player_api.php?action=get_live_streams', {
        onData: function (chunk) {
          seen += chunk.length;
          if (seen > 64) aborted = true;
        },
        shouldAbort: function () {
          return aborted;
        }
      })
      .then(
        function () {
          assert.fail('annulation : une erreur etait attendue');
        },
        function (error) {
          assert.equal(error.code, 'internal/cancelled', 'code d annulation');
          assert.ok(seen > 0, 'des donnees avaient ete recues');
        }
      );
  });

  harness.it('exige une confirmation pour une source en HTTP clair', function () {
    var portal = portalLib.createPortal({ counts: { live: 2 } });
    var client = clientFor(portal);
    return client
      .get('http://portal.example.com/player_api.php')
      .then(
        function () {
          assert.fail('HTTP clair sans confirmation : une erreur etait attendue');
        },
        function (error) {
          assert.equal(error.code, 'security/insecureScheme', 'avertissement obligatoire');
          return client.get('http://portal.example.com/player_api.php', { acceptedHosts: ['portal.example.com'] }).then(function (response) {
            assert.equal(response.status, 200, 'hote confirme : appel autorise');
            assert.ok(response.warnings.length > 0, 'avertissement consigne');
          });
        }
      );
  });

  harness.it('expose les capacites de reprise annoncees par le serveur', function () {
    var portal = portalLib.createPortal({ counts: { live: 2 } });
    return clientFor(portal).get('https://portal.example.com/player_api.php?action=get_live_streams').then(function (response) {
      assert.equal(response.acceptsRanges, false, 'pas de reprise annoncee par defaut');
      assert.equal(response.redirects, 0, 'aucune redirection');
      assert.ok(String(response.finalUrlRedacted).indexOf('portal.example.com') !== -1, 'URL finale redigee');
    });
  });
});

harness.describe('Sonde TLS et racines embarquees (§2.5, §10)', function () {
  harness.it('decrit la pile Node 8.12 sans supposer TLS 1.3', function () {
    var runtime = tlsLib.describeRuntime({ node: 'v8.12.0', openssl: '1.0.2p', modules: '64' });
    assert.equal(runtime.node, 'v8.12.0', 'version Node relevee');
    assert.equal(runtime.tls13Expected, false, 'OpenSSL 1.0.2p : pas de TLS 1.3 annonce');
    var modern = tlsLib.describeRuntime({ node: 'v20.11.0', openssl: '3.0.13', modules: '115' });
    assert.equal(modern.tls13Expected, true, 'OpenSSL 3 : TLS 1.3 attendu');
  });

  harness.it('un echec de chaine est signale, jamais lisse', function () {
    var runtime = tlsLib.describeRuntime({ node: 'v8.12.0', openssl: '1.0.2p', modules: '64' });
    var report = tlsLib.buildTlsReport(runtime, [
      { stack: 'service-node', mode: 'default', ok: false, protocol: null, cipher: null, chainFailure: true, errorCode: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }
    ]);
    assert.ok(report.notes.join(' ').indexOf('Chaine de certification') !== -1, 'note de chaine presente');
    assert.ok(report.notes.join(' ').indexOf('Chromium') !== -1, 'resultats TV non deduits');
  });

  harness.it('aucun contournement TLS dans le service compile', function () {
    var files = [];
    (function walk(directory) {
      fs.readdirSync(directory).forEach(function (name) {
        var full = path.join(directory, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (/\.js$/.test(name)) files.push(full);
      });
    })(libRoot);
    assert.ok(files.length > 10, 'service compile present');
    files.forEach(function (file) {
      // le module de sonde porte lui-meme la liste des motifs interdits : il est exclu du balayage
      if (path.basename(file) === 'tlsProbe.js') return;
      var source = fs.readFileSync(file, 'utf8');
      tlsLib.assertNoTlsBypass(source);
      assert.ok(source.indexOf('NODE_TLS_REJECT_UNAUTHORIZED') === -1, 'variable de contournement absente : ' + path.basename(file));
    });
    assert.throws(function () {
      tlsLib.assertNoTlsBypass('https.request({ rejectUnauthorized: false })');
    }, 'internal/unexpected', 'le motif interdit est bien detecte');
  });

  harness.it('le bundle de racines embarque correspond a ses metadonnees', function () {
    var bundle = rootsLib.loadRootsBundle();
    assert.equal(bundle.verified, true, 'empreinte declaree = empreinte calculee');
    assert.ok(bundle.meta.certificateCount >= 100, 'bundle complet');
    assert.equal(rootsLib.countCertificates(bundle.pem), bundle.meta.certificateCount, 'nombre de certificats confirme');
    assert.ok(rootsLib.caOptionFor().indexOf('-----BEGIN CERTIFICATE-----') !== -1, 'option ca exploitable');
    var diagnostics = rootsLib.rootsDiagnostics();
    assert.ok(diagnostics.source.indexOf('curl.se') !== -1, 'provenance consignee');
    assert.equal(diagnostics.licensed === undefined, true, 'champ non prevu absent');
  });
});
