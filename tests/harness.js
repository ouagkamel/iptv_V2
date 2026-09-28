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

function run() {
  var passed = 0;
  var failed = 0;
  var failures = [];
  suites.forEach(function (suite) {
    console.log('\n' + suite.name);
    suite.tests.forEach(function (test) {
      try {
        test.fn();
        passed += 1;
        console.log('  \u2713 ' + test.name);
      } catch (err) {
        failed += 1;
        failures.push({ suite: suite.name, test: test.name, err: err });
        console.log('  \u2717 ' + test.name);
      }
    });
  });
  console.log('\n' + passed + ' test(s) OK, ' + failed + ' echec(s)');
  if (failed > 0) {
    failures.forEach(function (failure) {
      console.log('\n--- ' + failure.suite + ' > ' + failure.test + ' ---');
      console.log(failure.err && failure.err.stack ? failure.err.stack : String(failure.err));
    });
    process.exitCode = 1;
  }
}

module.exports = { describe: describe, it: it, run: run };
