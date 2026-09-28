/**
 * Politique réseau du service (§2.5) — appliquée à **chaque saut** de redirection.
 *
 * Règles :
 *  - schémas autorisés : `http` (après avertissement mémorisé par profil/hôte) et `https` ;
 *  - l'hôte, le schéma et le port sont revalidés à chaque redirection ; une redirection
 *    HTTPS → HTTP demande une confirmation supplémentaire ;
 *  - la résolution DNS est faite **par le service** puis l'adresse publique validée est épinglée
 *    via le callback `lookup` du client HTTP : loopback, link-local, multicast, CGNAT et plages
 *    privées sont refusés par défaut, sauf autorisation LAN explicite du profil ;
 *  - `Authorization`, cookies et `Referer` ne sont **jamais** transmis à un autre origin ;
 *  - le nombre de redirections est borné (5) et un dépassement est une erreur explicite, jamais
 *    une supposition.
 *
 * La limite est explicite : pour l'URL remise au `<video>`, ces contrôles ne s'appliquent pas
 * (aucun hook) — d'où le marquage à l'indexation (§5.2) et le contrôle avant `video.src` (§6.1).
 */

import { AppError } from '../../contracts/errors';
import { markHost } from '../../core/hostSafety';
import { parseUrl, type ParsedUrl } from '../../core/urltools';

export const MAX_REDIRECTS = 5;
export const ALLOWED_SCHEMES = ['http', 'https'];
/** Ports refusés côté service : ils appartiennent à des services locaux de l'appareil. */
const BLOCKED_PORTS = [1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 138, 139, 143, 161, 162, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697];

export interface PolicyContext {
  /** autorisation LAN explicite du profil (§5.2) ; absent = refus par défaut */
  lanAllowed?: boolean;
  /** avertissement HTTP clair déjà accepté pour ce couple profil/hôte (§8.2) */
  insecureHttpAccepted?: boolean;
}

export interface HopDecision {
  parsed: ParsedUrl;
  /** avertissement à afficher/consigner (jamais bloquant seul) */
  warnings: string[];
}

export interface RequestPolicyResult extends HopDecision {
  /** vrai si le saut est un downgrade HTTPS → HTTP */
  isDowngrade: boolean;
}

/** Valide un saut avant toute connexion. Lève une `AppError` (code §7.2/§15.4) sinon. */
export function evaluateHop(rawUrl: string, context: PolicyContext, previousScheme?: string): RequestPolicyResult {
  const parsed = parseUrl(rawUrl);
  if (!parsed) throw new AppError('network/refused', 'URL fournisseur non analysable');
  if (ALLOWED_SCHEMES.indexOf(parsed.scheme) === -1) {
    throw new AppError('provider/unsupported', 'schema non supporte par le service : ' + parsed.scheme);
  }
  if (parsed.port !== undefined && BLOCKED_PORTS.indexOf(parsed.port) !== -1) {
    throw new AppError('security/privateHost', 'port de service local refuse par la politique reseau');
  }
  const warnings: string[] = [];
  const marking = markHost(parsed.raw, { lanAllowed: Boolean(context.lanAllowed) });
  if (!marking.playable) {
    throw new AppError('security/privateHost', 'hote prive ou local refuse par la politique reseau', 'autoriser explicitement ce serveur LAN dans le profil');
  }
  marking.warnings.forEach((warning) => warnings.push(warning));
  const isDowngrade = previousScheme === 'https' && parsed.scheme === 'http';
  if (parsed.scheme === 'http') {
    if (isDowngrade && !context.insecureHttpAccepted) {
      throw new AppError('security/insecureScheme', 'redirection HTTPS vers HTTP refusee sans confirmation');
    }
    if (!context.insecureHttpAccepted) {
      warnings.push('source en HTTP clair : avertissement a confirmer une fois par profil et par hote');
    }
  }
  return { parsed, warnings, isDowngrade };
}

/** Étiquette d'origine (`scheme://host:port`) utilisée pour l'épinglage des en-têtes sensibles. */
export function originOf(parsed: ParsedUrl): string {
  return parsed.scheme + '://' + parsed.host + (parsed.port === undefined ? '' : ':' + parsed.port);
}

const SENSITIVE_HEADERS = ['authorization', 'cookie', 'referer', 'proxy-authorization'];

/**
 * En-têtes à envoyer au saut suivant : les en-têtes sensibles ne suivent jamais une redirection
 * vers un autre origin (§2.5).
 */
export function headersForHop(
  requested: Record<string, string>,
  fromOrigin: string,
  toOrigin: string
): Record<string, string> {
  if (fromOrigin === toOrigin) return requested;
  const filtered: Record<string, string> = {};
  Object.keys(requested).forEach((name) => {
    if (SENSITIVE_HEADERS.indexOf(name.toLowerCase()) === -1) filtered[name] = requested[name];
  });
  return filtered;
}

export interface DnsAddress {
  address: string;
  family: number;
}

export type LookupFn = (
  hostname: string,
  options: { family?: number; all?: boolean },
  callback: (err: Error | null, address: string, family: number) => void
) => void;

/**
 * Résout puis valide l'adresse de destination (§2.5). L'adresse renvoyée est celle qui sera
 * épinglée : le pipeline média garde son propre chemin, ce contrôle ne concerne que le service.
 */
export function resolveAndValidate(
  host: string,
  lookup: LookupFn,
  context: PolicyContext
): Promise<DnsAddress> {
  return new Promise<DnsAddress>((resolve, reject) => {
    lookup(host, { family: 0 } as { family?: number }, (err, address, family) => {
      if (err || !address) {
        reject(new AppError('network/dns', 'resolution DNS impossible pour cet hote'));
        return;
      }
      const marking = markHost('http://' + wrapHost(address) + '/', { lanAllowed: Boolean(context.lanAllowed) });
      if (!marking.playable && marking.hostSafety === 'private') {
        reject(new AppError('security/privateHost', 'cet hote resout vers une adresse privee ou locale', 'autoriser explicitement ce serveur LAN dans le profil'));
        return;
      }
      resolve({ address: address, family: family || 0 });
    });
  });
}

function wrapHost(address: string): string {
  return address.indexOf(':') !== -1 ? '[' + address + ']' : address;
}

/** Fabrique un `lookup` épinglé, utilisé par le client HTTP (signature Node 8 : 3 arguments). */
export function pinnedLookup(address: DnsAddress, fallback: LookupFn): (hostname: string, options: unknown, callback: (err: Error | null, addr: string, family: number) => void) => void {
  return function lookupPinned(hostname: string, options: unknown, callback: (err: Error | null, addr: string, family: number) => void): void {
    void fallback;
    void hostname;
    void options;
    callback(null, address.address, address.family);
  };
}
