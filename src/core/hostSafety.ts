/**
 * Marquage `hostSafety` des URL de flux (§5.2) et contrôle avant `video.src` (§6.1).
 *
 * Objectif : refuser par défaut les hôtes qui pointent vers la machine ou le réseau local, y
 * compris en notations décimales, octales ou hexadécimales (`2130706433`, `0177.0.0.1`,
 * `0x7f.1`), les IPv6 loopback/link-local et les IPv4 encapsulées dans IPv6.
 *
 * Limite explicite (§2.5, §6.1) : le pipeline média résout le DNS lui-même et l'application ne
 * peut pas épingler l'IP. Un **nom d'hôte** qui résout vers une adresse privée reste un risque
 * résiduel assumé — il est marqué `ok` et signalé en warning, pas présenté comme filtré.
 */

import type { HostSafety } from '../contracts/types';
import { hostOf, parseUrl } from './urltools';

export interface HostMarking {
  hostSafety: HostSafety;
  playable: boolean;
  warnings: string[];
}

/** Plages IPv4 privées/réservées (§5.2). */
const IPV4_BLOCKED: Array<{ name: string; cidr: string; test: (o: number[]) => boolean }> = [
  { name: 'this-network 0.0.0.0/8', cidr: '0/8', test: (o) => o[0] === 0 },
  { name: 'loopback 127/8', cidr: '127/8', test: (o) => o[0] === 127 },
  { name: 'privé 10/8', cidr: '10/8', test: (o) => o[0] === 10 },
  { name: 'privé 172.16/12', cidr: '172.16/12', test: (o) => o[0] === 172 && o[1] >= 16 && o[1] <= 31 },
  { name: 'privé 192.168/16', cidr: '192.168/16', test: (o) => o[0] === 192 && o[1] === 168 },
  { name: 'link-local 169.254/16', cidr: '169.254/16', test: (o) => o[0] === 169 && o[1] === 254 },
  { name: 'CGNAT 100.64/10', cidr: '100.64/10', test: (o) => o[0] === 100 && o[1] >= 64 && o[1] <= 127 },
  { name: 'IAM cloud 192.0.0/24', cidr: '192.0.0/24', test: (o) => o[0] === 192 && o[1] === 0 && o[2] === 0 },
  { name: 'benchmark 198.18/15', cidr: '198.18/15', test: (o) => o[0] === 198 && (o[1] === 18 || o[1] === 19) },
  { name: 'multicast 224/4', cidr: '224/4', test: (o) => o[0] >= 224 && o[0] <= 239 },
  { name: 'réservé 240/4', cidr: '240/4', test: (o) => o[0] >= 240 && o[0] <= 255 }
];

/**
 * Convertit un hôte IPv4 en octets, en acceptant les notations non canoniques :
 * `10.0.0.1`, `10.1`, `0x7f.1`, `0177.0.0.1`, `2130706433`, `127.1`.
 * Renvoie null si ce n'est pas une IPv4 littérale.
 */
export function parseIpv4Literal(host: string): number[] | null {
  if (host === '' || /[^0-9a-fx.]/i.test(host)) return null;
  const parts = host.split('.');
  if (parts.length > 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    const value = parseIpv4Part(part);
    if (value === null) return null;
    numbers.push(value);
  }
  // 4 parties : chacune tient sur 8 bits. Moins de 4 : la dernière absorbe les octets restants
  // (`127.1` = 127.0.0.1, `2130706433` = 127.0.0.1 en notation décimale compacte).
  for (let i = 0; i < numbers.length - 1; i++) {
    if (numbers[i] > 255) return null;
  }
  const last = numbers[numbers.length - 1];
  const bytesCoveredByLast = 5 - numbers.length; // 4 parties -> 1 octet, 1 partie -> 4 octets
  const maxLast = Math.pow(256, bytesCoveredByLast);
  if (last >= maxLast) return null;
  let value = 0;
  for (let i = 0; i < numbers.length; i++) {
    const multiplier = i === numbers.length - 1 ? 1 : Math.pow(256, bytesCoveredByLast + numbers.length - 2 - i);
    value += numbers[i] * multiplier;
  }
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function parseIpv4Part(part: string): number | null {
  if (part === '') return null;
  if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return parseInt(part.slice(1), 8); // notation octale
  if (/^[0-9]+$/.test(part)) return parseInt(part, 10);
  return null;
}

/** Octets d'une IPv6 littérale, ou null si l'hôte n'en est pas une. */
export function parseIpv6Literal(host: string): number[] | null {
  const value = host.toLowerCase();
  if (value.indexOf(':') === -1) return null;
  const zoneIdx = value.indexOf('%');
  const core = zoneIdx === -1 ? value : value.slice(0, zoneIdx);
  const doubleColon = core.indexOf('::');
  if (core.indexOf('::', doubleColon + 1) !== -1 && doubleColon !== -1 && core.indexOf('::', doubleColon + 2) !== -1) {
    return null;
  }
  const [headRaw, tailRaw] = doubleColon === -1 ? [core, ''] : [core.slice(0, doubleColon), core.slice(doubleColon + 2)];
  const head = headRaw === '' ? [] : headRaw.split(':');
  const tail = tailRaw === '' ? [] : tailRaw.split(':');
  const groups: number[] = [];
  const pushGroup = (group: string): boolean => {
    if (/^[0-9a-f]{1,4}$/.test(group)) {
      groups.push(parseInt(group, 16));
      return true;
    }
    // IPv4 encapsulée (::ffff:192.168.0.1)
    if (group.indexOf('.') !== -1) {
      const v4 = parseIpv4Literal(group);
      if (!v4) return false;
      groups.push(((v4[0] << 8) | v4[1]) & 0xffff, ((v4[2] << 8) | v4[3]) & 0xffff);
      return true;
    }
    return false;
  };
  for (const group of head) {
    if (!pushGroup(group)) return null;
  }
  const headLength = groups.length;
  const tailGroups: number[] = [];
  for (const group of tail) {
    if (/^[0-9a-f]{1,4}$/.test(group)) tailGroups.push(parseInt(group, 16));
    else if (group.indexOf('.') !== -1) {
      const v4 = parseIpv4Literal(group);
      if (!v4) return null;
      tailGroups.push(((v4[0] << 8) | v4[1]) & 0xffff, ((v4[2] << 8) | v4[3]) & 0xffff);
    } else return null;
  }
  if (doubleColon === -1) {
    if (headLength !== 8) return null;
    return groupsToBytes(groups);
  }
  const missing = 8 - headLength - tailGroups.length;
  if (missing < 0) return null;
  const full = groups.slice(0, headLength).concat(new Array(missing).fill(0), tailGroups);
  if (full.length !== 8) return null;
  return groupsToBytes(full);
}

function groupsToBytes(groups: number[]): number[] {
  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 255, group & 255);
  }
  return bytes;
}

