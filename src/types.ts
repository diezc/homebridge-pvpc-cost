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
}

export interface CheapestHour {
  hourKey: string;
  price: number;
}

export interface DerivedState {
  currentHourKey: string;
  currentPrice: number | null;
  currentPriceCentsKwh: number | null;
  currentBand: Band | null;
  cheapestHourToday: CheapestHour | null;
  cheapestHourNext24h: CheapestHour | null;
  isCheapNow: boolean;
  isExpensiveNow: boolean;
  nextCheapStart: string | null;
  hoursUntilCheap: number | null;
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
