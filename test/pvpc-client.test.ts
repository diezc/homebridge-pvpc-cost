import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PVPCClient, parsePublicPvpc, parseTokenPvpc } from '../src/pvpc-client.js';

test('parsePublicPvpc normalizes millieuro values to EUR/kWh', () => {
  const result = parsePublicPvpc({
    PVPC: [
      { Dia: '22/06/2026', Hora: '00-01', PCB: '134,54', CYM: '134,54' },
      { Dia: '22/06/2026', Hora: '01-02', PCB: '126,94', CYM: '126,94' },
    ],
  }, 'PCB');

  assert.equal(result['2026-06-21T22:00:00.000Z'], 0.13454);
  assert.equal(result['2026-06-21T23:00:00.000Z'], 0.12694);
});

test('parseTokenPvpc filters the requested geographic zone and normalizes EUR/MWh', () => {
  const result = parseTokenPvpc({
    indicator: {
      values: [
        { value: 134.54, datetime: '2026-06-22T00:00:00.000+02:00', geo_name: 'Península' },
        { value: 115.00, datetime: '2026-06-22T10:00:00.000+02:00', geo_name: 'Ceuta' },
        { value: 111.11, datetime: '2026-06-22T10:00:00.000+02:00', geo_name: 'Península' },
      ],
    },
  }, 'Península');

  assert.equal(result['2026-06-21T22:00:00.000Z'], 0.13454);
  assert.equal(result['2026-06-22T08:00:00.000Z'], 0.11111);
  assert.equal(Object.keys(result).length, 2);
});

test('parsePublicPvpc keeps unique hours across DST fallback day', () => {
  const result = parsePublicPvpc({
    PVPC: Array.from({ length: 25 }, (_, index) => ({
      Dia: '26/10/2025',
      Hora: `${String(index % 24).padStart(2, '0')}-${String((index + 1) % 24).padStart(2, '0')}`,
      PCB: '100,00',
      CYM: '100,00',
    })),
  }, 'PCB');

  assert.equal(Object.keys(result).length, 25);
  assert.equal(new Set(Object.keys(result)).size, 25);
  assert.equal(result['2025-10-25T22:00:00.000Z'], 0.1);
  assert.equal(result['2025-10-26T22:00:00.000Z'], 0.1);
});

test('parsePublicPvpc rejects invalid numeric values', () => {
  assert.throws(() => parsePublicPvpc({
    PVPC: [
      { Dia: '22/06/2026', Hora: '00-01', PCB: 'NaN', CYM: '134,54' },
    ],
  }, 'PCB'));
});

test('PVPCClient ignores corrupted cache contents', async () => {
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), 'pvpc-cache-test-'));
  await writeFile(
    path.join(cacheDirectory, 'test-key-pvpc-cost-cache.json'),
    JSON.stringify({
      version: 1,
      zone: 'PCB',
      source: 'esios-public',
      fetchedAt: '2026-06-22T08:00:00.000Z',
      hourlyPrices: {
        '2026-06-22T08:00:00.000Z': 'broken',
      },
    }),
  );

  const client = new PVPCClient(cacheDirectory, 'test-key', 'PCB');
  const cache = await client.loadCache();

  assert.equal(cache, null);
});

test('PVPCClient loads deterministic mock data file', async () => {
  const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
  const mockDataFile = path.join(repoRoot, 'test', 'fixtures', 'mock-pvpc-data.json');
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), 'pvpc-mock-cache-test-'));
  const client = new PVPCClient(cacheDirectory, 'mock-key', 'PCB', undefined, mockDataFile);

  const result = await client.fetchLatest(new Date('2026-06-22T08:15:00.000Z'));

  assert.equal(result.source, 'mock');
  assert.equal(result.resolvedZoneLabel, 'PCB');
  assert.equal(result.hourlyPrices['2026-06-22T08:00:00.000Z'], 0.18);
  assert.equal(client.isMockMode(), true);
});
