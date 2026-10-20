import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { hashPath } from './features.ts';
import { paths } from './paths.ts';
import { writeJsonAtomic } from './state.ts';

const DAY = 24 * 60 * 60 * 1000;

const LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.swift': 'swift', '.kt': 'kotlin', '.java': 'java',
  '.rb': 'ruby', '.php': 'php', '.cs': 'csharp', '.cpp': 'cpp', '.cc': 'cpp', '.c': 'c', '.h': 'c',
  '.m': 'objc', '.mm': 'objc', '.dart': 'dart', '.ex': 'elixir', '.exs': 'elixir', '.scala': 'scala',
  '.vue': 'vue', '.svelte': 'svelte', '.astro': 'astro', '.lua': 'lua', '.sh': 'shell', '.zsh': 'shell',
  '.css': 'css', '.scss': 'css', '.html': 'html', '.sql': 'sql', '.ipynb': 'python', '.md': 'markdown', '.mdx': 'markdown',
};

export interface RepoInfo { files: number | null; language: string | null; at: number }

type Cache = Record<string, RepoInfo>;

function loadCache(): Cache {
  try { return JSON.parse(readFileSync(paths.repoCache, 'utf8')); } catch { return {}; }
}

/** Tracked file count + dominant language, cached per repo (keyed by path hash) and refreshed daily. */
export function repoInfo(cwd: string | null | undefined, now = Date.now()): RepoInfo {
  const key = hashPath(cwd);
  if (!cwd || !key) return { files: null, language: null, at: now };
  const cache = loadCache();
  const hit = cache[key];
  if (hit && now - hit.at < DAY) return hit;
  const info = scan(cwd, now);
  cache[key] = info;
  try { writeJsonAtomic(paths.repoCache, cache); } catch { /* cache is best effort */ }
  return info;
}

function scan(cwd: string, now: number): RepoInfo {
  if (!existsSync(cwd)) return { files: null, language: null, at: now };
  const r = spawnSync('git', ['ls-files', '-z'], { cwd, timeout: 3000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  if (r.status !== 0 || typeof r.stdout !== 'string') return { files: null, language: null, at: now };
  const files = r.stdout.split('\0').filter(Boolean);
  const counts = new Map<string, number>();
  for (const f of files) {
    const lang = LANG[extname(f).toLowerCase()];
    if (lang && lang !== 'markdown') counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  let language: string | null = null;
  let best = 0;
  for (const [l, n] of counts) if (n > best) { best = n; language = l; }
  return { files: files.length, language, at: now };
}
