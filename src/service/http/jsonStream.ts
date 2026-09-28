/**
 * Parseur JSON incrémental (§5.1 : « ne jamais appeler `JSON.parse()` sur une réponse entière
 * potentiellement géante ni conserver tous les objets en mémoire »).
 *
 * Le parseur est un automate : il reçoit des fragments de texte et émet chaque **valeur complète**
 * (objet/tableau/scalaire) dès qu'elle est terminée. Seule la valeur en cours est matérialisée :
 * pour un tableau de 250 000 objets, la mémoire reste celle d'un objet à la fois.
 *
 * Il ne fait aucune confiance à la source : une réponse 200 n'est pas supposée être du JSON valide
 * (§5.1) ; fin prématurée, littéraux invalides et structures incohérentes lèvent une erreur typée.
 *
 * Grammaire d'états :
 *   tableau : 'valeur' ─▸ 'virgule-ou-fin'
 *   objet   : 'cle' ─▸ 'deux-points' ─▸ 'valeur' ─▸ 'virgule-ou-fin'
 */

import { AppError } from '../../contracts/errors';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface JsonStreamOptions {
  /**
   * Appelé pour chaque valeur de premier niveau terminée : la racine si c'est un objet, ou
   * **chaque élément du tableau racine** au moment où il se termine (les éléments ne sont pas
   * accumulés — c'est l'intérêt du flux, §5.1).
   */
  onTopLevelValue?: (value: JsonValue, index: number) => void;
  /** appelé pour chaque valeur terminée, à toute profondeur */
  onValue?: (value: JsonValue, depth: number) => void;
  /** appelé pour chaque clé d'objet de premier niveau (utile pour repérer `user_info`) */
  onRootKey?: (key: string, value: JsonValue) => void;
  /**
   * Accumule aussi les éléments du tableau racine dans `root`. Réservé aux **petites** réponses
   * (catégories, détails de série, `player_api.php` de test) : sur un flux de catalogue, laisser
   * `false` pour que la mémoire ne dépende pas de la taille de la réponse (§5.1).
   */
  collectRootArray?: boolean;
}

type Expect = 'value' | 'key' | 'colon' | 'comma-or-end';

interface Frame {
  kind: 'object' | 'array';
  value: { [key: string]: JsonValue } | JsonValue[];
  key: string | null;
  expect: Expect;
}

const WS = [0x20, 0x09, 0x0a, 0x0d];
const LITERALS = ['true', 'false', 'null'];

export class IncrementalJsonParser {
  private readonly stack: Frame[] = [];
  private rootValue: JsonValue | undefined;
  private rootStarted = false;
  private rootDone = false;
  private topLevelIndex = 0;
  private token = '';
  private tokenKind: 'string' | 'number' | 'literal' | null = null;
  private escaping = false;
  private bytes = 0;
  /** Suivi des clés d'objet racine, pour `player_api.php` (objet `user_info`, `server_info`…). */
  private rootKeys = 0;

  constructor(private readonly options: JsonStreamOptions = {}) {}

  get bytesConsumed(): number {
    return this.bytes;
  }

  get rootComplete(): boolean {
    return this.rootDone;
  }

  get root(): JsonValue | undefined {
    return this.rootValue;
  }

