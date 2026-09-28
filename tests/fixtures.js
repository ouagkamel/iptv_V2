'use strict';

/**
 * Fixtures **synthétiques** (aucune donnée utilisateur, aucune provenance externe) : elles
 * reproduisent les formes rencontrées en phase 0C/0D — entrées ventrues, catégories dispersées,
 * titres latins et arabes, URL de flux privées et CDN publiques.
 */

var crypto = require('crypto');

function refHash(seed) {
  return crypto.createHash('sha256').update('fixture/' + seed).digest().slice(0, 16).toString('hex');
}

var QUALITY = ['HD', 'FHD', '4K', 'UHD', ''];

function makeEntries(count, options) {
  options = options || {};
  var categories = options.categories || ['Sports', 'Cinema', 'Documentaires'];
  var entries = [];
  for (var i = 0; i < count; i++) {
    var category = categories[i % categories.length];
    var quality = QUALITY[i % QUALITY.length];
    var title = (options.arabicOnly || (options.arabic && i % 3 === 0))
      ? '\u0627\u0644\u0642\u0646\u0627\u0629 ' + (i + 1) + ' ' + quality
      : 'Chaine ' + pad(i + 1, 4) + ' ' + ('FR|' + quality);
    entries.push({
      categoryId: category,
      title: title,
      refKey: String(1000 + i),
      refHash: refHash(String(i)),
      hostSafety: i % 17 === 0 ? 'private' : 'ok',
      streamMode: i % 5 === 0 ? 'storedSecret' : 'urlNoSecret',
      hasCredential: i % 5 === 0,
      playable: i % 17 !== 0,
      epgId: options.epg === false ? undefined : 'epg-' + i,
      logoOrPosterUrl: options.fatItems ? 'https://cdn.example.com/logo/' + pad(i, 6) + '.png' + repeat('x', 120) : 'https://cdn.example.com/logo/' + i + '.png',
      summary: options.fatItems ? repeat('resume ', 28) : 'Resume court de la chaine ' + i,
      plot: options.fatItems ? repeat('description complete ', 200) : undefined,
      streamUrl: i % 5 === 0 ? 'https://cdn.example.com/live/' + i + '.ts' : undefined,
      streamForm: i % 5 !== 0 ? '/live/' + i + '.ts' : undefined
    });
  }
  return entries;
}

function pad(value, width) {
  var text = String(value);
  while (text.length < width) text = '0' + text;
  return text;
}

function repeat(text, times) {
  var out = '';
  for (var i = 0; i < times; i++) out += text;
  return out;
}

module.exports = { makeEntries: makeEntries, refHash: refHash, repeat: repeat, pad: pad };
