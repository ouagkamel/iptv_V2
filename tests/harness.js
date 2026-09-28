/**
 * Harnais de test minimal, **compatible Node 8.12** (aucune dépendance, aucune API postérieure).
 * Il est volontairement rudimentaire : les tests doivent pouvoir s'exécuter sur la même cible que
 * le service (§11.1 : un test qui échoue seulement sur Node 8.12 est un bug de cible).
 */

'use strict';

var suites = [];
var currentSuite = null;

function describe(name, fn) {
  currentSuite = { name: name, tests: [] };
  suites.push(currentSuite);
  fn();
  currentSuite = null;
}

function it(name, fn) {
  if (!currentSuite) throw new Error('it() hors describe()');
  currentSuite.tests.push({ name: name, fn: fn });
}

/**
 * Exécute la suite. Un test peut être synchrone ou renvoyer une promesse : les tests asynchrones
 * (réseau simulé, import, LS2) sont attendus avant le test suivant, et un rejet compte comme échec.
 * Aucune API postérieure à Node 8.12 n'est utilisée.
 */
function run() {
  var passed = 0;
  var failed = 0;
  var failures = [];
  var queue = [];
  suites.forEach(function (suite) {
    suite.tests.forEach(function (test) {
      queue.push({ suite: suite.name, test: test });
    });
  });

  function report() {
    console.log('\n' + passed + ' test(s) OK, ' + failed + ' echec(s)');
    if (failed > 0) {
      failures.forEach(function (failure) {
        console.log('\n--- ' + failure.suite + ' > ' + failure.test + ' ---');
        console.log(failure.err && failure.err.stack ? failure.err.stack : String(failure.err));
      });
      process.exitCode = 1;
    }
  }

  function record(item, err) {
    if (err) {
      failed += 1;
      failures.push({ suite: item.suite, test: item.test.name, err: err });
      console.log('  \u2717 ' + item.test.name);
    } else {
      passed += 1;
      console.log('  \u2713 ' + item.test.name);
    }
  }

  var index = 0;
  var shownSuite = null;

  function step() {
    if (index >= queue.length) {
      report();
      return Promise.resolve();
    }
    var item = queue[index++];
    if (item.suite !== shownSuite) {
      shownSuite = item.suite;
      console.log('\n' + shownSuite);
    }
    var result;
    try {
      result = item.test.fn();
    } catch (err) {
      record(item, err);
      return step();
    }
    if (result && typeof result.then === 'function') {
      return result.then(
        function () {
          record(item, null);
          return step();
        },
        function (err) {
          record(item, err || new Error('test asynchrone rejete'));
          return step();
        }
      );
    }
    record(item, null);
    return step();
  }

  return step();
}

module.exports = { describe: describe, it: it, run: run };
