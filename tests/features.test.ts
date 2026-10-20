import { describe, expect, test } from 'bun:test';
import { buildFeatures, classifyIntent, normalizeModel, promptFeatures, rollingMedian, type Intent } from '@tminus/core';

describe('intent classifier', () => {
  const cases: [string, Intent][] = [
    ['explain how the auth middleware works', 'explain'],
    ['what does this function return?', 'question'],
    ['fix the crash when the user logs out', 'fix'],
    ["the build is failing with a type error, can you look", 'fix'],
    ['rename the button label to "Save"', 'small_edit'],
    ['make these center aligned', 'small_edit'],
    ['refactor the payment module into smaller services', 'refactor'],
    ['build a settings page with a form and validation', 'build_feature'],
    ['implement OAuth login end-to-end', 'build_feature'],
    ['add unit tests for the parser', 'test'],
    ['review my PR for security issues', 'review'],
    ['/code-review high', 'review'],
    ['continue', 'other'],
    ['', 'other'],
  ];
  for (const [prompt, intent] of cases) {
    test(`${JSON.stringify(prompt)} -> ${intent}`, () => expect(classifyIntent(prompt)).toBe(intent));
  }

  test('a question asking for an edit is an edit, not a question', () => {
    expect(classifyIntent('can you add a retry to the fetch call?')).not.toBe('question');
  });
});

describe('prompt features', () => {
  test('counts words, refs, scope words and images', () => {
    const f = promptFeatures('Update `parseArgs` in src/cli/args.ts and packages/core/index.ts across all files [Image #1]');
    expect(f.words).toBe(11);
    expect(f.refs).toBeGreaterThanOrEqual(3);
    expect(f.scope).toBe(true);
    expect(f.images).toBe(1);
    expect(f.question).toBe(false);
  });

  test('urls are not counted as file paths', () => {
    const f = promptFeatures('look at https://example.com/a/b/c please');
    expect(f.urls).toBe(1);
    expect(f.refs).toBe(0);
  });

  test('empty prompt', () => {
    const f = promptFeatures('');
    expect(f).toMatchObject({ chars: 0, words: 0, intent: 'other', refs: 0, scope: false });
  });
});

describe('session features', () => {
  test('rolling median of the last 3 turns', () => {
    expect(rollingMedian([1000, 5000, 2000, 4000])).toBe(4000);
    expect(rollingMedian([1000, 3000])).toBe(2000);
    expect(rollingMedian([])).toBeNull();
  });

  test('model ids are normalised', () => {
    expect(normalizeModel('claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
    expect(normalizeModel('Claude-Sonnet-4-20250514')).toBe('claude-sonnet-4');
    expect(normalizeModel(null)).toBeNull();
  });

  test('buildFeatures carries version, time and session context, never prompt text', () => {
    const at = new Date('2026-10-20T09:30:00').getTime();
    const f = buildFeatures('fix the login bug', at, 'human', { model: 'claude-opus-5-5', effort: 'high', turnIndex: 4, recentActiveMs: [10_000, 20_000, 30_000] });
    expect(f.v).toBe(1);
    expect(f.time.hour).toBe(9);
    expect(f.session.recentMedianMs).toBe(20_000);
    expect(JSON.stringify(f)).not.toContain('login');
  });
});
