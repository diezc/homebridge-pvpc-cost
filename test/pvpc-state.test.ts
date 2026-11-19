import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { classifyBand, computeDerivedState } from '../src/pvpc-state.js';
import { PLUGIN_VERSION } from '../src/settings.js';
import { getMadridHourKey, getTomorrowRefreshDelayMs } from '../src/time.js';

test('getMadridHourKey selects current hour in Europe/Madrid timezone', () => {
  const winterUtc = new Date('2026-01-15T10:45:00.000Z');
  const summerUtc = new Date('2026-06-22T10:45:00.000Z');

  assert.equal(getMadridHourKey(winterUtc), '2026-01-15T11:00');
  assert.equal(getMadridHourKey(summerUtc), '2026-06-22T12:00');
});

test('classifyBand applies cheap, normal, and expensive thresholds', () => {
  assert.equal(classifyBand(0.09, 0.10, 0.15), 'cheap');
  assert.equal(classifyBand(0.12, 0.10, 0.15), 'normal');
  assert.equal(classifyBand(0.16, 0.10, 0.15), 'expensive');
});

test('computeDerivedState finds the next cheap hour', () => {
  const now = new Date('2026-06-22T08:15:00.000Z');
  const hourlyPrices = {
    '2026-06-22T08:00:00.000Z': 0.18,
    '2026-06-22T09:00:00.000Z': 0.16,
    '2026-06-22T10:00:00.000Z': 0.13,
    '2026-06-22T11:00:00.000Z': 0.09,
    '2026-06-22T12:00:00.000Z': 0.08,
    '2026-06-22T13:00:00.000Z': 0.11,
    '2026-06-22T14:00:00.000Z': 0.21,
    '2026-06-23T07:00:00.000Z': 0.07,
  };

  const state = computeDerivedState(
    hourlyPrices,
    now,
    0.10,
    0.15,
    15,
    new Date('2026-06-22T08:10:00.000Z'),
  );

  assert.equal(state.currentHourKey, '2026-06-22T10:00');
  assert.equal(state.currentPrice, 0.18);
  assert.equal(state.currentBand, 'expensive');
  assert.equal(state.isCheapNow, false);
  assert.equal(state.isExpensiveNow, true);
  assert.equal(state.nextCheapStart, '2026-06-22T13:00');
  assert.equal(state.stale, false);
});

test('computeDerivedState marks data stale when current hour is missing', () => {
  const state = computeDerivedState(
    {
      '2026-06-22T07:00:00.000Z': 0.11,
    },
    new Date('2026-06-22T08:15:00.000Z'),
    0.10,
    0.15,
    15,
    new Date('2026-06-22T08:10:00.000Z'),
  );

  assert.equal(state.currentHourKey, '2026-06-22T10:00');
  assert.equal(state.currentPrice, null);
  assert.equal(state.stale, true);
  assert.equal(state.staleReason, 'missing_current_hour');
});

test('computeDerivedState treats invalid current hour values as stale', () => {
  const state = computeDerivedState(
    {
      '2026-06-22T08:00:00.000Z': Number.NaN,
      '2026-06-22T09:00:00.000Z': 0.11,
    },
    new Date('2026-06-22T08:15:00.000Z'),
    0.10,
    0.15,
    15,
    new Date('2026-06-22T08:10:00.000Z'),
  );

  assert.equal(state.currentPrice, null);
  assert.equal(state.currentBand, null);
  assert.equal(state.stale, true);
});

test('getTomorrowRefreshDelayMs schedules next-day refresh after cutoff', () => {
  const beforeCutoff = getTomorrowRefreshDelayMs(new Date('2026-06-22T18:29:00.000Z'));
  const afterCutoff = getTomorrowRefreshDelayMs(new Date('2026-06-22T18:31:00.000Z'));

  assert.equal(beforeCutoff, 120000);
  assert.ok(afterCutoff > 23 * 3600000);
  assert.ok(afterCutoff < 25 * 3600000);
});

test('package metadata stays aligned with build output', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { main: string; version: string };
  const tsconfig = JSON.parse(
    await readFile(new URL('../tsconfig.json', import.meta.url), 'utf8'),
  ) as { compilerOptions: { rootDir: string; outDir: string } };

  assert.equal(packageJson.main, 'dist/index.js');
  assert.equal(PLUGIN_VERSION, packageJson.version);
  assert.equal(tsconfig.compilerOptions.rootDir, 'src');
  assert.equal(tsconfig.compilerOptions.outDir, 'dist');
});
