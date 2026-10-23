export function localTimeParts(date: Date, timezone: string): { dateKey: string; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).map(p => [p.type, p.value]));
  return { dateKey: parts.year + "-" + parts.month + "-" + parts.day, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
export function localMinutes(date: Date, timezone: string): number { return localTimeParts(date, timezone).minutes; }
export function dateKey(date: Date, timezone: string): string { return localTimeParts(date, timezone).dateKey; }
/** Invalid candidate times are discarded; invalid configuration throws separately. */
export function parseTime(value: string): number | undefined {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return undefined;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}
export function parseClock(value: string): number {
  const result = parseTime(value);
  if (result === undefined) throw new Error("Invalid quiet-hours clock: " + value);
  return result;
}
export function quietMinutes(minute: number, start: string, end: string): boolean {
  const from = parseClock(start), to = parseClock(end);
  return from === to ? false : from < to ? minute >= from && minute < to : minute >= from || minute < to;
}
export function isQuietTime(date: Date, timezone: string, start: string, end: string): boolean {
  return quietMinutes(localMinutes(date, timezone), start, end);
}
