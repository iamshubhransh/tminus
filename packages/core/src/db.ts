import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from './paths.ts';
import { MIGRATIONS } from './schema.ts';

const require = createRequire(import.meta.url);

export interface RunResult { changes: number; lastInsertRowid: number | bigint }
export interface Stmt {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}
export interface DB {
  driver: 'bun:sqlite' | 'node:sqlite';
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  transaction<T>(fn: () => T): T;
  close(): void;
}

type Raw = { exec(sql: string): unknown; prepare(sql: string): any; close(): void };

function openRaw(file: string): { raw: Raw; driver: DB['driver'] } {
  if (typeof (globalThis as any).Bun !== 'undefined') {
    const { Database } = require('bun:sqlite');
    return { raw: new Database(file, { create: true }), driver: 'bun:sqlite' };
  }
  let DatabaseSync: any;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error(`tminus needs Bun (https://bun.sh) or Node 22.13+ for its built-in SQLite; this is Node ${process.versions.node}.`);
  }
  return { raw: new DatabaseSync(file), driver: 'node:sqlite' };
}

/** Normalise params: drivers disagree on undefined and booleans. */
function norm(params: unknown[]): unknown[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

export function openDb(file: string = paths.db): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const { raw, driver } = openRaw(file);
  const cache = new Map<string, any>();
  let depth = 0;
  const db: DB = {
    driver,
    exec: (sql) => { raw.exec(sql); },
    prepare(sql) {
      let s = cache.get(sql);
      if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
      return {
        run: (...p) => s.run(...norm(p)) as RunResult,
        get: (...p) => s.get(...norm(p)) ?? undefined,
        all: (...p) => s.all(...norm(p)),
      };
    },
    transaction(fn) {
      if (depth > 0) return fn();
      depth++;
      raw.exec('BEGIN');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        try { raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      } finally {
        depth--;
      }
    },
    close: () => raw.close(),
  };
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function schemaVersion(db: DB): number {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  return row ? Number(row.value) : 0;
}

export function migrate(db: DB): number {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
  let v = schemaVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= v) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(m.version));
    });
    v = m.version;
  }
  return v;
}

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key);
  return row ? String(row.value) : null;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}
