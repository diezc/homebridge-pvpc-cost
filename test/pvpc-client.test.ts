import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PVPCClient, mergeHourlyPrices, parsePublicPvpc, parseTokenPvpc } from '../src/pvpc-client.js';

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

const TODAY_PUBLIC_PAYLOAD = {
  PVPC: [
    { Dia: '22/06/2026', Hora: '00-01', PCB: '134,54', CYM: '134,54' },
    { Dia: '22/06/2026', Hora: '01-02', PCB: '126,94', CYM: '126,94' },
  ],
};

function mockPublicFetch(payloadsByDate: Record<string, unknown>) {
  const calls: { date: string | null; signal: unknown }[] = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (input: URL, init?: RequestInit) => {
    const date = new URL(input).searchParams.get('date');
    calls.push({ date, signal: init?.signal });
    return new Response(JSON.stringify(payloadsByDate[date ?? ''] ?? { PVPC: [] }), { status: 200 });
  });
  return { calls, restore: () => fetchMock.mock.restore() };
}

test('PVPCClient keeps today prices when tomorrow is not published yet', async (t) => {
  const { calls, restore } = mockPublicFetch({ '2026-06-22': TODAY_PUBLIC_PAYLOAD, '2026-06-23': { PVPC: [] } });
  t.after(restore);
  const client = new PVPCClient(await mkdtemp(path.join(tmpdir(), 'pvpc-partial-')), 'partial', 'PCB');

  // 21:00 Madrid, past the 20:30 cutoff, so tomorrow is requested.
  const result = await client.fetchLatest(new Date('2026-06-22T19:00:00.000Z'));

  assert.deepEqual(calls.map(call => call.date), ['2026-06-22', '2026-06-23']);
  assert.equal(result.hourlyPrices['2026-06-21T22:00:00.000Z'], 0.13454);
  assert.equal(Object.keys(result.hourlyPrices).length, 2);
  assert.match(result.tomorrowError ?? '', /did not contain hourly rows/);
});

test('PVPCClient still fails when today prices cannot be fetched', async (t) => {
  const { restore } = mockPublicFetch({ '2026-06-22': { PVPC: [] } });
  t.after(restore);
  const client = new PVPCClient(await mkdtemp(path.join(tmpdir(), 'pvpc-today-fail-')), 'today-fail', 'PCB');

  await assert.rejects(client.fetchLatest(new Date('2026-06-22T08:00:00.000Z')), /did not contain hourly rows/);
});

test('PVPCClient passes a timeout signal to fetch', async (t) => {
  const { calls, restore } = mockPublicFetch({ '2026-06-22': TODAY_PUBLIC_PAYLOAD });
  t.after(restore);
  const client = new PVPCClient(await mkdtemp(path.join(tmpdir(), 'pvpc-timeout-')), 'timeout', 'PCB');

  const result = await client.fetchLatest(new Date('2026-06-22T08:00:00.000Z'));

  assert.equal(result.tomorrowError, undefined);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test('mergeHourlyPrices keeps known hours, prefers incoming values, and prunes old known hours', () => {
  const now = new Date('2026-06-22T19:30:00.000Z');
  const merged = mergeHourlyPrices(
    {
      '2026-06-20T10:00:00.000Z': 0.5, // more than 24h old: dropped
      '2026-06-22T19:00:00.000Z': 0.1, // revised by incoming
      '2026-06-23T10:00:00.000Z': 0.2, // tomorrow, kept even though incoming lacks it
    },
    {
      '2026-06-22T19:00:00.000Z': 0.12,
      '2026-06-22T20:00:00.000Z': 0.13,
    },
    now,
  );

  assert.deepEqual(merged, {
    '2026-06-22T19:00:00.000Z': 0.12,
    '2026-06-22T20:00:00.000Z': 0.13,
    '2026-06-23T10:00:00.000Z': 0.2,
  });
});