  push(chunk: string | Buffer): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.bytes += Buffer.byteLength(text, 'utf8');
    for (let i = 0; i < text.length; i++) {
      this.step(text.charCodeAt(i), text[i]);
    }
  }

  /** Fin de flux : lève si une valeur est incomplète (jamais de succès silencieux). */
  finish(): void {
    if (this.tokenKind === 'string') throw new AppError('provider/badResponse', 'reponse JSON tronquee dans une chaine');
    if (this.tokenKind !== null) this.commitToken();
    if (!this.rootDone) {
      if (!this.rootStarted) throw new AppError('provider/badResponse', 'reponse vide alors qu un JSON etait attendu');
      throw new AppError('provider/badResponse', 'reponse JSON tronquee');
    }
  }

  /* ------------------------------------------------------------------ interne */

  private step(code: number, char: string): void {
    if (this.tokenKind === 'string') {
      this.consumeString(char);
      return;
    }
    if (this.tokenKind !== null) {
      if (isDelimiter(char)) {
        this.commitToken();
        this.step(code, char);
        return;
      }
      this.token += char;
      return;
    }
    if (WS.indexOf(code) !== -1) return;
    if (this.rootDone && this.stack.length === 0) {
      throw new AppError('provider/badResponse', 'contenu apres la fin d une valeur JSON de premier niveau');
    }
    switch (char) {
      case '"':
        this.token = '';
        this.tokenKind = 'string';
        this.escaping = false;
        return;
      case '{':
        this.openContainer('object');
        return;
      case '[':
        this.openContainer('array');
        return;
      case '}':
        this.closeContainer('object');
        return;
      case ']':
        this.closeContainer('array');
        return;
      case ':':
        this.expectColon();
        return;
      case ',':
        this.expectComma();
        return;
      default:
        if (/[0-9+\-.]/.test(char)) {
          this.tokenKind = 'number';
          this.token = char;
          return;
        }
        if (/[a-zA-Z]/.test(char)) {
          this.tokenKind = 'literal';
          this.token = char;
          return;
        }
        throw new AppError('provider/badResponse', 'caractere inattendu dans la reponse JSON');
    }
  }

  private consumeString(char: string): void {
    if (this.escaping) {
      this.escaping = false;
      this.token += char;
      return;
    }
    if (char === '\\') {
      this.escaping = true;
      this.token += char;
      return;
    }
    if (char === '"') {
      const value = decodeJsonString(this.token);
      this.token = '';
      this.tokenKind = null;
      this.handleValue(value, true);
      return;
    }
    this.token += char;
  }

  private commitToken(): void {
    const kind = this.tokenKind;
    const raw = this.token.trim();
    this.token = '';
    this.tokenKind = null;
    if (kind === 'number') {
      if (raw === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw)) {
        throw new AppError('provider/badResponse', 'nombre invalide dans la reponse JSON');
      }
      this.handleValue(Number(raw), false);
      return;
    }
    const literal = LITERALS.indexOf(raw);
    if (literal === -1) throw new AppError('provider/badResponse', 'literal JSON invalide dans la reponse');
    this.handleValue(literal === 0 ? true : literal === 1 ? false : null, false);
  }

  private openContainer(kind: 'object' | 'array'): void {
    const frame = this.currentFrame();
    if (frame) {
      if (frame.expect === 'key') throw new AppError('provider/badResponse', 'objet trouve la ou une cle est attendue');
      if (frame.expect === 'comma-or-end') throw new AppError('provider/badResponse', 'valeur sans virgule dans la reponse JSON');
    }
    if (this.rootDone && this.stack.length === 0) {
      throw new AppError('provider/badResponse', 'plusieurs valeurs racine dans la reponse JSON');
    }
    this.stack.push({
      kind,
      value: kind === 'object' ? {} : [],
      key: null,
      expect: kind === 'object' ? 'key' : 'value'
    });
  }

  private closeContainer(kind: 'object' | 'array'): void {
    const frame = this.stack.pop();
    if (!frame) throw new AppError('provider/badResponse', 'fermeture sans ouverture dans la reponse JSON');
    if (frame.kind !== kind) throw new AppError('provider/badResponse', 'fermeture incoherente dans la reponse JSON');
    if (kind === 'object' && frame.expect !== 'key' && frame.expect !== 'comma-or-end') {
      throw new AppError('provider/badResponse', 'objet JSON incomplet (valeur manquante)');
    }
    this.handleValue(frame.value as JsonValue, false);
  }

  private expectColon(): void {
    const frame = this.currentFrame();
    if (!frame || frame.kind !== 'object' || frame.expect !== 'colon') {
      throw new AppError('provider/badResponse', 'deux-points inattendu dans la reponse JSON');
    }
    frame.expect = 'value';
  }

  private expectComma(): void {
    const frame = this.currentFrame();
    if (!frame || frame.expect !== 'comma-or-end') {
      throw new AppError('provider/badResponse', 'virgule inattendue dans la reponse JSON');
    }
    frame.expect = frame.kind === 'object' ? 'key' : 'value';
  }

  private currentFrame(): Frame | undefined {
    return this.stack[this.stack.length - 1];
  }

  private handleValue(value: JsonValue, fromString: boolean): void {
    const frame = this.currentFrame();
    if (!frame) {
      if (this.rootDone) throw new AppError('provider/badResponse', 'valeur racine en double');
      this.rootStarted = true;
      this.rootValue = value;
      this.rootDone = true;
      if (this.options.onTopLevelValue) this.options.onTopLevelValue(value, this.topLevelIndex++);
      return;
    }
    if (frame.kind === 'object' && frame.expect === 'key') {
      if (!fromString) throw new AppError('provider/badResponse', 'cle d objet JSON non textuelle');
      frame.key = value as string;
      frame.expect = 'colon';
      return;
    }
    if (frame.expect !== 'value') {
      throw new AppError('provider/badResponse', fromString ? 'chaine inattendue dans la reponse JSON' : 'valeur inattendue dans la reponse JSON');
    }
    if (this.options.onValue) this.options.onValue(value, this.stack.length);
    if (frame.kind === 'array') {
      if (this.stack.length === 1) {
        // Tableau **racine** : chaque élément est livré dès qu'il est complet ; il n'est conservé que
        // si l'appelant l'a demandé (`collectRootArray`). C'est ce qui rend l'ingestion d'un
        // catalogue réellement « au fil de l'eau » (§5.1) : la mémoire ne dépend pas de la taille
        // de la réponse, seulement de l'élément courant.
        frame.expect = 'comma-or-end';
        if (this.options.collectRootArray) (frame.value as JsonValue[]).push(value);
        if (this.options.onTopLevelValue) this.options.onTopLevelValue(value, this.topLevelIndex++);
        return;
      }
      (frame.value as JsonValue[]).push(value);
      frame.expect = 'comma-or-end';
      return;
    }
    const key = frame.key as string;
    (frame.value as { [key: string]: JsonValue })[key] = value;
    frame.key = null;
    frame.expect = 'comma-or-end';
    if (this.stack.length === 1 && this.options.onRootKey) {
      this.options.onRootKey(key, value);
      this.rootKeys += 1;
    }
  }
}

