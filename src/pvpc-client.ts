import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CACHE_FILE_NAME,
  FETCH_RETRY_DELAY_MS,
  FETCH_TIMEOUT_MS,
  MAX_FETCH_ATTEMPTS,
  PUBLIC_PVPC_URL,
  TOKEN_PVPC_URL,
} from './settings.js';
import {
  getMadridDateKey,
  getMadridDayStartUtc,
  getRelativeMadridDateKey,
  getUtcHourKey,
  parsePublicDate,
  shouldFetchTomorrow,
} from './time.js';
import type { FetchPricesResult, PriceCache, Zone } from './types.js';

interface MockFetchPayload {
  source?: 'mock';
  resolvedZoneLabel?: string;
  fetchedAt?: string;
  hourlyPrices: Record<string, number>;
}

const TOKEN_ZONE_TO_GEO_NAME: Record<Exclude<Zone, 'PCB' | 'CYM'>, string> = {
  PENINSULA: 'Península',
  CANARIAS: 'Canarias',
  BALEARES: 'Baleares',
  CEUTA: 'Ceuta',
  MELILLA: 'Melilla',
};

const PUBLIC_FALLBACK_ZONE: Record<Zone, 'PCB' | 'CYM'> = {
  PCB: 'PCB',
  CYM: 'CYM',
  PENINSULA: 'PCB',
  CANARIAS: 'PCB',
  BALEARES: 'PCB',
  CEUTA: 'CYM',
  MELILLA: 'CYM',
};

interface PublicResponseRow {
  Dia: string;
  Hora: string;
  PCB: string;
  CYM: string;
}

interface PublicResponse {
  PVPC: PublicResponseRow[];
}

interface TokenIndicatorValue {
  value: number;
  datetime: string;
  datetime_utc?: string;
  geo_name: string;
}

interface TokenResponse {
  indicator: {
    values: TokenIndicatorValue[];
  };
}

export class PVPCClient {
  constructor(
    private readonly cacheDirectory: string,
    private readonly cacheKey: string,
    private readonly zone: Zone,
    private readonly esiosApiToken?: string,
    private readonly mockDataFile?: string,
  ) {}

