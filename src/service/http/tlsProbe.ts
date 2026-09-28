/**
 * Observation TLS par pile (§2.5, §10, §12 phase 0D).
 *
 * Trois piles distinctes existent sur la TV : Chromium (interface), le pipeline média et le
 * **Node 8.12 du service**. Elles n'ont ni le même moteur TLS ni le même magasin de racines. Ce
 * module ne prétend rien : il exécute des poignées de main réelles et consigne le résultat, afin
 * que le diagnostic local montre un écart au lieu de le masquer.
 *
 * Contraintes Node 8.12 : `minVersion`/`maxVersion` (ajoutés en Node 11.4) n'existent pas ; on
 * utilise `secureProtocol` (`TLSv1_2_method`, `TLSv1_3_method`). Un build appuyé sur OpenSSL 1.0.2p
 * n'a pas TLS 1.3 : la tentative TLS 1.3-only doit donc **échouer et être consignée** comme telle,
 * pas contournée.
 */

import * as tls from 'tls';
import { AppError } from '../../contracts/errors';
import { caOptionFor } from './rootsBundle';

export type TlsStack = 'service-node' | 'media-pipeline' | 'chromium-ui';
export type TlsMode = 'default' | 'tls12-only' | 'tls13-only';

export interface TlsProbeResult {
  stack: TlsStack;
  mode: TlsMode;
  ok: boolean;
  protocol?: string;
  cipher?: string;
  /** émetteur du certificat (donnée publique) */
  issuer?: string;
  subject?: string;
  validTo?: string;
  /** code d'erreur normalisé, jamais le message brut de la pile */
  errorCode?: string;
  /** vrai si l'échec indique une chaîne de certification non validée (racine absente du magasin) */
  chainFailure?: boolean;
  observedAt: number;
}

export interface RuntimeVersions {
  node: string;
  openssl: string;
  /** vrai si la version d'OpenSSL annonce TLS 1.3 (≥ 1.1.1) — reste une déduction, pas une preuve */
  tls13Expected: boolean;
}

export function describeRuntime(versions: NodeJS.ProcessVersions = process.versions): RuntimeVersions {
  const openssl = versions.openssl || 'inconnue';
  return {
    node: versions.node || 'inconnue',
    openssl,
    tls13Expected: compareVersions(openssl, '1.1.1') >= 0
  };
}

export interface ProbeOptions {
  host: string;
  port?: number;
  mode?: TlsMode;
  /** bundle de racines embarqué : c'est lui qui doit corriger le magasin figé du firmware */
  useEmbeddedRoots?: boolean;
  timeoutMs?: number;
  connect?: typeof tls.connect;
}

