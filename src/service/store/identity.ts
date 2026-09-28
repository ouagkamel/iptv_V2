/**
 * Identité d'index : empreinte opaque d'une entrée (jamais l'URL, jamais l'identifiant en clair).
 * `refHash` est ce qui est écrit dans le secteur (`u8[16] refHash`, §15.2) ; il sert aussi de
 * référence opaque (`streamRef`) pour l'interface.
 */

import * as crypto from 'crypto';
import type { ContentType } from '../../contracts/types';

export function refHashFor(contentType: ContentType, providerIdOrKey: string): string {
  return crypto
    .createHash('sha256')
    .update('ref/' + contentType + '/' + providerIdOrKey)
    .digest()
    .slice(0, 16)
    .toString('hex');
}

/** Référence opaque exposée à l'interface : version d'index + secteur + empreinte tronquée. */
export function detailRefFor(indexVersion: number, ordinal: number, refHash: string): string {
  return 'v' + indexVersion + ':' + ordinal + ':' + refHash.slice(0, 8);
}