  async loadCache(): Promise<PriceCache | null> {
    try {
      const cachePath = this.getCachePath();
      const raw = await readFile(cachePath, 'utf8');
      const parsed = JSON.parse(raw) as PriceCache;
      if (!isValidCache(parsed, this.zone)) {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  async saveCache(result: FetchPricesResult): Promise<void> {
    await mkdir(this.cacheDirectory, { recursive: true });

    const cache: PriceCache = {
      version: 1,
      zone: this.zone,
      source: result.source,
      fetchedAt: result.fetchedAt,
      hourlyPrices: pruneOldHourKeys(result.hourlyPrices),
    };

    await writeFile(this.getCachePath(), JSON.stringify(cache, null, 2), 'utf8');
  }

  async fetchLatest(now: Date): Promise<FetchPricesResult> {
    if (this.mockDataFile !== undefined) {
      return this.fetchFromMock(now);
    }

    if (this.esiosApiToken !== undefined && this.zone !== 'PCB' && this.zone !== 'CYM') {
      return this.fetchFromToken(now);
    }

    return this.fetchFromPublic(now);
  }

  usesApproximatePublicZone(): boolean {
    return this.mockDataFile === undefined && this.esiosApiToken === undefined && this.zone !== 'PCB' && this.zone !== 'CYM';
  }

  isMockMode(): boolean {
    return this.mockDataFile !== undefined;
  }

  getResolvedZoneLabel(): string {
    if (this.mockDataFile !== undefined) {
      return this.zone;
    }

    if (this.esiosApiToken !== undefined && this.zone !== 'PCB' && this.zone !== 'CYM') {
      return TOKEN_ZONE_TO_GEO_NAME[this.zone];
    }

    return PUBLIC_FALLBACK_ZONE[this.zone];
  }

  async getMockDataFilePath(): Promise<string | undefined> {
    if (this.mockDataFile === undefined) {
      return undefined;
    }

    return realpath(this.mockDataFile);
  }

  private async fetchFromPublic(now: Date): Promise<FetchPricesResult> {
    const publicZone = PUBLIC_FALLBACK_ZONE[this.zone];
    const { hourlyPrices, tomorrowError } = await fetchTodayAndTomorrow(now, async (dateKey) => {
      const url = new URL(PUBLIC_PVPC_URL);
      url.searchParams.set('locale', 'es');
      url.searchParams.set('date', dateKey);

      const payload = await fetchJson<PublicResponse>(url, undefined);
      return parsePublicPvpc(payload, publicZone);
    });

    return {
      source: 'esios-public',
      resolvedZoneLabel: publicZone,
      hourlyPrices,
      fetchedAt: new Date().toISOString(),
      tomorrowError,
    };
  }

  private async fetchFromToken(now: Date): Promise<FetchPricesResult> {
    const geoName = TOKEN_ZONE_TO_GEO_NAME[this.zone as Exclude<Zone, 'PCB' | 'CYM'>];
    const { hourlyPrices, tomorrowError } = await fetchTodayAndTomorrow(now, async (dateKey) => {
      const url = new URL(TOKEN_PVPC_URL);
      url.searchParams.set('start_date', `${dateKey}T00:00`);
      url.searchParams.set('end_date', `${dateKey}T23:59`);

      const payload = await fetchJson<TokenResponse>(url, {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Token token=${this.esiosApiToken}`,
        'x-api-key': this.esiosApiToken ?? '',
      });
      return parseTokenPvpc(payload, geoName);
    });

    return {
      source: 'esios-token',
      resolvedZoneLabel: geoName,
      hourlyPrices,
      fetchedAt: new Date().toISOString(),
      tomorrowError,
    };
  }

  private async fetchFromMock(now: Date): Promise<FetchPricesResult> {
    if (this.mockDataFile === undefined) {
      throw new Error('Mock data file mode was not configured');
    }

    const raw = await readFile(this.mockDataFile, 'utf8');
    const payload = JSON.parse(raw) as MockFetchPayload;
    if (payload.hourlyPrices === undefined || payload.hourlyPrices === null || typeof payload.hourlyPrices !== 'object') {
      throw new Error(`Mock PVPC payload in ${this.mockDataFile} is missing hourlyPrices`);
    }

    const normalizedPrices = Object.fromEntries(
      Object.entries(payload.hourlyPrices).map(([key, value]) => {
        const normalizedKey = normalizeMockHourKey(key);
        const normalizedValue = parseNormalizedPrice(value, `mock PVPC row ${key}`);
        return [normalizedKey, normalizedValue];
      }),
    );

    return {
      source: 'mock',
      resolvedZoneLabel: payload.resolvedZoneLabel ?? this.zone,
      hourlyPrices: normalizedPrices,
      fetchedAt: payload.fetchedAt ?? now.toISOString(),
    };
  }

  private getCachePath(): string {
    return path.join(this.cacheDirectory, `${this.cacheKey}-${CACHE_FILE_NAME}`);
  }
}

export function parsePublicPvpc(payload: PublicResponse, zone: 'PCB' | 'CYM'): Record<string, number> {
  const rows = payload.PVPC;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('PVPC public payload did not contain hourly rows');
  }

  const dateKey = parsePublicDate(rows[0].Dia);
  const dayStartUtc = getMadridDayStartUtc(dateKey);

  return Object.fromEntries(rows.map((row, index) => {
    const rowDateKey = parsePublicDate(row.Dia);
    if (rowDateKey !== dateKey) {
      throw new Error(`PVPC public payload mixed dates: ${dateKey} and ${rowDateKey}`);
    }

    parsePublicHour(row.Hora);
    const utcHourKey = new Date(dayStartUtc.getTime() + (index * 3600000)).toISOString();
    const value = parseNormalizedPrice(parseEuropeanNumber(row[zone]) / 1000, 'public PVPC row');
    return [utcHourKey, value];
  }));
}

export function parseTokenPvpc(payload: TokenResponse, geoName: string): Record<string, number> {
  const values = payload.indicator?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('PVPC token payload did not contain indicator values');
  }

  const filtered = values.filter(value => value.geo_name === geoName);
  if (filtered.length === 0) {
    throw new Error(`PVPC token payload did not contain geo zone ${geoName}`);
  }

  return Object.fromEntries(filtered.map(entry => {
    const sourceTimestamp = entry.datetime_utc ?? entry.datetime;
    const utcHourKey = getUtcHourKey(new Date(sourceTimestamp));
    return [utcHourKey, parseNormalizedPrice(entry.value / 1000, `token PVPC row for ${geoName}`)];
  }));
}

/**
 * Merges freshly fetched prices over previously known ones (incoming values win), so a refresh
 * that could not get tomorrow's prices keeps the ones it already had. Previously known hours older
 * than 24h are dropped; incoming hours are always kept.
 */
export function mergeHourlyPrices(
  existing: Record<string, number>,
  incoming: Record<string, number>,
  now: Date = new Date(),
): Record<string, number> {
  return { ...pruneOldHourKeys(existing, now), ...incoming };
}

/**
 * Fetches today's prices (required: failures propagate) and, after the evening cutoff,
 * tomorrow's prices on a best-effort basis, since they may not be published yet.
 */
async function fetchTodayAndTomorrow(
  now: Date,
  fetchDate: (dateKey: string) => Promise<Record<string, number>>,
): Promise<{ hourlyPrices: Record<string, number>; tomorrowError?: string }> {
  const hourlyPrices = { ...await fetchDate(getMadridDateKey(now)) };

  if (!shouldFetchTomorrow(now)) {
    return { hourlyPrices };
  }

  try {
    Object.assign(hourlyPrices, await fetchDate(getRelativeMadridDateKey(now, 1)));
    return { hourlyPrices };
  } catch (error) {
    return {
      hourlyPrices,
      tomorrowError: error instanceof Error ? error.message : 'Unknown error fetching tomorrow prices',
    };
  }
}

async function fetchJson<T>(url: URL, headers: Record<string, string> | undefined): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`Unexpected HTTP status ${response.status} for ${url.toString()}`);
      }

      return await response.json() as T;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_FETCH_ATTEMPTS) {
        await sleep(FETCH_RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Unknown PVPC fetch error');
}

function parseEuropeanNumber(value: string): number {
  const parsed = Number(value.replace(',', '.'));
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid European numeric value: ${value}`);
  }

  return parsed;
}

function parsePublicHour(value: string): number {
  const hour = Number(value.slice(0, 2));
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`Unexpected public PVPC hour value ${value}`);
  }

  return hour;
}

function pruneOldHourKeys(hourlyPrices: Record<string, number>, now: Date = new Date()): Record<string, number> {
  const minimumTimestamp = Date.parse(getUtcHourKey(now)) - (24 * 3600000);

  return Object.fromEntries(
    Object.entries(hourlyPrices)
      .filter(([hourKey]) => Date.parse(hourKey) >= minimumTimestamp),
  );
}

function roundTo(value: number, decimals: number): number {
  const precision = 10 ** decimals;
  return Math.round(value * precision) / precision;
}

function parseNormalizedPrice(value: number, context: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid normalized price for ${context}`);
  }

  return roundTo(value, 5);
}

function isValidCache(cache: PriceCache, expectedZone: Zone): boolean {
  return cache.version === 1
    && cache.zone === expectedZone
    && typeof cache.fetchedAt === 'string'
    && (cache.source === 'esios-public' || cache.source === 'esios-token' || cache.source === 'mock')
    && cache.hourlyPrices !== null
    && typeof cache.hourlyPrices === 'object'
    && Object.entries(cache.hourlyPrices).every(([key, value]) => {
      return typeof key === 'string'
        && Number.isFinite(Date.parse(key))
        && typeof value === 'number'
        && Number.isFinite(value);
    });
}

function normalizeMockHourKey(key: string): string {
  const parsed = Date.parse(key);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid mock PVPC hour key: ${key}`);
  }

  const normalized = new Date(parsed);
  normalized.setUTCMinutes(0, 0, 0);
  return normalized.toISOString();
}

function sleep(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}
