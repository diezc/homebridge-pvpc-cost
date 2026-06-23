import {
  getHoursBetweenHourKeys,
  getMadridDateKey,
  getMadridDateKeyFromUtcHourKey,
  getMadridHourKey,
  getMadridHourKeyFromUtcHourKey,
  getUtcHourKey,
} from './time.js';
import type { Band, CheapestHour, DerivedState } from './types.js';

type PriceEntry = [utcHourKey: string, price: number];

export function classifyBand(
  priceEurKwh: number,
  cheapThresholdEurKwh: number,
  expensiveThresholdEurKwh: number,
): Band {
  if (priceEurKwh <= cheapThresholdEurKwh) {
    return 'cheap';
  }

  if (priceEurKwh >= expensiveThresholdEurKwh) {
    return 'expensive';
  }

  return 'normal';
}

export function computeDerivedState(
  hourlyPrices: Record<string, number>,
  now: Date,
  cheapThresholdEurKwh: number,
  expensiveThresholdEurKwh: number,
  updateIntervalMinutes: number,
  lastSuccessfulFetchAt?: Date,
): DerivedState {
  const currentUtcHourKey = getUtcHourKey(now);
  const currentHourKey = getMadridHourKey(now);
  const currentDateKey = getMadridDateKey(now);
  const sortedEntries = Object.entries(hourlyPrices)
    .filter(([hourKey, price]) => Number.isFinite(Date.parse(hourKey)) && Number.isFinite(price))
    .sort(([left], [right]) => left.localeCompare(right));
  const latestHourKey = sortedEntries.length > 0
    ? getMadridHourKeyFromUtcHourKey(sortedEntries[sortedEntries.length - 1][0])
    : null;
  const currentPriceCandidate = hourlyPrices[currentUtcHourKey];
  const currentPrice = typeof currentPriceCandidate === 'number' && Number.isFinite(currentPriceCandidate)
    ? currentPriceCandidate
    : null;
  const currentBand = currentPrice === null
    ? null
    : classifyBand(currentPrice, cheapThresholdEurKwh, expensiveThresholdEurKwh);
  const currentPriceCentsKwh = currentPrice === null ? null : roundTo(currentPrice * 100, 2);
  const todayEntries = sortedEntries.filter(([hourKey]) => getMadridDateKeyFromUtcHourKey(hourKey) === currentDateKey);
  const next24hEntries = sortedEntries.filter(([hourKey]) => {
    const diff = getHoursBetweenHourKeys(currentUtcHourKey, hourKey);
    return diff >= 0 && diff < 24;
  });
  const cheapestHourToday = getCheapestHour(todayEntries);
  const cheapestHourNext24h = getCheapestHour(next24hEntries);
  const nextCheapEntry = next24hEntries.find(([, price]) => price <= cheapThresholdEurKwh) ?? null;

  const staleThresholdMinutes = Math.max(updateIntervalMinutes * 3, 60);
  const staleByAge = lastSuccessfulFetchAt === undefined
    ? true
    : ((now.getTime() - lastSuccessfulFetchAt.getTime()) / 60000) > staleThresholdMinutes;
  const staleByMissingCurrentHour = currentPrice === null;
  const stale = staleByAge || staleByMissingCurrentHour;

  let staleReason: string | null = null;
  if (staleByMissingCurrentHour) {
    staleReason = 'missing_current_hour';
  } else if (staleByAge) {
    staleReason = 'refresh_too_old';
  }

  return {
    currentHourKey,
    currentPrice,
    currentPriceCentsKwh,
    currentBand,
    cheapestHourToday,
    cheapestHourNext24h,
    isCheapNow: currentBand === 'cheap',
    isExpensiveNow: currentBand === 'expensive',
    nextCheapStart: nextCheapEntry === null ? null : getMadridHourKeyFromUtcHourKey(nextCheapEntry[0]),
    hoursUntilCheap: nextCheapEntry === null ? null : getHoursBetweenHourKeys(currentUtcHourKey, nextCheapEntry[0]),
    stale,
    staleReason,
    latestHourKey,
  };
}

function getCheapestHour(entries: PriceEntry[]): CheapestHour | null {
  if (entries.length === 0) {
    return null;
  }

  const [hourKey, price] = entries.reduce((lowest, entry) => entry[1] < lowest[1] ? entry : lowest);
  return { hourKey: getMadridHourKeyFromUtcHourKey(hourKey), price };
}

function roundTo(value: number, decimals: number): number {
  const precision = 10 ** decimals;
  return Math.round(value * precision) / precision;
}
