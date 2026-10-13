// instanceof of the @internationalized/date classes in untyped helpers
// (dates.js) given a DateValue (the pack's class union), undefined or a Date.
import {
  CalendarDate,
  CalendarDateTime,
  toZoned,
  type DateValue,
} from '@internationalized/date';
import { daysInMonth, hasTime, isCalendarDate, isZonedDateTime } from './dates.js';

// A module constant constructing pack classes: the pack's own module
// constants (its month-length tables) are initialised before it.
const values: DateValue[] = [
  new CalendarDate(2024, 2, 10),
  new CalendarDateTime(2025, 4, 2, 3, 4),
  toZoned(new CalendarDateTime(2025, 6, 7, 8, 9), 'UTC'),
];

export function describe(kind: number): string {
  const v: DateValue | undefined = kind < values.length ? values[kind] : undefined;
  const days: number = v === undefined ? daysInMonth(new Date(2024, 1, 10)) : daysInMonth(v);
  const time: boolean = hasTime(v);
  const zoned: boolean = isZonedDateTime(v);
  const date: boolean = isCalendarDate(v);
  return [String(time), String(zoned), String(date), String(days), v ? v.toString() : '-'].join(
    ' ',
  );
}
