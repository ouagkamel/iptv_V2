/**
 * Petits utilitaires fichiers du service.
 *
 * Node 8.12 n'offre pas `fs.mkdirSync(dir, {recursive:true})` (Node 10.12) ni `fs.promises` : les
 * helpers ci-dessous sont volontairement synchrones et sans dépendance, écrits une seule fois pour
 * tout le service (répertoire privé, staging, purge).
 */

import * as fs from 'fs';
import * as path from 'path';

export function mkdirRecursive(target: string): void {
  if (target === '' || fs.existsSync(target)) return;
  const parent = path.dirname(target);
  if (parent !== target && !fs.existsSync(parent)) mkdirRecursive(parent);
  try {
    fs.mkdirSync(target);
  } catch (error) {
    if (!fs.existsSync(target)) throw error;
  }
}

/** Liste d'un répertoire, sans exception si le répertoire n'existe pas encore. */
export function listDir(target: string): string[] {
  try {
    return fs.readdirSync(target);
  } catch (_error) {
    return [];
  }
}

export function removeFileIfExists(target: string): boolean {
  try {
    fs.unlinkSync(target);
    return true;
  } catch (_error) {
    return false;
  }
}

/** Supprime un répertoire et son contenu, best-effort (jamais d'exception remontée). */
export function removeTree(target: string): void {
  listDir(target).forEach((name) => {
    const full = path.join(target, name);
    let directory = false;
    try {
      directory = fs.statSync(full).isDirectory();
    } catch (_error) {
      return;
    }
    if (directory) removeTree(full);
    else removeFileIfExists(full);
  });
  try {
    fs.rmdirSync(target);
  } catch (_error) {
    // répertoire déjà absent ou non vide (fichier verrouillé) : on ne bloque pas l'appelant
  }
}

export function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch (_error) {
    return false;
  }
}
