import { z } from 'zod';
import type { FeedSchedule } from '../shared/feed.js';

const recurring = { enabled: z.boolean(), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), timeZone: z.string().min(1).max(200).refine(zone => { try { if (/^[+-]/.test(zone)) return false; new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; } }, 'IANA 时区无效。') };
export const feedScheduleSchema = z.discriminatedUnion('frequency', [z.strictObject({ frequency: z.literal('manual') }), z.strictObject({ frequency: z.literal('daily'), ...recurring }), z.strictObject({ frequency: z.literal('weekly'), ...recurring, weekday: z.number().int().min(0).max(6) })]);
const formatters = new Map<string, Intl.DateTimeFormat>();
const occurrences = new Map<string, number | null>();
function parts(at: number, zone: string) {
  let formatter = formatters.get(zone);
  if (!formatter) { formatter = new Intl.DateTimeFormat('en', { timeZone: zone, calendar: 'iso8601', numberingSystem: 'latn', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!); formatters.set(zone, formatter); }
  return Object.fromEntries(formatter.formatToParts(at).map(p => [p.type, p.value]));
}
export function localScheduleDate(at: string, zone: string): string { const p = parts(Date.parse(at), zone); return `${p.year.padStart(4, '0')}-${p.month}-${p.day}`; }
export function scheduleTimestamp(at: string): number { const value = z.iso.datetime({ offset: true }).parse(at), ms = Date.parse(value); if (!Number.isFinite(ms) || new Date(ms).getUTCFullYear() < 100) throw new Error('计划时刻无效或早于支持的公元 100 年。'); return ms; }
function firstOccurrence(date: Date, time: string, zone: string): number | null {
  const label = date.toISOString().slice(0, 10), key = `${zone}/${label}/${time}`;
  if (occurrences.has(key)) return occurrences.get(key)!;
  const [hour, minute] = time.split(':').map(Number), naive = date.getTime() + (hour * 60 + minute) * 60000;
  let found: number | null = null;
  // shortcut: minute-offset modern schedules; historical subminute zones need a second-resolution resolver.
  // Scan the entire local date's possible instants so a fold always picks its first copy.
  for (let at = naive - 36 * 3600000; at <= naive + 36 * 3600000; at += 60000) {
    const p = parts(at, zone);
    if (`${p.year.padStart(4, '0')}-${p.month}-${p.day}` === label && Number(p.hour) === hour && Number(p.minute) === minute && Number(p.second) === 0) { found = at; break; }
  }
  if (occurrences.size >= 2048) occurrences.delete(occurrences.keys().next().value!);
  occurrences.set(key, found); return found;
}
function adjacentDueAt(schedule: FeedSchedule, after: string, direction: 1 | -1): string | null {
  schedule = feedScheduleSchema.parse(schedule); const ms = scheduleTimestamp(after);
  if (schedule.frequency === 'manual' || !schedule.enabled) return null;
  const p = parts(ms, schedule.timeZone), date = new Date(0); date.setUTCFullYear(Number(p.year), Number(p.month) - 1, Number(p.day)); date.setUTCHours(0, 0, 0, 0);
  while (Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 100 && date.getUTCFullYear() <= 9999) {
    if (schedule.frequency === 'daily' || date.getUTCDay() === schedule.weekday) { const at = firstOccurrence(date, schedule.time, schedule.timeZone); if (at !== null && (direction === 1 ? at > ms : at < ms)) return new Date(at).toISOString(); }
    date.setUTCDate(date.getUTCDate() + direction);
  }
  throw new Error('计划超出支持的日期范围。');
}
export function nextDueAt(schedule: FeedSchedule, after: string): string | null { return adjacentDueAt(schedule, after, 1); }
export function previousDueAt(schedule: FeedSchedule, before: string): string | null {
  return adjacentDueAt(schedule, before, -1);
}