function isDelimiter(char: string): boolean {
  return char === '"' || char === '{' || char === '[' || char === '}' || char === ']' || char === ':' || char === ',' || /\s/.test(char);
}

/** Décodage d'une chaîne JSON échappée (`\uXXXX` et paires de substitution compris). */
export function decodeJsonString(raw: string): string {
  if (raw.indexOf('\\') === -1) return raw;
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = raw[++i];
    switch (next) {
      case '"':
        out += '"';
        break;
      case '\\':
        out += '\\';
        break;
      case '/':
        out += '/';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case 'n':
        out += '\n';
        break;
      case 'r':
        out += '\r';
        break;
      case 't':
        out += '\t';
        break;
      case 'u': {
        const hex = raw.substr(i + 1, 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new AppError('provider/badResponse', 'echappement unicode invalide');
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        out += next === undefined ? '' : next;
    }
  }
  return out;
}

/** Réponse courte : analyse complète, avec plafond explicite (jamais de parse d'un document géant). */
export function parseJsonDocument(text: string, maxBytes: number = 1024 * 1024): JsonValue | undefined {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new AppError('provider/badResponse', 'document JSON au-dela du plafond autorise pour ce cas');
  }
  const parser = new IncrementalJsonParser();
  parser.push(text);
  parser.finish();
  return parser.root;
}
