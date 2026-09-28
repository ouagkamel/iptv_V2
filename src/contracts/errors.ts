/**
 * Codes d'erreur normalisés (§7.2 complété par §15.4).
 *
 * Contrainte : un message d'erreur ne contient **jamais** d'URL de flux, d'identifiant ni de
 * token. Les helpers de ce module construisent le message à partir d'éléments sûrs
 * (code HTTP, hôte public, phase d'import) et rejettent toute chaîne contenant un secret.
 */

export type ErrorCode =
  /* index / catalogue */
  | 'catalog/indexChanged'
  | 'catalog/quotaExceeded'
  | 'catalog/corrupt'
  | 'catalog/busy'
  | 'catalog/notFound'
  | 'catalog/indexMissing'
  /* réseau */
  | 'network/timeout'
  | 'network/dns'
  | 'network/tls'
  | 'network/refused'
  | 'network/http'
  | 'network/redirectRejected'
  | 'network/tooManyRedirects'
  /* authentification et fournisseur */
  | 'auth/invalidCredentials'
  | 'auth/expired'
  | 'auth/tooManyConnections'
  | 'provider/badResponse'
  | 'provider/unsupported'
  /* profil et sécurité */
  | 'profile/invalid'
  | 'profile/consentRequired'
  | 'security/privateHost'
  | 'security/insecureScheme'
  /* lecteur */
  | 'player/resolveFailed'
  | 'player/timeout'
  | 'player/mediaError'
  | 'player/cancelled'
  /* interne */
  | 'internal/unexpected'
  | 'internal/cancelled';

export const RETRYABLE: Record<ErrorCode, boolean> = {
  'catalog/indexChanged': true,
  'catalog/quotaExceeded': false,
  'catalog/corrupt': false,
  'catalog/busy': true,
  'catalog/notFound': false,
  'catalog/indexMissing': false,
  'network/timeout': true,
  'network/dns': true,
  'network/tls': false,
  'network/refused': true,
  'network/http': true,
  'network/redirectRejected': false,
  'network/tooManyRedirects': false,
  'auth/invalidCredentials': false,
  'auth/expired': false,
  'auth/tooManyConnections': true,
  'provider/badResponse': false,
  'provider/unsupported': false,
  'profile/invalid': false,
  'profile/consentRequired': false,
  'security/privateHost': false,
  'security/insecureScheme': false,
  'player/resolveFailed': true,
  'player/timeout': true,
  'player/mediaError': true,
  'player/cancelled': false,
  'internal/unexpected': true,
  'internal/cancelled': false
};

export interface AppErrorShape {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  hint?: string;
}

/** Formes qui ne doivent jamais sortir de l'application (revue de code + tests). */
const SECRET_PATTERNS: RegExp[] = [
  // clé ET valeur : un token laissé « à moitié » masqué reste un secret
  /[?&](?:username|password|token|token2|user|pass|api_?key|auth|key)=[^&\s]*/gi,
  /:\/\/[^/\s]+:[^/@\s]+@/, // userinfo
  /\bhttps?:\/\/\S{40,}/i, // URL longue, potentiellement porteuse d'identifiants
  /\b(?:[A-Za-z0-9+/]{40,}={0,2})\b/ // segment base64 long
];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(AppError.sanitize(message));
    this.name = 'AppError';
    this.code = code;
    this.retryable = RETRYABLE[code];
    if (hint !== undefined) this.hint = AppError.sanitize(hint);
  }

  toShape(): AppErrorShape {
    const shape: AppErrorShape = {
      code: this.code,
      message: this.message,
      retryable: this.retryable
    };
    if (this.hint !== undefined) shape.hint = this.hint;
    return shape;
  }

  /** Remplace tout fragment ressemblant à un secret par un marqueur neutre. */
  static sanitize(message: string): string {
    let out = message;
    for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
    return out.slice(0, 300);
  }
}

export function appError(code: ErrorCode, message: string, hint?: string): AppError {
  return new AppError(code, message, hint);
}

export function isAppError(value: unknown): value is AppError {
  return typeof value === 'object' && value !== null && (value as { name?: string }).name === 'AppError';
}

/** Convertit une exception quelconque en forme sûre, sans fuite de détail interne. */
export function toShape(err: unknown): AppErrorShape {
  if (isAppError(err)) return err.toShape();
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return { code: 'internal/unexpected', message: AppError.sanitize(message), retryable: true };
}
