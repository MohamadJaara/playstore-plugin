export const PLAY_VITALS_TIME_ZONE = "America/Los_Angeles";

export interface DateRange {
  startDate: string;
  endDateExclusive: string;
}

export function dateRangeDays(startDate: string, endDateExclusive: string): number {
  return Math.round((dateOnlyToUtcMs(endDateExclusive) - dateOnlyToUtcMs(startDate)) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));

  return [
    String(value.getUTCFullYear()).padStart(4, "0"),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0")
  ].join("-");
}

export function previousDateRange(range: DateRange): DateRange {
  const days = dateRangeDays(range.startDate, range.endDateExclusive);

  return {
    startDate: addDays(range.startDate, -days),
    endDateExclusive: range.startDate
  };
}

export function dateOnlyToQueryParams(prefix: string, value: string, timeZone = PLAY_VITALS_TIME_ZONE): Record<string, string | number> {
  const [year, month, day] = value.split("-").map(Number);

  return {
    [`${prefix}.year`]: year,
    [`${prefix}.month`]: month,
    [`${prefix}.day`]: day,
    [`${prefix}.timeZone.id`]: timeZone
  };
}

export function parsePositiveInteger(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Expected a positive whole number, received "${value}".`);
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive safe integer, received "${value}".`);
  }

  return parsed;
}

function dateOnlyToUtcMs(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}
