import type { PlatformConfig } from 'homebridge';

export type Band = 'cheap' | 'normal' | 'expensive';
export type PublicZone = 'PCB' | 'CYM';
export type GeographicZone = 'PENINSULA' | 'CANARIAS' | 'BALEARES' | 'CEUTA' | 'MELILLA';
export type Zone = PublicZone | GeographicZone;
export type ExposeMode = 'switches' | 'sensors' | 'both';
export type PriceSource = 'esios-public' | 'esios-token' | 'mock';
export type PriceProxyType = 'light';
export type AccessoryKind =
  | 'current-price'
  | 'cheap-now'
  | 'expensive-now'
  | 'data-stale'
  | 'band-cheap'
  | 'band-normal'
  | 'band-expensive';

export interface PVPCCostPlatformConfig extends PlatformConfig {
  zone?: Zone;
  updateIntervalMinutes?: number;
  cheapThresholdEurKwh?: number;
  expensiveThresholdEurKwh?: number;
  exposeMode?: ExposeMode;
  esiosApiToken?: string;
}

export interface ResolvedConfig {
  name: string;
  zone: Zone;
  updateIntervalMinutes: number;
  cheapThresholdEurKwh: number;
  expensiveThresholdEurKwh: number;
  exposeMode: ExposeMode;
  esiosApiToken?: string;
  mockDataFile?: string;
  priceProxyType: PriceProxyType;
}

export interface PriceCache {
  version: 1;
  zone: Zone;
  source: PriceSource;
  fetchedAt: string;
  hourlyPrices: Record<string, number>;
}

export interface FetchPricesResult {
  source: PriceSource;
  resolvedZoneLabel: string;
  hourlyPrices: Record<string, number>;
  fetchedAt: string;
  /** Set when tomorrow's prices were requested but could not be fetched; today's prices are still valid. */
  tomorrowError?: string;
}

export interface DerivedState {
  currentHourKey: string;
  currentPrice: number | null;
  currentPriceCentsKwh: number | null;
  currentBand: Band | null;
  isCheapNow: boolean;
  isExpensiveNow: boolean;
  nextCheapStart: string | null;
  stale: boolean;
  staleReason: string | null;
  latestHourKey: string | null;
}

export interface MadridDateParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}
