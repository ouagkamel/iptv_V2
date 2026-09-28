'use strict';

/**
 * Portail Xtream **synthétique** (aucun appel réseau réel, aucune donnée utilisateur).
 *
 * Il sert trois objectifs :
 *  - fournir un transport et un résolveur factices au `HttpClient`, donc tester la politique réseau,
 *    les redirections et les plafonds sans sortir du processus ;
 *  - livrer les réponses en **plusieurs morceaux** pour éprouver l'analyse JSON incrémentale ;
 *  - injecter les cas pénibles : 401, 503 récupérable (repli par catégorie), redirection inter-hôte,
 *    hôte qui résout vers une adresse privée, gzip, réponse volumineuse.
 *
 * Compatible Node 8.12 : `var`, fonctions, promesses éventuelles côté tests.
 */

var zlib = require('zlib');

var PUBLIC_ADDRESS = '93.184.216.34';
var PRIVATE_ADDRESS = '192.168.1.10';
var UNSECURE_ADDRESS = '198.51.100.7';

function pad(value, width) {
  var text = String(value);
  while (text.length < width) text = '0' + text;
  return text;
}

function createPortal(options) {
  options = options || {};
  var config = {
    username: options.username || 'testeur',
    password: options.password || 'secret',
    counts: options.counts || { live: 40, vod: 12, series: 6 },
    chunkSize: options.chunkSize || 512,
    gzip: options.gzip === true,
    privateHost: options.privateHost || null,
    insecureHost: options.insecureHost || null,
    latencyMs: options.latencyMs === undefined ? 0 : options.latencyMs,
    /** { action: 'get_live_streams', to: 'https://cdn.example.net' } : redirection inter-hôte */
    redirect: options.redirect || null,
    /** { action: 'get_live_streams', status: 503, times: 1 } : échec récupérable, une seule fois */
    failure: options.failure || null,
    /** nombre d'entrées seulement visibles après un certain nombre d'appels (repli) */
    categoryStreams: options.categoryStreams || null,
    /** ajoute une URL imposée porteuse d'identifiants (userinfo) sur la 5e entrée */
    credentialedDirectSource: options.credentialedDirectSource === true,
    /** tronque la reponse pour simuler une reponse incomplete (analyse refusee) */
    truncate: options.truncate === true,
    /** coupe la connexion apres N morceaux : erreur reseau en plein import */
    abortAfterChunks: options.abortAfterChunks || null
  };
  var calls = [];
  var failuresUsed = 0;

  /* ----------------------------------------------------------- adresses et DNS */

  function addressFor(host) {
    if (config.privateHost && host === config.privateHost) return PRIVATE_ADDRESS;
    if (config.insecureHost && host === config.insecureHost) return UNSECURE_ADDRESS;
    return PUBLIC_ADDRESS;
  }

  /** Résolveur factice : aucune requête DNS réelle (§2.5 : l'adresse validée est épinglée). */
  function lookup(hostname, lookupOptions, callback) {
    setTimeout(function () {
      if (config.privateHost && hostname === 'introuvable.example.com') {
        var err = new Error('getaddrinfo ENOTFOUND');
        err.code = 'ENOTFOUND';
        callback(err, '', 0);
        return;
      }
      callback(null, addressFor(hostname), 4);
    }, 0);
  }

  /* --------------------------------------------------------------- contenus */

  var LIVE_CATEGORIES = [
    { category_id: '1', category_name: 'Sports', parent_id: 0 },
    { category_id: '2', category_name: 'Cin\u00e9ma', parent_id: 0 },
    { category_id: '3', category_name: 'Docs', parent_id: 0 }
  ];

  function liveStreams() {
    var out = [];
    for (var i = 0; i < config.counts.live; i++) {
      var categoryId = String(1 + (i % LIVE_CATEGORIES.length));
      var record = {
        num: i + 1,
        name: 'Chaine ' + pad(i + 1, 4) + ' FR|HD',
        stream_type: 'live',
        stream_id: String(1000 + i),
        stream_icon: 'https://cdn.example.com/logo/' + i + '.png',
        epg_channel_id: 'epg-' + i,
        added: '1600000000',
        category_id: categoryId,
        custom_sid: '',
        tv_archive: 0
      };
      // une entrée « direct_source » publique et une entrée portant des identifiants (userinfo)
      if (i === 3) record.direct_source = 'https://cdn.example.net/live/embed/' + i + '.ts';
      if (i === 4 && config.credentialedDirectSource) {
        record.direct_source = 'https://utilisateur:motdepasse@cdn.example.net/live/embed/' + i + '.ts';
      }
      out.push(record);
    }
    return out;
  }

  function vodStreams() {
    var out = [];
    for (var i = 0; i < config.counts.vod; i++) {
      out.push({
        num: i + 1,
        name: 'Film ' + pad(i + 1, 4),
        stream_type: 'movie',
        stream_id: String(5000 + i),
        stream_icon: 'https://cdn.example.com/poster/' + i + '.jpg',
        rating: '7.5',
        rating_5based: 3.5,
        added: '1600000000',
        category_id: String(1 + (i % LIVE_CATEGORIES.length)),
        container_extension: 'mp4',
        direct_source: ''
      });
    }
    return out;
  }

  function seriesList() {
    var out = [];
    for (var i = 0; i < config.counts.series; i++) {
      out.push({
        num: i + 1,
        name: 'Serie ' + pad(i + 1, 3),
        series_id: String(9000 + i),
        cover: 'https://cdn.example.com/serie/' + i + '.jpg',
        plot: 'Une serie synthetique numero ' + (i + 1),
        cast: 'A, B, C',
        director: 'D',
        genre: 'Drame',
        releaseDate: '2019-01-0' + (1 + (i % 9)),
        rating: '7.0',
        category_id: String(1 + (i % LIVE_CATEGORIES.length))
      });
    }
    return out;
  }

  function seriesInfo(seriesId) {
    return {
      seasons: [{ season_number: 1, name: 'Saison 1', cover: '', episode_count: 2 }],
      info: { name: 'Serie ' + seriesId, cover: '', plot: 'Resume synthetique', cast: 'A', director: 'D', genre: 'Drame' },
      episodes: {
        '1': [
          { id: String(Number(seriesId) * 10 + 1), episode_num: 1, title: 'Pilote', container_extension: 'mkv', season: 1, info: { duration: '45' } },
          { id: String(Number(seriesId) * 10 + 2), episode_num: 2, title: 'Suite', container_extension: 'mkv', season: 1, info: { duration: '42' } }
        ]
      }
    };
  }

  function accountInfo() {
    return {
      user_info: {
        username: config.username,
        auth: 1,
        status: 'Active',
        exp_date: String(Math.floor(Date.now() / 1000) + 30 * 24 * 3600),
        is_trial: '0',
        active_cons: '1',
        created_at: '1600000000',
        max_connections: '2',
        allowed_output_formats: ['m3u8', 'ts']
      },
      server_info: { url: 'portal.example.com', port: '8080', https_port: '443', server_protocol: 'http', timezone: 'Europe/Paris' }
    };
  }

  function parseQuery(path) {
    var query = {};
    var index = path.indexOf('?');
    if (index === -1) return query;
    path
      .slice(index + 1)
      .split('&')
      .forEach(function (pair) {
        if (pair === '') return;
        var parts = pair.split('=');
        query[decodeURIComponent(parts[0])] = decodeURIComponent(parts.slice(1).join('='));
      });
    return query;
  }

  /* --------------------------------------------------------------- transport */

  function respond(call) {
    var query = parseQuery(call.path);
    var action = query.action || '';

    if (query.username !== undefined || query.password !== undefined) {
      if (query.username !== config.username || query.password !== config.password) {
        return { status: 401, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_info: { auth: 0 } }) };
      }
    }

    if (config.failure && config.failure.action === action && failuresUsed < (config.failure.times || 1)) {
      failuresUsed += 1;
      return { status: config.failure.status || 503, headers: { 'content-type': 'text/plain' }, body: 'indisponible' };
    }

    if (config.redirect && config.redirect.action === action && call.host !== 'cdn.example.net') {
      return {
        status: config.redirect.status || 302,
        headers: { location: config.redirect.to + call.path },
        body: ''
      };
    }

    if (action === '') {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(accountInfo()) };
    }
    if (action === 'get_live_categories' || action === 'get_vod_categories' || action === 'get_series_categories') {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(LIVE_CATEGORIES) };
    }
    if (action === 'get_live_streams') {
      var live = liveStreams();
      if (config.categoryStreams && query.category_id) {
        live = live.filter(function (record) {
          return record.category_id === query.category_id;
        });
      }
      var liveBody = JSON.stringify(live);
      if (config.truncate) liveBody = liveBody.slice(0, Math.floor(liveBody.length * 0.6));
      if (config.abortAfterChunks !== null) liveBody = liveBody;
      return { status: 200, headers: { 'content-type': 'application/json' }, body: liveBody };
    }
    if (action === 'get_vod_streams') {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(vodStreams()) };
    }
    if (action === 'get_series') {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(seriesList()) };
    }
    if (action === 'get_series_info') {
      return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(seriesInfo(query.series_id || '9000')) };
    }
    return { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' };
  }

  function transportRequest(transportOptions, callback) {
    var call = {
      protocol: transportOptions.protocol,
      host: transportOptions.hostname,
      port: transportOptions.port,
      path: transportOptions.path,
      method: transportOptions.method,
      headers: transportOptions.headers || {},
      hasLookup: typeof transportOptions.lookup === 'function',
      ca: transportOptions.ca
    };
    calls.push(call);

    var aborted = false;
    var timers = [];
    var requestListeners = {};

    var request = {
      on: function (event, listener) {
        (requestListeners[event] = requestListeners[event] || []).push(listener);
        return request;
      },
      write: function () {},
      setTimeout: function () {
        return request;
      },
      end: function () {
        schedule(0, begin);
      },
      destroy: function () {
        aborted = true;
        timers.forEach(function (timer) {
          clearTimeout(timer);
        });
        timers = [];
        (requestListeners.error || []).forEach(function (listener) {
          listener(new Error('socket hang up'));
        });
      },
      __call: call
    };

    function schedule(delay, fn) {
      var timer = setTimeout(function () {
        if (!aborted) fn();
      }, delay + config.latencyMs);
      timers.push(timer);
      return timer;
    }

    function begin() {
      if (aborted) return;
      var result = respond(call);
      var raw = Buffer.from(result.body, 'utf8');
      var payload = config.gzip && raw.length > 0 ? zlib.gzipSync(raw) : raw;
      var headers = result.headers;
      if (config.gzip && raw.length > 0) {
        headers = Object.assign({}, headers, { 'content-encoding': 'gzip' });
      }

      var responseListeners = {};
      var response = {
        statusCode: result.status,
        headers: headers,
        on: function (event, listener) {
          (responseListeners[event] = responseListeners[event] || []).push(listener);
          return response;
        }
      };
      callback(response);

      function emit(event, value) {
        (responseListeners[event] || []).forEach(function (listener) {
          listener(value);
        });
      }

      var offset = 0;
      var chunksSent = 0;
      function push() {
        if (aborted) return;
        if (config.abortAfterChunks !== null && chunksSent >= config.abortAfterChunks) {
          aborted = true;
          emit('error', new Error('connexion coupee'));
          return;
        }
        if (offset >= payload.length) {
          emit('end');
          return;
        }
        var chunk = payload.slice(offset, offset + config.chunkSize);
        offset += chunk.length;
        chunksSent += 1;
        emit('data', chunk);
        if (offset < payload.length) schedule(0, push);
        else schedule(0, function () {
          emit('end');
        });
      }
      schedule(0, push);
    }

    return request;
  }

  return {
    config: config,
    calls: calls,
    lookup: lookup,
    transport: { request: transportRequest },
    /** Appels reçus pour une action donnée (ordre chronologique). */
    callsFor: function (action) {
      return calls.filter(function (call) {
        return call.path.indexOf('action=' + action) !== -1;
      });
    },
    /** Toutes les valeurs d'en-tête observées, pour vérifier ce qui n'a jamais été transmis. */
    headerValues: function (name) {
      var lower = name.toLowerCase();
      return calls
        .map(function (call) {
          var found;
          Object.keys(call.headers).forEach(function (key) {
            if (key.toLowerCase() === lower) found = call.headers[key];
          });
          return found;
        })
        .filter(function (value) {
          return value !== undefined;
        });
    }
  };
}

module.exports = {
  createPortal: createPortal,
  PUBLIC_ADDRESS: PUBLIC_ADDRESS,
  PRIVATE_ADDRESS: PRIVATE_ADDRESS,
  UNSECURE_ADDRESS: UNSECURE_ADDRESS,
  pad: pad
};
