import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import {
  GbdtPredictor, loadConfig, loadPredictor, openDb, paths, predictorStatus, saveConfig, setMeta, trainGbdt, buildFeatures,
  writeJsonAtomic,
} from '@tminus/core';

beforeEach(() => {
  rmSync(paths.config, { force: true });
  rmSync(paths.modelV2, { force: true });
});

describe('config', () => {
  test('v2 is the default predictor', () => {
    expect(loadConfig().predictor).toBe('v2');
  });

  test('only explicit settings are written, so defaults can improve later', () => {
    saveConfig({ color: false });
    expect(JSON.parse(readFileSync(paths.config, 'utf8'))).toEqual({ color: false });
    expect(loadConfig()).toMatchObject({ color: false, predictor: 'v2', doneLingerSec: 10 });
  });
});

describe('predictor selection', () => {
  const tinyModel = () => {
    const feats = Array.from({ length: 80 }, (_, i) => buildFeatures(i % 2 ? 'fix the bug' : 'build a page', i, 'human', { model: 'm1' }));
    return trainGbdt(feats.map((features, i) => ({ features, activeMs: 30_000 + (i % 7) * 10_000, agent: 'claude-code', submittedAt: i })), { rounds: 10, live: false });
  };

  test('default v2 falls back to v1 until v2 has won an evaluation', () => {
    const db = openDb(':memory:');
    expect(predictorStatus(db, loadConfig()).active).toBe('v1');
    expect(loadPredictor(db, loadConfig()).version).toBe('v1');
  });

  test('uses v2 once it is eligible and the model file is valid', () => {
    const db = openDb(':memory:');
    writeJsonAtomic(paths.modelV2, tinyModel());
    setMeta(db, 'v2_eligible', '1');
    expect(predictorStatus(db, loadConfig()).active).toBe('v2');
    expect(loadPredictor(db, loadConfig())).toBeInstanceOf(GbdtPredictor);
  });

  test('an explicit v1 setting wins; an old-format model file is ignored', () => {
    const db = openDb(':memory:');
    setMeta(db, 'v2_eligible', '1');
    writeJsonAtomic(paths.modelV2, { version: 'v2', quantiles: [] });
    expect(loadPredictor(db, loadConfig()).version).toBe('v1');
    writeJsonAtomic(paths.modelV2, tinyModel());
    saveConfig({ predictor: 'v1' });
    expect(predictorStatus(db, loadConfig())).toEqual({ active: 'v1', reason: 'set to v1 in config' });
  });
});
