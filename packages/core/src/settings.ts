import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { paths } from './paths.ts';
import { writeJsonAtomic } from './state.ts';

/**
 * Helpers for editing other tools' JSON config files safely: we keep the
 * original bytes, preserve indentation, and record what we changed so
 * uninstall can put things back exactly.
 */

export function readText(file: string): string | null {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

export function detectIndent(text: string | null): string | number {
  if (!text) return 2;
  const m = text.match(/^[{[]\s*\n([ \t]+)\S/);
  if (!m) return 2;
  return m[1].includes('\t') ? '\t' : m[1].length;
}

export function stringifyLike(original: string | null, value: unknown): string {
  const out = JSON.stringify(value, null, detectIndent(original));
  const trailing = original == null || original.endsWith('\n') ? '\n' : '';
  return out + trailing;
}

/** Copy a file into ~/.tminus/backups with a timestamp. Returns the backup path (or null if no file). */
export function backupFile(file: string, tag: string): string | null {
  if (!existsSync(file)) return null;
  mkdirSync(paths.backupsDir, { recursive: true });
  const dest = join(paths.backupsDir, `${tag}.${basename(file)}.${new Date().toISOString().replace(/[:.]/g, '-')}`);
  copyFileSync(file, dest);
  return dest;
}

export function writeFilePreserving(file: string, content: string): void {
  writeFileSync(file, content);
}

/** Deep structural equality for JSON values (key order insensitive). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => jsonEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => jsonEqual((a as any)[k], (b as any)[k]));
}

/** Install manifest: what we changed, per agent, with the original bytes. */
export interface InstallRecord {
  agent: string;
  file: string;
  installedAt: string;
  /** Original file content (null = we created the file). */
  original: string | null;
  backup: string | null;
  /** Agent-specific details (e.g. the statusline we wrapped). */
  detail: Record<string, unknown>;
}

export function readInstallManifest(): Record<string, InstallRecord> {
  try { return JSON.parse(readFileSync(paths.install, 'utf8')); } catch { return {}; }
}

export function writeInstallManifest(m: Record<string, InstallRecord>): void {
  writeJsonAtomic(paths.install, m);
}
