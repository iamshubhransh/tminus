import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeCode, codex, claudeSettingsPath, codexHooksPath } from '@tminus/adapters';
import { claudeDir, codexDir, paths } from '@tminus/core';

const CMD = `'/opt/bun' '/home/u/.tminus/bin/tminus.js'`;

function reset() {
  rmSync(claudeDir(), { recursive: true, force: true });
  rmSync(codexDir(), { recursive: true, force: true });
  rmSync(paths.install, { force: true });
  mkdirSync(claudeDir(), { recursive: true });
  mkdirSync(codexDir(), { recursive: true });
}

const ORIGINALS: Record<string, string | null> = {
  'no file': null,
  'empty object': '{}\n',
  'existing statusline + hooks, 2-space': JSON.stringify({
    model: 'opus',
    statusLine: { type: 'command', command: 'ccstatusline', padding: 0 },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] }] },
    enabledPlugins: { 'x@y': true },
  }, null, 2) + '\n',
  'tabs, no trailing newline, unicode': '{\n\t"theme": "dark",\n\t"note": "café ✓"\n}',
  'empty hooks key kept': JSON.stringify({ hooks: {} }, null, 4) + '\n',
};

describe('Claude Code install/uninstall round trip', () => {
  beforeEach(reset);

  for (const [name, original] of Object.entries(ORIGINALS)) {
    test(`byte-identical after uninstall: ${name}`, async () => {
      const file = claudeSettingsPath();
      if (original !== null) writeFileSync(file, original);
      const res = await claudeCode.install({ tminusCommand: CMD });
      expect(res.changes.length).toBe(1);
      const installed = JSON.parse(readFileSync(file, 'utf8'));
      expect(installed.hooks.UserPromptSubmit.at(-1).hooks[0].command).toBe(`${CMD} hook UserPromptSubmit`);
      expect(installed.hooks.Stop.at(-1).hooks[0].async).toBe(true);
      // Idempotent: a second install changes nothing.
      expect((await claudeCode.install({ tminusCommand: CMD, dryRun: true })).changes).toEqual([]);
      await claudeCode.uninstall();
      if (original === null) {
        // We created the file, so uninstall removes it again.
        expect(existsSync(file)).toBe(false);
      } else {
        expect(readFileSync(file, 'utf8')).toBe(original);
      }
    });
  }

  test('an existing statusline is wrapped, not replaced, and comes back on uninstall', async () => {
    const file = claudeSettingsPath();
    writeFileSync(file, ORIGINALS['existing statusline + hooks, 2-space']!);
    await claudeCode.install({ tminusCommand: CMD });
    const s = JSON.parse(readFileSync(file, 'utf8'));
    expect(s.statusLine.command).toBe(`${CMD} render --statusline --wrap`);
    expect(s.statusLine.refreshInterval).toBeUndefined(); // wrapping keeps the user's refresh behaviour
    expect(s.hooks.PreToolUse[0]).toEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard.sh' }] });
    const manifest = JSON.parse(readFileSync(paths.install, 'utf8'));
    expect(manifest['claude-code'].detail.wrapped.command).toBe('ccstatusline');
    await claudeCode.uninstall();
    expect(JSON.parse(readFileSync(file, 'utf8')).statusLine.command).toBe('ccstatusline');
  });

  test('re-running install after the user edits settings keeps their edit and the original for uninstall', async () => {
    const file = claudeSettingsPath();
    const original = ORIGINALS['existing statusline + hooks, 2-space']!;
    writeFileSync(file, original);
    await claudeCode.install({ tminusCommand: CMD });
    const edited = JSON.parse(readFileSync(file, 'utf8'));
    edited.theme = 'light';
    writeFileSync(file, JSON.stringify(edited, null, 2) + '\n');
    await claudeCode.install({ tminusCommand: CMD });
    await claudeCode.uninstall();
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.theme).toBe('light');
    expect(after.statusLine.command).toBe('ccstatusline');
    expect(JSON.stringify(after.hooks)).not.toContain('tminus');
  });

  test('Node installs (tminus.mjs) are recognised and fully removed too', async () => {
    const file = claudeSettingsPath();
    const original = ORIGINALS['existing statusline + hooks, 2-space']!;
    writeFileSync(file, original);
    const nodeCmd = `'/usr/local/bin/node' '/home/u/.tminus/bin/tminus.mjs'`;
    await claudeCode.install({ tminusCommand: nodeCmd });
    expect((await claudeCode.installed()).hooks).toBe(true);
    await claudeCode.uninstall();
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  test('the statusline uses the render-only entry when one is installed', async () => {
    const renderCmd = `'/opt/bun' '/home/u/.tminus/bin/tminus-render.js' render`;
    await claudeCode.install({ tminusCommand: CMD, renderCommand: renderCmd });
    const s = JSON.parse(readFileSync(claudeSettingsPath(), 'utf8'));
    expect(s.statusLine.command).toBe(`${renderCmd} --statusline`);
    expect((await claudeCode.installed()).statusline).toBe(true);
    await claudeCode.uninstall();
    expect(existsSync(claudeSettingsPath())).toBe(false);
  });

  test('refuses to touch invalid JSON', async () => {
    writeFileSync(claudeSettingsPath(), '{ not json');
    await expect(claudeCode.install({ tminusCommand: CMD })).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(claudeSettingsPath(), 'utf8')).toBe('{ not json');
  });
});

describe('Codex install/uninstall round trip', () => {
  beforeEach(reset);

  test('creates hooks.json and removes it again', async () => {
    const res = await codex.install({ tminusCommand: CMD });
    expect(res.notes.join(' ')).toContain('/hooks');
    const h = JSON.parse(readFileSync(codexHooksPath(), 'utf8'));
    expect(Object.keys(h)).toEqual(['hooks']);
    expect(h.hooks.UserPromptSubmit[0].hooks[0].command).toBe(`${CMD} hook --agent codex UserPromptSubmit`);
    await codex.uninstall();
    expect(existsSync(codexHooksPath())).toBe(false);
  });

  test('existing hooks.json is restored byte for byte', async () => {
    const original = JSON.stringify({ description: 'mine', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }] } }, null, 2) + '\n';
    writeFileSync(codexHooksPath(), original);
    await codex.install({ tminusCommand: CMD });
    await codex.uninstall();
    expect(readFileSync(codexHooksPath(), 'utf8')).toBe(original);
  });
});

void join;