/** Exécute une poignée de main TLS et renvoie une observation normalisée. */
export function probeTls(options: ProbeOptions): Promise<TlsProbeResult> {
  const mode: TlsMode = options.mode || 'default';
  const port = options.port === undefined ? 443 : options.port;
  const connectFn = options.connect || tls.connect;
  const base: TlsProbeResult = { stack: 'service-node', mode, ok: false, observedAt: Date.now() };
  return new Promise<TlsProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: TlsProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const connectOptions: tls.ConnectionOptions = {
      host: options.host,
      port,
      servername: options.host,
      // la validation reste active : aucune CA privée, aucun rejectUnauthorized:false
      rejectUnauthorized: true
    };
    if (mode === 'tls12-only') connectOptions.secureProtocol = 'TLSv1_2_method';
    if (mode === 'tls13-only') connectOptions.secureProtocol = 'TLSv1_3_method';
    if (options.useEmbeddedRoots !== false) {
      try {
        connectOptions.ca = caOptionFor();
      } catch (_err) {
        // sans bundle embarqué, la poignée de main utilise le magasin du firmware : c'est le cas
        // de référence du §2.5, il doit rester observable et non masqué
      }
    }
    let socket: tls.TLSSocket | null = null;
    const timer = setTimeout(() => {
      if (socket) socket.destroy();
      finish(Object.assign({}, base, { errorCode: 'network/timeout' }));
    }, options.timeoutMs === undefined ? 10000 : options.timeoutMs);
    try {
      socket = connectFn(connectOptions, () => {
        clearTimeout(timer);
        const peer: { issuer?: { CN?: string }; subject?: { CN?: string }; valid_to?: string } =
          socket && typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() || {} : {};
        const result: TlsProbeResult = Object.assign({}, base, {
          ok: true,
          protocol: socket && typeof socket.getProtocol === 'function' ? socket.getProtocol() || undefined : undefined,
          cipher:
            socket && typeof socket.getCipher === 'function' ? (socket.getCipher() || ({} as { name?: string })).name : undefined,
          issuer: peer.issuer && peer.issuer.CN ? peer.issuer.CN : undefined,
          subject: peer.subject && peer.subject.CN ? peer.subject.CN : undefined,
          validTo: peer.valid_to
        });
        if (socket) socket.end();
        finish(result);
      });
      socket.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        const code = error.code || 'unknown';
        finish(
          Object.assign({}, base, {
            errorCode: code,
            chainFailure: isChainFailure(code)
          })
        );
      });
    } catch (error) {
      clearTimeout(timer);
      finish(Object.assign({}, base, { errorCode: asCode(error) }));
    }
  });
}

function isChainFailure(code: string): boolean {
  return (
    code.indexOf('CERT') !== -1 ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
  );
}

function asCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) return String((error as NodeJS.ErrnoException).code);
  return 'unknown';
}

/** Compare deux versions `x.y.z` sans dépendance (`semver` n'existe pas côté service). */
export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => parseInt(part.replace(/[^0-9].*$/, ''), 10) || 0);
  const b = right.split('.').map((part) => parseInt(part.replace(/[^0-9].*$/, ''), 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export interface TlsReport {
  runtime: RuntimeVersions;
  probes: TlsProbeResult[];
  /** traitement par pile : un écart est montré, jamais lissé (§10) */
  notes: string[];
}

/**
 * Construit le rapport de diagnostic TLS. Le résultat du service est mesuré ; celui de Chromium et
 * du pipeline média reste **à renseigner sur la TV** (phase 0B/0D) : le rapport le dit explicitement
 * plutôt que de l'inventer.
 */
export function buildTlsReport(runtime: RuntimeVersions, probes: TlsProbeResult[]): TlsReport {
  const notes: string[] = [];
  if (!runtime.tls13Expected) {
    notes.push(
      'OpenSSL ' +
        runtime.openssl +
        ' : pas de TLS 1.3 cote service. Baseline du service = TLS 1.2 ; TLS 1.3 ne sera annonce que si la TV le demontre.'
    );
  }
  const chainFailure = probes.filter((probe) => probe.chainFailure);
  if (chainFailure.length > 0) {
    notes.push(
      'Chaine de certification non validee par le service (' +
        chainFailure.length +
        ' cas) : verifier si le bundle de racines embarque corrige, et consigner separement le resultat de Chromium et du pipeline media.'
    );
  }
  notes.push('Chromium et pipeline media : resultats a mesurer sur TV (phase 0B/0D), non deduits de ce rapport.');
  return { runtime, probes, notes };
}

/** Garde-fou de revue : ces motifs ne doivent apparaître nulle part dans le service. */
export const FORBIDDEN_TLS_PATTERNS = ['rejectUnauthorized: false', 'NODE_TLS_REJECT_UNAUTHORIZED', 'rejectUnauthorized:false'];

export function assertNoTlsBypass(source: string): void {
  FORBIDDEN_TLS_PATTERNS.forEach((pattern) => {
    if (source.indexOf(pattern) !== -1) {
      throw new AppError('internal/unexpected', 'contournement TLS detecte dans la source du service');
    }
  });
}
