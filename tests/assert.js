'use strict';

/** Assertions minimales, sans dépendance, exécutables sur Node 8.12. */

function fail(message) {
  var error = new Error(message);
  error.name = 'AssertionError';
  throw error;
}

function ok(value, message) {
  if (!value) fail(message || 'valeur attendue vraie, reçue ' + String(value));
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    fail((message || 'egalite attendue') + ' : attendu ' + String(expected) + ', obtenu ' + String(actual));
  }
}

function deepEqual(actual, expected, message) {
  var a = JSON.stringify(actual);
  var b = JSON.stringify(expected);
  if (a !== b) fail((message || 'egalite profonde attendue') + ' : attendu ' + b + ', obtenu ' + a);
}

function bufferEqual(actual, expected, message) {
  if (!Buffer.isBuffer(actual) || !Buffer.isBuffer(expected)) fail((message || 'buffers attendus') + ' : type invalide');
  if (!actual.equals(expected)) {
    fail((message || 'egalite de buffers attendue') + ' : ' + actual.toString('hex').slice(0, 64) + ' != ' + expected.toString('hex').slice(0, 64));
  }
}

function throws(fn, codeExpected, message) {
  try {
    fn();
  } catch (err) {
    if (codeExpected && err && err.code !== codeExpected) {
      fail((message || 'code d erreur attendu ' + codeExpected) + ' : obtenu ' + (err && err.code));
    }
    return err;
  }
  fail(message || 'une exception etait attendue');
  return null;
}

function atMost(value, limit, message) {
  if (value > limit) fail((message || 'budget depasse') + ' : ' + value + ' > ' + limit);
}

module.exports = {
  ok: ok,
  equal: equal,
  deepEqual: deepEqual,
  bufferEqual: bufferEqual,
  throws: throws,
  atMost: atMost,
  fail: fail
};
