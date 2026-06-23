import { MADRID_TIME_ZONE } from './settings.js';
import type { MadridDateParts } from './types.js';

const madridFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: MADRID_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const madridOffsetFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: MADRID_TIME_ZONE,
  timeZoneName: 'shortOffset',
});

interface ZonedDateTimeInput {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
}

export function getMadridParts(date: Date): MadridDateParts {
  const parts = madridFormatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.map(part => [part.type, part.value]));

  return {
    year: lookup.year,
    month: lookup.month,
    day: lookup.day,
    hour: lookup.hour,
    minute: lookup.minute,
  };
}

export function getMadridDateKey(date: Date): string {
  const parts = getMadridParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function getMadridHourKey(date: Date): string {
  const parts = getMadridParts(date);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00`;
}

export function getUtcHourKey(date: Date): string {
  const utcHourStart = new Date(date.getTime());
  utcHourStart.setUTCMinutes(0, 0, 0);
  return utcHourStart.toISOString();
}

export function getMadridDateKeyFromUtcHourKey(utcHourKey: string): string {
  return getMadridDateKey(new Date(utcHourKey));
}

export function getMadridHourKeyFromUtcHourKey(utcHourKey: string): string {
  return getMadridHourKey(new Date(utcHourKey));
}

export function makeHourKey(dateKey: string, hour: number): string {
  return `${dateKey}T${String(hour).padStart(2, '0')}:00`;
}

export function parsePublicDate(dateValue: string): string {
  const [day, month, year] = dateValue.split('/');
  return `${year}-${month}-${day}`;
}

export function shouldFetchTomorrow(now: Date): boolean {
  const parts = getMadridParts(now);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);

  return hour > 20 || (hour === 20 && minute >= 30);
}

export function getHoursBetweenHourKeys(startHourKey: string, endHourKey: string): number {
  const startMs = Date.parse(startHourKey);
  const endMs = Date.parse(endHourKey);

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error(`Invalid UTC hour key comparison: ${startHourKey} -> ${endHourKey}`);
  }

  return Math.round((endMs - startMs) / 3600000);
}

export function getTomorrowRefreshDelayMs(now: Date): number {
  const parts = getMadridParts(now);

  const targetDay = addDaysToPlainDate(
    {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
    },
    shouldFetchTomorrow(now) ? 1 : 0,
  );

  const targetUtc = zonedDateTimeToUtc({
    ...targetDay,
    hour: 20,
    minute: 31,
    second: 0,
    millisecond: 0,
  });

  return Math.max(targetUtc.getTime() - now.getTime(), 1000);
}

export function getRelativeMadridDateKey(now: Date, daysFromNow: number): string {
  const parts = getMadridParts(now);
  const targetDay = addDaysToPlainDate(
    {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
    },
    daysFromNow,
  );

  return `${targetDay.year}-${String(targetDay.month).padStart(2, '0')}-${String(targetDay.day).padStart(2, '0')}`;
}

export function getMadridDayStartUtc(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return zonedDateTimeToUtc({ year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 });
}

function zonedDateTimeToUtc(input: ZonedDateTimeInput): Date {
  const utcGuess = new Date(Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour ?? 0,
    input.minute ?? 0,
    input.second ?? 0,
    input.millisecond ?? 0,
  ));

  const offsetMs = getMadridOffsetMs(utcGuess);
  return new Date(utcGuess.getTime() - offsetMs);
}

function getMadridOffsetMs(date: Date): number {
  const timeZoneName = madridOffsetFormatter
    .formatToParts(date)
    .find(part => part.type === 'timeZoneName')
    ?.value;

  if (timeZoneName === undefined) {
    throw new Error('Failed to determine Madrid timezone offset');
  }

  return parseGmtOffsetMs(timeZoneName);
}

function parseGmtOffsetMs(value: string): number {
  if (value === 'GMT') {
    return 0;
  }

  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(value);
  if (match === null) {
    throw new Error(`Unsupported GMT offset format: ${value}`);
  }

  const sign = match[1] === '+' ? 1 : -1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? '0');
  return sign * ((hours * 60) + minutes) * 60000;
}

function addDaysToPlainDate(
  input: Pick<ZonedDateTimeInput, 'year' | 'month' | 'day'>,
  days: number,
): Pick<ZonedDateTimeInput, 'year' | 'month' | 'day'> {
  const date = new Date(Date.UTC(input.year, input.month - 1, input.day, 12, 0, 0, 0));
  date.setUTCDate(date.getUTCDate() + days);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}
