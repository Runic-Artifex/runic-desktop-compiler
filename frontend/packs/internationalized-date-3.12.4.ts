// Mapping pack for @internationalized/date 3.12.4 (docs/design/M6-LIBRARIES.md,
// "Library code"): the date values, queries and formatter that bits-ui's
// Calendar, RangeCalendar and DatePicker and the shadcn-svelte calendar
// examples use.
//
// The package cannot be compiled from source: its published JavaScript is
// untyped, its constructors are `...args: any[]` overloads dispatched on
// `typeof`, its values hold a `Calendar` interface implemented by thirteen
// unrelated classes, it mutates copies through `Mutable<T>`, and it reads
// time zones and week data through `Intl` objects with options known only
// when it runs. The pack ports the Gregorian part instead:
// internationalized-date-3.12.4/date.ts, one typed module compiled with the
// program in place of the package's modules (its header lists what it
// covers and what it reports unsupported where it runs).
//
// The package's declaration files import their modules extensionless
// (`./CalendarDate`), so the ports stand for those paths: the declarations
// of every covered module resolve to the port, and the barrel's other
// modules (the other calendars, `createCalendar`) keep their declarations,
// whose exports the pack rejects (E_PACK).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pack } from '../packs.ts';

const LABEL = '@internationalized/date@3.12.4 pack';

const PORT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'internationalized-date-3.12.4/date.ts',
);

/** The modules the port stands for (dist/types/src/…, as the declarations name them). */
const MODULES = [
  'CalendarDate',
  'types',
  'queries',
  'conversion',
  'string',
  'manipulation',
  'DateFormatter',
  'calendars/GregorianCalendar',
];

/** The exports the port covers. */
const PORTED = new Set([
  'CalendarDate',
  'CalendarDateTime',
  'Time',
  'ZonedDateTime',
  'GregorianCalendar',
  'DateFormatter',
  'toCalendarDate',
  'toCalendarDateTime',
  'toTime',
  'toCalendar',
  'toZoned',
  'toTimeZone',
  'toLocalTimeZone',
  'fromDate',
  'fromDateToLocal',
  'fromAbsolute',
  'isSameDay',
  'isSameMonth',
  'isSameYear',
  'isEqualDay',
  'isEqualMonth',
  'isEqualYear',
  'isEqualCalendar',
  'isToday',
  'getDayOfWeek',
  'now',
  'today',
  'getHoursInDay',
  'getLocalTimeZone',
  'startOfMonth',
  'startOfWeek',
  'startOfYear',
  'endOfMonth',
  'endOfWeek',
  'endOfYear',
  'getMinimumMonthInYear',
  'getMinimumDayInMonth',
  'getWeeksInMonth',
  'isWeekend',
  'isWeekday',
  'parseDate',
  'parseDateTime',
  'parseTime',
  'parseAbsolute',
  'parseAbsoluteToLocal',
  'parseZonedDateTime',
]);

/** Why an export is not covered. */
const REJECTED: Record<string, string> = {
  JapaneseCalendar: 'calendars other than the Gregorian calendar are not ported',
  BuddhistCalendar: 'calendars other than the Gregorian calendar are not ported',
  TaiwanCalendar: 'calendars other than the Gregorian calendar are not ported',
  PersianCalendar: 'calendars other than the Gregorian calendar are not ported',
  IndianCalendar: 'calendars other than the Gregorian calendar are not ported',
  IslamicCivilCalendar: 'calendars other than the Gregorian calendar are not ported',
  IslamicTabularCalendar: 'calendars other than the Gregorian calendar are not ported',
  IslamicUmalquraCalendar: 'calendars other than the Gregorian calendar are not ported',
  HebrewCalendar: 'calendars other than the Gregorian calendar are not ported',
  EthiopicCalendar: 'calendars other than the Gregorian calendar are not ported',
  EthiopicAmeteAlemCalendar: 'calendars other than the Gregorian calendar are not ported',
  CopticCalendar: 'calendars other than the Gregorian calendar are not ported',
  createCalendar: 'calendars other than the Gregorian calendar are not ported',
  setLocalTimeZone:
    'overriding the local time zone is not ported (the local time zone is the environment’s)',
  resetLocalTimeZone:
    'overriding the local time zone is not ported (the local time zone is the environment’s)',
};

export const internationalizedDatePack: Pack = {
  name: '@internationalized/date',
  version: '3.12.4',
  module: import.meta.url,
  ports: MODULES.map(m => ({ module: `dist/types/src/${m}`, file: PORT })),
  export(pkg, imported) {
    if (pkg.subpath !== '.') return `${LABEL} covers the main module, not ${pkg.subpath}`;
    if (PORTED.has(imported)) return { kind: 'ported' };
    if (imported in REJECTED) return `${LABEL}: ${imported}: ${REJECTED[imported]}`;
    return `${LABEL} does not cover ${imported} (it covers the Gregorian date values, their queries, conversions and parsers, and DateFormatter#format)`;
  },
};