const IPV6_BLOCKED: Array<{ name: string; test: (b: number[]) => boolean }> = [
  { name: 'unspecified ::/128', test: (b) => b.every((x) => x === 0) },
  { name: 'loopback ::1', test: (b) => b.slice(0, 15).every((x) => x === 0) && b[15] === 1 },
  { name: 'link-local fe80::/10', test: (b) => b[0] === 0xfe && (b[1] & 0xc0) === 0x80 },
  { name: 'unique-local fc00::/7', test: (b) => (b[0] & 0xfe) === 0xfc },
  { name: 'multicast ff00::/8', test: (b) => b[0] === 0xff },
  { name: 'IPv4-mappée ::ffff:0:0/96', test: (b) => isIpv4Mapped(b) }
];

function isIpv4Mapped(bytes: number[]): boolean {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return (bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0);
}

function blockedIpv4(bytes: number[]): string | null {
  for (const range of IPV4_BLOCKED) {
    if (range.test(bytes)) return range.name;
  }
  return null;
}

export interface MarkHostOptions {
  /** autorisation LAN explicite du profil (§5.2) */
  lanAllowed?: boolean;
}

/**
 * Marque l'hôte d'une URL de lecture. Un hôte privé/loopback devient `private` (ou `allowed-lan`
 * si le profil l'a explicitement autorisé) ; un nom d'hôte reste `ok` avec un avertissement
 * documenté ; une URL non analysable est `unknown`.
 */
export function markHost(url: string, options: MarkHostOptions = {}): HostMarking {
  const warnings: string[] = [];
  const parsed = parseUrl(url);
  if (!parsed || (parsed.scheme !== 'http' && parsed.scheme !== 'https')) {
    return {
      hostSafety: 'unknown',
      playable: false,
      warnings: ['URL de flux non analysee ou schema non supporte']
    };
  }
  const host = parsed.host;
  let blockedName: string | null = null;
  const ipv4 = parseIpv4Literal(host);
  if (ipv4) blockedName = blockedIpv4(ipv4);
  else {
    const ipv6 = parseIpv6Literal(host);
    if (ipv6) {
      for (const range of IPV6_BLOCKED) {
        if (range.test(ipv6)) {
          blockedName = range.name;
          if (range.name === 'IPv4-mappée ::ffff:0:0/96') {
            const inner = blockedIpv4(ipv6.slice(12));
            blockedName = inner ? inner + ' (via IPv4 mappee)' : range.name;
          }
          break;
        }
      }
    }
  }
  if (blockedName) {
    warnings.push('hote prive bloquee par defaut : ' + blockedName);
    if (options.lanAllowed) {
      return { hostSafety: 'allowed-lan', playable: true, warnings };
    }
    return { hostSafety: 'private', playable: false, warnings };
  }
  if (!ipv4 && !parseIpv6Literal(host) && host.indexOf('.') !== -1) {
    warnings.push(
      'nom d hote : resolution DNS effectuee par le pipeline media, aucun epinglage IP possible (risque residuel assume)'
    );
  }
  return { hostSafety: 'ok', playable: true, warnings };
}

/** Autorisation LAN explicite, à porter sur le profil (§5.2, §6.1). */
export function lanAllowedFromProfile(profile: { lanAllowed?: boolean } | undefined): boolean {
  return Boolean(profile && profile.lanAllowed);
}

/** Contrôle appliqué **juste avant** `video.src` (§6.1) : best-effort, documenté comme tel. */
export function canPlay(url: string, options: MarkHostOptions = {}): { ok: boolean; reason?: string } {
  const marking = markHost(url, options);
  if (marking.playable) return { ok: true };
  return {
    ok: false,
    reason:
      marking.hostSafety === 'private'
        ? 'security/privateHost'
        : 'URL de flux non analysee ou schema non supporte'
  };
}

/** Hôte brut, pour les avertissements du diagnostic (jamais une URL complète). */
export function hostForDiagnostics(url: string): string {
  return hostOf(url) || 'inconnu';
}
