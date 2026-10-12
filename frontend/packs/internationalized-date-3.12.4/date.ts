// @internationalized/date 3.12.4 (src/CalendarDate.ts, manipulation.ts,
// conversion.ts, queries.ts, string.ts, DateFormatter.ts,
// calendars/GregorianCalendar.ts), ported to the language the compiler
// lowers: the pack (frontend/packs/internationalized-date-3.12.4.ts)
// compiles this module in place of the package's modules, as a module of a
// package compiled from source. The algorithms are the package's, statement
// for statement, for the Gregorian calendar and the AD era; what the port
// does not cover is reported where it runs (`unsupported`: probes stop) and
// thrown, never computed differently:
//
// - Only the Gregorian calendar. The other calendars, `createCalendar` and
//   the constructor overloads taking a calendar or an era are not exported
//   (E_PACK, or the call does not type: the constructors take the
//   `(year, month, day, …)` overload only). Dates of the BC era (a result
//   before year 1, `set({ era })`, parsing year 0 or before) are
//   unsupported. Every value is therefore AD, so the era branches of the
//   package (`isInverseEra`, `balanceDate`) never apply.
// - The package mutates a copy of a value (`date.copy()`, then field
//   writes); here a copy is a record of its fields made as the constructor
//   makes them (`|| 0` for time fields, `constrain`), the same statements
//   change the record, and the result is constructed from it as it is
//   (`exact`). Copies share the receiver's calendar object, as there.
// - Time zones: `getLocalTimeZone()` is the default zone
//   (`__runic.timeZone()`, unsupported when it is not verified against
//   Chromium). The package reads a zone's wall time with
//   `Intl.DateTimeFormat#formatToParts` (en-US, `hour12: false`, era); for
//   UTC and the default zone (also `undefined`, which Intl takes as the
//   default) these are the UTC and the local Date getters: Chromium's Intl
//   uses the proleptic Gregorian calendar and the zone data of Date, and
//   prints hour 0 as `00` (conformance/packs/internationalized-date.mjs
//   measures it). Other zones are unsupported. `setLocalTimeZone` is not
//   exported, so the local zone is never overridden.
// - Locales: week starts and regions come from `Intl.Locale#getWeekInfo`
//   and `maximize()` in Chromium; the verified locales' values were
//   measured there (same generator); other locales are unsupported.
// - DateFormatter formats with the runtime's verified Intl subset
//   (`__runic.formatDate`, `intl.format-date-runtime`): Chromium has no
//   buggy hour12 behaviour, so options pass to Intl as given, and options
//   or locales outside the subset are unsupported where the formatter is
//   constructed (Intl.DateTimeFormat validates there). `formatToParts`,
//   `formatRange`, `formatRangeToParts` and `resolvedOptions` are
//   unsupported.
// - `cycle`, `minDate`/`maxDate`, `parseDuration`, the calendar's
//   `balanceDate` and the `Calendar` interface's optional hooks are not
//   ported.
//
// @internationalized/date: Apache License 2.0, Copyright 2020 Adobe.

// ---------------------------------------------------------------- types

export type CalendarIdentifier =
  | 'buddhist'
  | 'ethiopic'
  | 'ethioaa'
  | 'coptic'
  | 'hebrew'
  | 'indian'
  | 'islamic-civil'
  | 'islamic-tbla'
  | 'islamic-umalqura'
  | 'japanese'
  | 'persian'
  | 'roc'
  | 'gregory';

export type Calendar = GregorianCalendar;
export type DateValue = CalendarDate | CalendarDateTime | ZonedDateTime;
export type AnyCalendarDate = DateValue;
export type AnyTime = Time | CalendarDateTime | ZonedDateTime;
export type AnyDateTime = CalendarDateTime | ZonedDateTime;

export interface DateDuration {
  years?: number;
  months?: number;
  weeks?: number;
  days?: number;
}

export interface TimeDuration {
  hours?: number;
  minutes?: number;
  seconds?: number;
  milliseconds?: number;
}

export interface DateTimeDuration {
  years?: number;
  months?: number;
  weeks?: number;
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  milliseconds?: number;
}

export interface DateFields {
  era?: string;
  year?: number;
  month?: number;
  day?: number;
}

export interface TimeFields {
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
}

export interface DateTimeFields {
  era?: string;
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
}

export type DateField = 'era' | 'year' | 'month' | 'day';
export type TimeField = 'hour' | 'minute' | 'second' | 'millisecond';
export type Disambiguation = 'compatible' | 'earlier' | 'later' | 'reject';
export type DayOfWeek = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

export interface CycleOptions {
  round?: boolean;
}

export interface CycleTimeOptions {
  round?: boolean;
  hourCycle?: 12 | 24;
}

/** The fields of a value as the package's mutable copies hold them. */
interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/** Reports what the port does not cover and returns the error to throw. */
function unsupported(what: string): Error {
  const message = `@internationalized/date@3.12.4 pack: ${what} is not supported`;
  __runic.unsupported(message);
  return new Error(message);
}

// ------------------------------------------------- calendars/GregorianCalendar

const EPOCH = 1721426; // 001/01/03 Julian C.E.

function gregorianToJulianDay(era: string, year: number, month: number, day: number): number {
  year = getExtendedYear(era, year);
  const y1 = year - 1;
  let monthOffset = -2;
  if (month <= 2) {
    monthOffset = 0;
  } else if (isLeapYear(year)) {
    monthOffset = -1;
  }
  return (
    EPOCH -
    1 +
    365 * y1 +
    Math.floor(y1 / 4) -
    Math.floor(y1 / 100) +
    Math.floor(y1 / 400) +
    Math.floor((367 * month - 362) / 12 + monthOffset + day)
  );
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function getExtendedYear(era: string, year: number): number {
  return era === 'BC' ? 1 - year : year;
}

function mod(amount: number, numerator: number): number {
  return amount - numerator * Math.floor(amount / numerator);
}

const STANDARD_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const LEAP_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * The package's `daysInMonth[…][month - 1]`, NaN where that index reads
 * undefined (a month that is not 1 to 12): every use of the value in the
 * package's arithmetic (`Math.min`, `+`, `-`, `>`) treats the two alike.
 */
function daysIn(year: number, month: number): number {
  const index = month - 1;
  if (!(Math.floor(index) === index && index >= 0 && index < 12)) return NaN;
  return isLeapYear(year) ? LEAP_DAYS[index] : STANDARD_DAYS[index];
}

export class GregorianCalendar {
  identifier: CalendarIdentifier = 'gregory';

  fromJulianDay(jd: number): CalendarDate {
    const jd0 = jd;
    const depoch = jd0 - EPOCH;
    const quadricent = Math.floor(depoch / 146097);
    const dqc = mod(depoch, 146097);
    const cent = Math.floor(dqc / 36524);
    const dcent = mod(dqc, 36524);
    const quad = Math.floor(dcent / 1461);
    const dquad = mod(dcent, 1461);
    const yindex = Math.floor(dquad / 365);
    const extendedYear =
      quadricent * 400 + cent * 100 + quad * 4 + yindex + (cent !== 4 && yindex !== 4 ? 1 : 0);
    // fromExtendedYear: years before 1 are of the BC era.
    if (extendedYear <= 0) throw unsupported('a date of the BC era');
    const era = 'AD';
    const year = extendedYear;
    const yearDay = jd0 - gregorianToJulianDay(era, year, 1, 1);
    let leapAdj = 2;
    if (jd0 < gregorianToJulianDay(era, year, 3, 1)) {
      leapAdj = 0;
    } else if (isLeapYear(year)) {
      leapAdj = 1;
    }
    const month = Math.floor(((yearDay + leapAdj) * 12 + 373) / 367);
    const day = jd0 - gregorianToJulianDay(era, year, month, 1) + 1;
    return new CalendarDate(year, month, day);
  }

  toJulianDay(date: DateValue): number {
    return gregorianToJulianDay(date.era, date.year, date.month, date.day);
  }

  getDaysInMonth(date: DateValue): number {
    const days = daysIn(date.year, date.month);
    // (The package returns undefined there.)
    if (days !== days) throw unsupported(`the days of month ${date.month}`);
    return days;
  }

  getMonthsInYear(_date: DateValue): number {
    return 12;
  }

  getDaysInYear(date: DateValue): number {
    return isLeapYear(date.year) ? 366 : 365;
  }

  getMaximumMonthsInYear(): number {
    return 12;
  }

  getMaximumDaysInMonth(): number {
    return 31;
  }

  getYearsInEra(_date: DateValue): number {
    return 9999;
  }

  getEras(): string[] {
    return ['BC', 'AD'];
  }

  isInverseEra(date: DateValue): boolean {
    return date.era === 'BC';
  }
}

// ------------------------------------------------------------ CalendarDate

/** `constrain` of a value's date fields (years 1 to 9999 of the AD era). */
function constrainDate(p: Parts): void {
  p.year = Math.max(1, Math.min(9999, p.year));
  constrainMonthDay(p);
}

function constrainMonthDay(p: Parts): void {
  p.month = Math.max(1, Math.min(12, p.month));
  p.day = Math.max(1, Math.min(daysIn(p.year, p.month), p.day));
}

function constrainTime(p: Parts): void {
  p.millisecond = Math.max(0, Math.min(p.millisecond, 999));
  p.second = Math.max(0, Math.min(p.second, 59));
  p.minute = Math.max(0, Math.min(p.minute, 59));
  p.hour = Math.max(0, Math.min(p.hour, 23));
}

/** The fields a constructor makes of its arguments (`|| 0`, then `constrain`). */
function constructed(
  year: number,
  month: number,
  day: number,
  hour: number | undefined,
  minute: number | undefined,
  second: number | undefined,
  millisecond: number | undefined,
): Parts {
  const p: Parts = {
    year,
    month,
    day,
    hour: hour || 0,
    minute: minute || 0,
    second: second || 0,
    millisecond: millisecond || 0,
  };
  constrainDate(p);
  return p;
}

/** The fields of a value (time fields 0 for a date). */
function partsOf(v: DateValue): Parts {
  if (v instanceof CalendarDate)
    return {
      year: v.year,
      month: v.month,
      day: v.day,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    };
  return {
    year: v.year,
    month: v.month,
    day: v.day,
    hour: v.hour,
    minute: v.minute,
    second: v.second,
    millisecond: v.millisecond,
  };
}

/** `value.copy()`: the value constructed again from its fields. */
function copyOf(p: Parts): Parts {
  return constructed(p.year, p.month, p.day, p.hour, p.minute, p.second, p.millisecond);
}

function dateOf(p: Parts, calendar: GregorianCalendar): CalendarDate {
  return new CalendarDate(p.year, p.month, p.day, calendar, true);
}

function dateTimeOf(p: Parts, calendar: GregorianCalendar): CalendarDateTime {
  return new CalendarDateTime(
    p.year,
    p.month,
    p.day,
    p.hour,
    p.minute,
    p.second,
    p.millisecond,
    calendar,
    true,
  );
}

export class CalendarDate {
  #type = 0;
  calendar: GregorianCalendar;
  era: string;
  year: number;
  month: number;
  day: number;

  /**
   * `new CalendarDate(year, month, day)`. (`calendar` and `exact` are the
   * port's: a copy's shared calendar, and fields taken as they are.)
   */
  constructor(
    year: number,
    month: number,
    day: number,
    calendar?: GregorianCalendar,
    exact?: boolean,
  ) {
    const p: Parts = exact
      ? { year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 }
      : constructed(year, month, day, 0, 0, 0, 0);
    this.calendar = calendar ?? new GregorianCalendar();
    this.era = 'AD';
    this.year = p.year;
    this.month = p.month;
    this.day = p.day;
  }

  copy(): CalendarDate {
    return dateOf(copyOf(partsOf(this)), this.calendar);
  }

  add(duration: DateTimeDuration): CalendarDate {
    return dateOf(addParts(copyOf(partsOf(this)), false, duration), this.calendar);
  }

  subtract(duration: DateTimeDuration): CalendarDate {
    return this.add(invertDuration(duration));
  }

  set(fields: DateTimeFields, _disambiguation?: Disambiguation): CalendarDate {
    return dateOf(setDate(copyOf(partsOf(this)), fields), this.calendar);
  }

  toDate(timeZone?: string, _disambiguation?: Disambiguation): Date {
    return toDate(this, timeZone);
  }

  toString(): string {
    return dateToString(this);
  }

  compare(b: DateValue): number {
    return compareDate(this, b);
  }
}

export class Time {
  #type = 0;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;

  /** `new Time(hour, minute, second, millisecond)` (`exact`: the port's, fields as they are). */
  constructor(
    hour?: number,
    minute?: number,
    second?: number,
    millisecond?: number,
    exact?: boolean,
  ) {
    const p: Parts = {
      year: 0,
      month: 0,
      day: 0,
      hour: hour ?? 0,
      minute: minute ?? 0,
      second: second ?? 0,
      millisecond: millisecond ?? 0,
    };
    if (!exact) constrainTime(p);
    this.hour = p.hour;
    this.minute = p.minute;
    this.second = p.second;
    this.millisecond = p.millisecond;
  }

  copy(): Time {
    return new Time(this.hour, this.minute, this.second, this.millisecond);
  }

  add(duration: TimeDuration): Time {
    const p = timeParts(this.copy());
    addTimeFields(p, duration.hours, duration.minutes, duration.seconds, duration.milliseconds);
    return new Time(p.hour, p.minute, p.second, p.millisecond, true);
  }

  subtract(duration: TimeDuration): Time {
    return this.add({
      hours: negate(duration.hours),
      minutes: negate(duration.minutes),
      seconds: negate(duration.seconds),
      milliseconds: negate(duration.milliseconds),
    });
  }

  set(fields: TimeFields): Time {
    const p = timeParts(this.copy());
    setTimeFields(p, fields.hour, fields.minute, fields.second, fields.millisecond);
    return new Time(p.hour, p.minute, p.second, p.millisecond, true);
  }

  toString(): string {
    return timeToString(this.hour, this.minute, this.second, this.millisecond);
  }

  compare(b: AnyTime): number {
    return compareTime(this, b);
  }
}

function timeParts(t: Time): Parts {
  return {
    year: 0,
    month: 0,
    day: 0,
    hour: t.hour,
    minute: t.minute,
    second: t.second,
    millisecond: t.millisecond,
  };
}

export class CalendarDateTime {
  #type = 0;
  calendar: GregorianCalendar;
  era: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;

  /**
   * `new CalendarDateTime(year, month, day, hour?, minute?, second?,
   * millisecond?)`. (`calendar` and `exact` are the port's.)
   */
  constructor(
    year: number,
    month: number,
    day: number,
    hour?: number,
    minute?: number,
    second?: number,
    millisecond?: number,
    calendar?: GregorianCalendar,
    exact?: boolean,
  ) {
    const p: Parts = exact
      ? {
          year,
          month,
          day,
          hour: hour ?? 0,
          minute: minute ?? 0,
          second: second ?? 0,
          millisecond: millisecond ?? 0,
        }
      : constructed(year, month, day, hour, minute, second, millisecond);
    this.calendar = calendar ?? new GregorianCalendar();
    this.era = 'AD';
    this.year = p.year;
    this.month = p.month;
    this.day = p.day;
    this.hour = p.hour;
    this.minute = p.minute;
    this.second = p.second;
    this.millisecond = p.millisecond;
  }

  copy(): CalendarDateTime {
    return dateTimeOf(copyOf(partsOf(this)), this.calendar);
  }

  add(duration: DateTimeDuration): CalendarDateTime {
    return dateTimeOf(addParts(copyOf(partsOf(this)), true, duration), this.calendar);
  }

  subtract(duration: DateTimeDuration): CalendarDateTime {
    return this.add(invertDuration(duration));
  }

  set(fields: DateTimeFields, _disambiguation?: Disambiguation): CalendarDateTime {
    // set(setTime(this, fields), fields): two copies.
    const p = copyOf(partsOf(this));
    setTimeFields(p, fields.hour, fields.minute, fields.second, fields.millisecond);
    return dateTimeOf(setDate(copyOf(p), fields), this.calendar);
  }

  toDate(timeZone?: string, disambiguation?: Disambiguation): Date {
    return toDate(this, timeZone, disambiguation);
  }

  toString(): string {
    return dateTimeToString(this);
  }

  compare(b: DateValue): number {
    const res = compareDate(this, b);
    if (res === 0) {
      return compareTime(this, toCalendarDateTime(b));
    }
    return res;
  }
}

export class ZonedDateTime {
  #type = 0;
  calendar: GregorianCalendar;
  era: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  timeZone: string;
  offset: number;

  /**
   * `new ZonedDateTime(year, month, day, timeZone, offset, hour?, minute?,
   * second?, millisecond?)`. (`calendar` and `exact` are the port's.)
   */
  constructor(
    year: number,
    month: number,
    day: number,
    timeZone: string,
    offset: number,
    hour?: number,
    minute?: number,
    second?: number,
    millisecond?: number,
    calendar?: GregorianCalendar,
    exact?: boolean,
  ) {
    const p: Parts = exact
      ? {
          year,
          month,
          day,
          hour: hour ?? 0,
          minute: minute ?? 0,
          second: second ?? 0,
          millisecond: millisecond ?? 0,
        }
      : constructed(year, month, day, hour, minute, second, millisecond);
    this.calendar = calendar ?? new GregorianCalendar();
    this.era = 'AD';
    this.year = p.year;
    this.month = p.month;
    this.day = p.day;
    this.timeZone = timeZone;
    this.offset = offset;
    this.hour = p.hour;
    this.minute = p.minute;
    this.second = p.second;
    this.millisecond = p.millisecond;
  }

  copy(): ZonedDateTime {
    const p = copyOf(partsOf(this));
    return new ZonedDateTime(
      p.year,
      p.month,
      p.day,
      this.timeZone,
      this.offset,
      p.hour,
      p.minute,
      p.second,
      p.millisecond,
      this.calendar,
      true,
    );
  }

  add(duration: DateTimeDuration): ZonedDateTime {
    return addZoned(this, duration);
  }

  subtract(duration: DateTimeDuration): ZonedDateTime {
    return addZoned(this, invertDuration(duration));
  }

  set(fields: DateTimeFields, disambiguation?: Disambiguation): ZonedDateTime {
    return setZoned(this, fields, disambiguation);
  }

  toDate(_timeZone?: string, _disambiguation?: Disambiguation): Date {
    return zonedToDate(this);
  }

  toString(): string {
    return zonedDateTimeToString(this);
  }

  toAbsoluteString(): string {
    return this.toDate().toISOString();
  }

  compare(b: DateValue): number {
    return this.toDate().getTime() - toZoned(b, this.timeZone).toDate().getTime();
  }
}

// ------------------------------------------------------------ manipulation

const ONE_HOUR = 3600000;

/** `add` of a copy's fields (`hasTime`: `'hour' in date`). */
function addParts(p: Parts, hasTime: boolean, duration: DateTimeDuration): Parts {
  const days = hasTime
    ? addTimeFields(p, duration.hours, duration.minutes, duration.seconds, duration.milliseconds)
    : 0;
  addYears(p, duration.years || 0);
  p.month += duration.months || 0;
  balanceYearMonth(p);
  constrainMonthDay(p);
  p.day += (duration.weeks || 0) * 7;
  p.day += duration.days || 0;
  p.day += days;
  balanceDay(p);
  // balanceDate: a year before 1 is a year of the BC era.
  if (p.year <= 0) throw unsupported('a date of the BC era');
  if (p.year < 1) {
    p.year = 1;
    p.month = 1;
    p.day = 1;
  }
  const maxYear = 9999;
  if (p.year > maxYear) {
    p.year = maxYear;
    p.month = 12;
    p.day = daysIn(p.year, p.month);
  }
  if (p.month < 1) {
    p.month = 1;
    p.day = 1;
  }
  const maxMonth = 12;
  if (p.month > maxMonth) {
    p.month = maxMonth;
    p.day = daysIn(p.year, p.month);
  }
  p.day = Math.max(1, Math.min(daysIn(p.year, p.month), p.day));
  return p;
}

// (isInverseEra is false: every value is AD until balanceDate.)
function addYears(p: Parts, years: number): void {
  p.year += years;
}

function balanceYearMonth(p: Parts): void {
  while (p.month < 1) {
    addYears(p, -1);
    p.month += 12;
  }
  // (The Gregorian calendar has twelve months in every year.)
  while (p.month > 12) {
    p.month -= 12;
    addYears(p, 1);
  }
}

function balanceDay(p: Parts): void {
  while (p.day < 1) {
    p.month--;
    balanceYearMonth(p);
    p.day += daysIn(p.year, p.month);
  }
  while (p.day > daysIn(p.year, p.month)) {
    p.day -= daysIn(p.year, p.month);
    p.month++;
    balanceYearMonth(p);
  }
}

function negate(x: number | undefined): number | undefined {
  return x === undefined ? undefined : -x;
}

/** `invertDuration`: the given numbers negated (absent ones stay absent). */
function invertDuration(d: DateTimeDuration): DateTimeDuration {
  return {
    years: negate(d.years),
    months: negate(d.months),
    weeks: negate(d.weeks),
    days: negate(d.days),
    hours: negate(d.hours),
    minutes: negate(d.minutes),
    seconds: negate(d.seconds),
    milliseconds: negate(d.milliseconds),
  };
}

/** `set` of a copy's date fields, then `constrain`. */
function setDate(p: Parts, fields: DateTimeFields): Parts {
  // (Fields are read into locals before their tests: the frontend narrows
  // locals, not property reads.)
  const era = fields.era;
  const year = fields.year;
  const month = fields.month;
  const day = fields.day;
  if (era != null && era !== 'AD') throw unsupported(`the era ${era}`);
  if (year != null) {
    p.year = year;
  }
  if (month != null) {
    p.month = month;
  }
  if (day != null) {
    p.day = day;
  }
  constrainDate(p);
  return p;
}

/** `setTime` of a copy's time fields, then `constrainTime`. */
function setTimeFields(
  p: Parts,
  hour: number | undefined,
  minute: number | undefined,
  second: number | undefined,
  millisecond: number | undefined,
): void {
  if (hour != null) {
    p.hour = hour;
  }
  if (minute != null) {
    p.minute = minute;
  }
  if (second != null) {
    p.second = second;
  }
  if (millisecond != null) {
    p.millisecond = millisecond;
  }
  constrainTime(p);
}

function balanceTime(p: Parts): number {
  p.second += Math.floor(p.millisecond / 1000);
  p.millisecond = nonNegativeMod(p.millisecond, 1000);
  p.minute += Math.floor(p.second / 60);
  p.second = nonNegativeMod(p.second, 60);
  p.hour += Math.floor(p.minute / 60);
  p.minute = nonNegativeMod(p.minute, 60);
  const days = Math.floor(p.hour / 24);
  p.hour = nonNegativeMod(p.hour, 24);
  return days;
}

function nonNegativeMod(a: number, b: number): number {
  let result = a % b;
  if (result < 0) {
    result += b;
  }
  return result;
}

function addTimeFields(
  p: Parts,
  hours: number | undefined,
  minutes: number | undefined,
  seconds: number | undefined,
  milliseconds: number | undefined,
): number {
  p.hour += hours || 0;
  p.minute += minutes || 0;
  p.second += seconds || 0;
  p.millisecond += milliseconds || 0;
  return balanceTime(p);
}

function addZoned(dateTime: ZonedDateTime, duration: DateTimeDuration): ZonedDateTime {
  let ms: number;
  const years = duration.years;
  const months = duration.months;
  const weeks = duration.weeks;
  const days = duration.days;
  if (
    (years != null && years !== 0) ||
    (months != null && months !== 0) ||
    (weeks != null && weeks !== 0) ||
    (days != null && days !== 0)
  ) {
    const res = toCalendarDateTime(dateTime).add({
      years: duration.years,
      months: duration.months,
      weeks: duration.weeks,
      days: duration.days,
    });
    ms = toAbsolute(res, dateTime.timeZone);
  } else {
    ms = epochFromDate(dateTime) - dateTime.offset;
  }
  ms += duration.milliseconds || 0;
  ms += (duration.seconds || 0) * 1000;
  ms += (duration.minutes || 0) * 60 * 1000;
  ms += (duration.hours || 0) * 60 * 60 * 1000;
  // toCalendar(…, dateTime.calendar) returns the value (one calendar).
  return fromAbsolute(ms, dateTime.timeZone);
}

function setZoned(
  dateTime: ZonedDateTime,
  fields: DateTimeFields,
  disambiguation?: Disambiguation,
): ZonedDateTime {
  const plainDateTime = toCalendarDateTime(dateTime);
  // setTime(set(plainDateTime, fields), fields)
  const p = copyOf(partsOf(plainDateTime));
  setDate(p, fields);
  const q = copyOf(p);
  setTimeFields(q, fields.hour, fields.minute, fields.second, fields.millisecond);
  const res = dateTimeOf(q, plainDateTime.calendar);
  if (res.compare(plainDateTime) === 0) {
    return dateTime;
  }
  const ms = toAbsolute(res, dateTime.timeZone, disambiguation);
  return fromAbsolute(ms, dateTime.timeZone);
}

// -------------------------------------------------------------- conversion

function epochFromDate(date: AnyDateTime): number {
  const year = getExtendedYear(date.era, date.year);
  return epochFromParts(
    year,
    date.month,
    date.day,
    date.hour,
    date.minute,
    date.second,
    date.millisecond,
  );
}

function epochFromParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): number {
  // (The package starts from `new Date()`; every field is set, so the start
  // is any instant: the epoch, which reads no clock.)
  const date = new Date(0);
  date.setUTCHours(hour, minute, second, millisecond);
  date.setUTCFullYear(year, month - 1, day);
  return date.getTime();
}

function getTimeZoneOffset(ms: number, timeZone: string | undefined): number {
  if (timeZone === 'UTC') {
    return 0;
  }
  if (ms > 0 && timeZone === getLocalTimeZone()) {
    return new Date(ms).getTimezoneOffset() * -60 * 1000;
  }
  const parts = getTimeZoneParts(ms, timeZone);
  const utc = epochFromParts(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0,
  );
  return utc - Math.floor(ms / 1000) * 1000;
}

/**
 * The wall time of `ms` in `timeZone` as the package reads it from
 * Intl.DateTimeFormat#formatToParts: the UTC or the local Date getters
 * (see the header); other zones are unsupported.
 */
function getTimeZoneParts(ms: number, timeZone: string | undefined): Parts {
  const date = new Date(ms);
  const utc = timeZone === 'UTC';
  if (!utc && timeZone !== undefined && timeZone !== getLocalTimeZone())
    throw unsupported(`the time zone ${timeZone} (UTC and the local time zone are)`);
  // formatToParts of an invalid date throws.
  if (date.getTime() !== date.getTime()) throw new RangeError('Invalid time value');
  return utc
    ? {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        second: date.getUTCSeconds(),
        millisecond: 0,
      }
    : {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        second: date.getSeconds(),
        millisecond: 0,
      };
}

const DAYMILLIS = 86400000;

function possibleAbsolutes(date: CalendarDateTime, timeZone: string): number[] {
  const ms = epochFromDate(date);
  const earlier = ms - getTimeZoneOffset(ms - DAYMILLIS, timeZone);
  const later = ms - getTimeZoneOffset(ms + DAYMILLIS, timeZone);
  return getValidWallTimes(date, timeZone, earlier, later);
}

function getValidWallTimes(
  date: CalendarDateTime,
  timeZone: string | undefined,
  earlier: number,
  later: number,
): number[] {
  const found = earlier === later ? [earlier] : [earlier, later];
  return found.filter(absolute => isValidWallTime(date, timeZone, absolute));
}

function isValidWallTime(
  date: CalendarDateTime,
  timeZone: string | undefined,
  absolute: number,
): boolean {
  const parts = getTimeZoneParts(absolute, timeZone);
  return (
    date.year === parts.year &&
    date.month === parts.month &&
    date.day === parts.day &&
    date.hour === parts.hour &&
    date.minute === parts.minute &&
    date.second === parts.second
  );
}

function toAbsolute(
  date: CalendarDate | CalendarDateTime,
  timeZone: string | undefined,
  given?: Disambiguation,
): number {
  // (Optional parameters with `??` stand for the package's defaults
  // throughout: an omitted argument of a defaulted parameter is not lowered
  // yet, docs/GAPS.md.)
  const disambiguation: Disambiguation = given ?? 'compatible';
  const dateTime = toCalendarDateTime(date);
  if (timeZone === 'UTC') {
    return epochFromDate(dateTime);
  }
  if (timeZone === getLocalTimeZone() && disambiguation === 'compatible') {
    // (The package starts from `new Date()` and sets every field. Its start
    // matters only where the start's local time of day falls in a gap of
    // the target day that crosses midnight, so that setFullYear moves into
    // the next day: there the package's result depends on when it runs.
    // The port starts from the epoch, which reads no clock, and reports a
    // target day whose end falls in a gap: exactly the days where some
    // start moves. UTC, Europe/Berlin and America/New_York have none.)
    const year = getExtendedYear(dateTime.era, dateTime.year);
    const end = new Date(0);
    end.setFullYear(year, dateTime.month - 1, dateTime.day);
    end.setHours(23, 59, 59, 999);
    if (end.getDate() !== dateTime.day)
      throw unsupported(
        'a local date whose day ends in a daylight-saving gap that crosses midnight',
      );
    const d = new Date(0);
    d.setFullYear(year, dateTime.month - 1, dateTime.day);
    d.setHours(dateTime.hour, dateTime.minute, dateTime.second, dateTime.millisecond);
    return d.getTime();
  }
  const ms = epochFromDate(dateTime);
  const offsetBefore = getTimeZoneOffset(ms - DAYMILLIS, timeZone);
  const offsetAfter = getTimeZoneOffset(ms + DAYMILLIS, timeZone);
  const valid = getValidWallTimes(dateTime, timeZone, ms - offsetBefore, ms - offsetAfter);
  if (valid.length === 1) {
    return valid[0];
  }
  if (valid.length > 1) {
    if (disambiguation === 'compatible' || disambiguation === 'earlier') return valid[0];
    if (disambiguation === 'later') return valid[valid.length - 1];
    if (disambiguation === 'reject') throw new RangeError('Multiple possible absolute times found');
  }
  if (disambiguation === 'earlier') return Math.min(ms - offsetBefore, ms - offsetAfter);
  if (disambiguation === 'compatible' || disambiguation === 'later')
    return Math.max(ms - offsetBefore, ms - offsetAfter);
  if (disambiguation === 'reject') throw new RangeError('No such absolute time found');
  // (The package returns undefined for other strings.)
  throw unsupported(`the disambiguation ${disambiguation}`);
}

function toDate(
  dateTime: CalendarDate | CalendarDateTime,
  timeZone: string | undefined,
  disambiguation?: Disambiguation,
): Date {
  return new Date(toAbsolute(dateTime, timeZone, disambiguation));
}

export function fromAbsolute(ms: number, timeZone: string): ZonedDateTime {
  const offset = getTimeZoneOffset(ms, timeZone);
  const date = new Date(ms + offset);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const second = date.getUTCSeconds();
  const millisecond = date.getUTCMilliseconds();
  if (year < 1) throw unsupported('a date of the BC era');
  return new ZonedDateTime(year, month, day, timeZone, offset, hour, minute, second, millisecond);
}

export function fromDate(date: Date, timeZone: string): ZonedDateTime {
  return fromAbsolute(date.getTime(), timeZone);
}

export function fromDateToLocal(date: Date): ZonedDateTime {
  return fromDate(date, getLocalTimeZone());
}

export function toCalendarDate(dateTime: DateValue): CalendarDate {
  return new CalendarDate(dateTime.year, dateTime.month, dateTime.day, dateTime.calendar);
}

export function toCalendarDateTime(date: DateValue, time?: AnyTime): CalendarDateTime {
  let hour = 0;
  let minute = 0;
  let second = 0;
  let millisecond = 0;
  if (date instanceof ZonedDateTime) {
    hour = date.hour;
    minute = date.minute;
    second = date.second;
    millisecond = date.millisecond;
  } else if (date instanceof CalendarDateTime && !time) {
    return date;
  }
  if (time) {
    hour = time.hour;
    minute = time.minute;
    second = time.second;
    millisecond = time.millisecond;
  }
  return new CalendarDateTime(
    date.year,
    date.month,
    date.day,
    hour,
    minute,
    second,
    millisecond,
    date.calendar,
  );
}

export function toTime(dateTime: AnyDateTime): Time {
  return new Time(dateTime.hour, dateTime.minute, dateTime.second, dateTime.millisecond);
}

/** `toCalendar` to the Gregorian calendar (the only one): the value itself. */
export function toCalendar(date: DateValue, _calendar: GregorianCalendar): DateValue {
  return date;
}

export function toZoned(
  date: DateValue,
  timeZone: string,
  disambiguation?: Disambiguation,
): ZonedDateTime {
  if (date instanceof ZonedDateTime) {
    if (date.timeZone === timeZone) {
      return date;
    }
    return toTimeZone(date, timeZone);
  }
  const ms = toAbsolute(date, timeZone, disambiguation);
  return fromAbsolute(ms, timeZone);
}

function zonedToDate(date: ZonedDateTime): Date {
  const ms = epochFromDate(date) - date.offset;
  return new Date(ms);
}

export function toTimeZone(date: ZonedDateTime, timeZone: string): ZonedDateTime {
  const ms = epochFromDate(date) - date.offset;
  return fromAbsolute(ms, timeZone);
}

export function toLocalTimeZone(date: ZonedDateTime): ZonedDateTime {
  return toTimeZone(date, getLocalTimeZone());
}

// ----------------------------------------------------------------- queries

export function isSameDay(a: DateValue, b: DateValue): boolean {
  return a.era === b.era && a.year === b.year && a.month === b.month && a.day === b.day;
}

export function isSameMonth(a: DateValue, b: DateValue): boolean {
  const a1 = startOfMonth(a);
  const b1 = startOfMonth(b);
  return a1.era === b1.era && a1.year === b1.year && a1.month === b1.month;
}

export function isSameYear(a: DateValue, b: DateValue): boolean {
  const a1 = startOfYear(a);
  const b1 = startOfYear(b);
  return a1.era === b1.era && a1.year === b1.year;
}

export function isEqualDay(a: DateValue, b: DateValue): boolean {
  return isEqualCalendar(a.calendar, b.calendar) && isSameDay(a, b);
}

export function isEqualMonth(a: DateValue, b: DateValue): boolean {
  return isEqualCalendar(a.calendar, b.calendar) && isSameMonth(a, b);
}

export function isEqualYear(a: DateValue, b: DateValue): boolean {
  return isEqualCalendar(a.calendar, b.calendar) && isSameYear(a, b);
}

export function isEqualCalendar(a: GregorianCalendar, b: GregorianCalendar): boolean {
  return a.identifier === b.identifier;
}

export function isToday(date: DateValue, timeZone: string): boolean {
  return isSameDay(date, today(timeZone));
}

function dayIndex(day: DayOfWeek): number {
  switch (day) {
    case 'sun':
      return 0;
    case 'mon':
      return 1;
    case 'tue':
      return 2;
    case 'wed':
      return 3;
    case 'thu':
      return 4;
    case 'fri':
      return 5;
    case 'sat':
      return 6;
  }
  throw unsupported(`the day ${day}`);
}

export function getDayOfWeek(date: DateValue, locale: string, firstDayOfWeek?: DayOfWeek): number {
  const julian = date.calendar.toJulianDay(date);
  const weekStart = firstDayOfWeek ? dayIndex(firstDayOfWeek) : getWeekStart(locale);
  let dayOfWeek = Math.ceil(julian + 1 - weekStart) % 7;
  if (dayOfWeek < 0) {
    dayOfWeek += 7;
  }
  return dayOfWeek;
}

export function now(timeZone: string): ZonedDateTime {
  return fromAbsolute(Date.now(), timeZone);
}

export function today(timeZone: string): CalendarDate {
  return toCalendarDate(now(timeZone));
}

function compareDate(a: DateValue, b: DateValue): number {
  return a.calendar.toJulianDay(a) - b.calendar.toJulianDay(b);
}

function compareTime(a: AnyTime, b: AnyTime): number {
  return timeToMs(a) - timeToMs(b);
}

function timeToMs(a: AnyTime): number {
  return a.hour * 60 * 60 * 1000 + a.minute * 60 * 1000 + a.second * 1000 + a.millisecond;
}

export function getHoursInDay(a: CalendarDate, timeZone: string): number {
  const ms = toAbsolute(a, timeZone);
  const tomorrow = a.add({ days: 1 });
  const tomorrowMs = toAbsolute(tomorrow, timeZone);
  return (tomorrowMs - ms) / 3600000;
}

/** `new Intl.DateTimeFormat().resolvedOptions().timeZone`. */
export function getLocalTimeZone(): string {
  return __runic.timeZone();
}

export function startOfMonth(date: DateValue): DateValue {
  return date.subtract({ days: date.day - 1 });
}

export function endOfMonth(date: DateValue): DateValue {
  return date.add({ days: daysIn(date.year, date.month) - date.day });
}

export function startOfYear(date: DateValue): DateValue {
  return startOfMonth(date.subtract({ months: date.month - 1 }));
}

export function endOfYear(date: DateValue): DateValue {
  return endOfMonth(date.add({ months: 12 - date.month }));
}

export function getMinimumMonthInYear(_date: DateValue): number {
  return 1;
}

export function getMinimumDayInMonth(_date: DateValue): number {
  return 1;
}

export function startOfWeek(
  date: DateValue,
  locale: string,
  firstDayOfWeek?: DayOfWeek,
): DateValue {
  const dayOfWeek = getDayOfWeek(date, locale, firstDayOfWeek);
  return date.subtract({ days: dayOfWeek });
}

export function endOfWeek(date: DateValue, locale: string, firstDayOfWeek?: DayOfWeek): DateValue {
  return startOfWeek(date, locale, firstDayOfWeek).add({ days: 6 });
}

/**
 * `new Intl.Locale(locale).maximize().region` in Chromium, for the
 * verified locales (conformance/packs/internationalized-date.mjs).
 */
function getRegion(locale: string): string {
  switch (locale) {
    case 'en-US':
    case 'en':
      return 'US';
    case 'en-GB':
      return 'GB';
    case 'de-DE':
    case 'de':
      return 'DE';
    case 'fr-FR':
    case 'fr':
      return 'FR';
    case 'ja-JP':
    case 'ja':
      return 'JP';
  }
  throw unsupported(
    `the locale ${locale} (verified: en-US, en-GB, de-DE, fr-FR, ja-JP, en, de, fr, ja)`,
  );
}

/**
 * `new Intl.Locale(locale).getWeekInfo().firstDay` in Chromium (1 Monday
 * to 7 Sunday), which the package prefers to its own week data.
 */
function getWeekStart(locale: string): number {
  switch (getRegion(locale)) {
    case 'US':
    case 'JP':
      return 7;
    default:
      return 1;
  }
}

export function getWeeksInMonth(
  date: DateValue,
  locale: string,
  firstDayOfWeek?: DayOfWeek,
): number {
  const days = daysIn(date.year, date.month);
  return Math.ceil((getDayOfWeek(startOfMonth(date), locale, firstDayOfWeek) + days) / 7);
}

export function isWeekend(date: DateValue, locale: string): boolean {
  const julian = date.calendar.toJulianDay(date);
  let dayOfWeek = Math.ceil(julian + 1) % 7;
  if (dayOfWeek < 0) {
    dayOfWeek += 7;
  }
  // WEEKEND_DATA has none of the verified locales' regions: [6, 0].
  getRegion(locale);
  return dayOfWeek === 6 || dayOfWeek === 0;
}

export function isWeekday(date: DateValue, locale: string): boolean {
  return !isWeekend(date, locale);
}

// ------------------------------------------------------------------ string

const TIME_RE = /^(\d{2})(?::(\d{2}))?(?::(\d{2}))?(\.\d+)?$/;
const DATE_RE = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE =
  /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?(?::(\d{2}))?(?::(\d{2}))?(\.\d+)?$/;
const ZONED_DATE_TIME_RE =
  /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?(?::(\d{2}))?(?::(\d{2}))?(\.\d+)?(?:([+-]\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)?\[(.*?)\]$/;
const ABSOLUTE_RE =
  /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?(?::(\d{2}))?(?::(\d{2}))?(\.\d+)?(?:(?:([+-]\d{2})(?::?(\d{2}))?)|Z)$/;

export function parseTime(value: string): Time {
  const m = value.match(TIME_RE);
  if (!m) {
    throw new Error('Invalid ISO 8601 time string: ' + value);
  }
  return new Time(
    parseNumber(m[1], 0, 23),
    m[2] ? parseNumber(m[2], 0, 59) : 0,
    m[3] ? parseNumber(m[3], 0, 59) : 0,
    m[4] ? parseNumber(m[4], 0, Infinity) * 1000 : 0,
  );
}

export function parseDate(value: string): CalendarDate {
  const m = value.match(DATE_RE);
  if (!m) {
    if (ABSOLUTE_RE.test(value)) {
      throw new Error(`Invalid ISO 8601 date string: ${value}. Use parseAbsolute() instead.`);
    }
    throw new Error('Invalid ISO 8601 date string: ' + value);
  }
  const date = new CalendarDate(parseNumber(m[1], 0, 9999), parseNumber(m[2], 1, 12), 1);
  const day = parseNumber(m[3], 1, daysIn(date.year, date.month));
  return new CalendarDate(date.year, date.month, day, date.calendar, true);
}

export function parseDateTime(value: string): CalendarDateTime {
  const m = value.match(DATE_TIME_RE);
  if (!m) {
    if (ABSOLUTE_RE.test(value)) {
      throw new Error(`Invalid ISO 8601 date time string: ${value}. Use parseAbsolute() instead.`);
    }
    throw new Error('Invalid ISO 8601 date time string: ' + value);
  }
  const year = parseNumber(m[1], -9999, 9999);
  if (year < 1) throw unsupported('a date of the BC era');
  const date = new CalendarDateTime(
    year,
    parseNumber(m[2], 1, 12),
    1,
    m[4] ? parseNumber(m[4], 0, 23) : 0,
    m[5] ? parseNumber(m[5], 0, 59) : 0,
    m[6] ? parseNumber(m[6], 0, 59) : 0,
    m[7] ? parseNumber(m[7], 0, Infinity) * 1000 : 0,
  );
  const p = partsOf(date);
  p.day = parseNumber(m[3], 0, daysIn(date.year, date.month));
  return dateTimeOf(p, date.calendar);
}

export function parseZonedDateTime(value: string, disambiguation?: Disambiguation): ZonedDateTime {
  const m = value.match(ZONED_DATE_TIME_RE);
  if (!m) {
    throw new Error('Invalid ISO 8601 date time string: ' + value);
  }
  const year = parseNumber(m[1], -9999, 9999);
  if (year < 1) throw unsupported('a date of the BC era');
  const timeZone = m[11];
  const made = new ZonedDateTime(
    year,
    parseNumber(m[2], 1, 12),
    1,
    timeZone,
    0,
    m[4] ? parseNumber(m[4], 0, 23) : 0,
    m[5] ? parseNumber(m[5], 0, 59) : 0,
    m[6] ? parseNumber(m[6], 0, 59) : 0,
    m[7] ? parseNumber(m[7], 0, Infinity) * 1000 : 0,
  );
  const p = partsOf(made);
  // (`date.day = …` writes the field as it is; toCalendarDateTime(date)
  // constructs a value of it, which constrains it.)
  p.day = parseNumber(m[3], 0, daysIn(made.year, made.month));
  const plainDateTime = new CalendarDateTime(
    p.year,
    p.month,
    p.day,
    p.hour,
    p.minute,
    p.second,
    p.millisecond,
    made.calendar,
  );
  let ms: number;
  if (m[8]) {
    const hourOffset = parseNumber(m[8], -23, 23);
    const offset =
      Math.sign(hourOffset) *
      (Math.abs(hourOffset) * 60 * 60 * 1000 +
        parseNumber(m[9] ?? '0', 0, 59) * 60 * 1000 +
        parseNumber(m[10] ?? '0', 0, 59) * 1000);
    const date = new ZonedDateTime(
      p.year,
      p.month,
      p.day,
      timeZone,
      offset,
      p.hour,
      p.minute,
      p.second,
      p.millisecond,
      made.calendar,
      true,
    );
    ms = epochFromDate(date) - date.offset;
    const absolutes = possibleAbsolutes(plainDateTime, timeZone);
    if (!absolutes.includes(ms)) {
      throw new Error(
        `Offset ${offsetToString(date.offset)} is invalid for ${dateTimeToString(date)} in ${timeZone}`,
      );
    }
  } else {
    ms = toAbsolute(plainDateTime, timeZone, disambiguation);
  }
  return fromAbsolute(ms, timeZone);
}

export function parseAbsolute(value: string, timeZone: string): ZonedDateTime {
  const m = value.match(ABSOLUTE_RE);
  if (!m) {
    throw new Error('Invalid ISO 8601 date time string: ' + value);
  }
  const year = parseNumber(m[1], -9999, 9999);
  if (year < 1) throw unsupported('a date of the BC era');
  const made = new CalendarDateTime(
    year,
    parseNumber(m[2], 1, 12),
    1,
    m[4] ? parseNumber(m[4], 0, 23) : 0,
    m[5] ? parseNumber(m[5], 0, 59) : 0,
    m[6] ? parseNumber(m[6], 0, 59) : 0,
    m[7] ? parseNumber(m[7], 0, Infinity) * 1000 : 0,
  );
  const p = partsOf(made);
  p.day = parseNumber(m[3], 0, daysIn(made.year, made.month));
  let offset = 0;
  if (m[8]) {
    offset =
      parseNumber(m[8], -23, 23) * 60 * 60 * 1000 + parseNumber(m[9] ?? '0', 0, 59) * 60 * 1000;
  }
  // toTimeZone(date, timeZone)
  const ms = epochFromDate(dateTimeOf(p, made.calendar)) - offset;
  return fromAbsolute(ms, timeZone);
}

export function parseAbsoluteToLocal(value: string): ZonedDateTime {
  return parseAbsolute(value, getLocalTimeZone());
}

function parseNumber(value: string, min: number, max: number): number {
  const val = Number(value);
  if (val < min || val > max) {
    throw new RangeError(`Value out of range: ${min} <= ${val} <= ${max}`);
  }
  return val;
}

function timeToString(hour: number, minute: number, second: number, millisecond: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}${millisecond ? String(millisecond / 1000).slice(1) : ''}`;
}

function dateToString(date: DateValue): string {
  // (BC years are not reached: every value is AD.)
  const year = String(date.year).padStart(4, '0');
  return `${year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function dateTimeToString(date: AnyDateTime): string {
  return `${dateToString(date)}T${timeToString(date.hour, date.minute, date.second, date.millisecond)}`;
}

function offsetToString(offset: number): string {
  const sign = Math.sign(offset) < 0 ? '-' : '+';
  offset = Math.abs(offset);
  const offsetHours = Math.floor(offset / (60 * 60 * 1000));
  const offsetMinutes = Math.floor((offset % (60 * 60 * 1000)) / (60 * 1000));
  const offsetSeconds = Math.floor(((offset % (60 * 60 * 1000)) % (60 * 1000)) / 1000);
  let stringOffset = `${sign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;
  if (offsetSeconds !== 0) {
    stringOffset += `:${String(offsetSeconds).padStart(2, '0')}`;
  }
  return stringOffset;
}

function zonedDateTimeToString(date: ZonedDateTime): string {
  return `${dateTimeToString(date)}${offsetToString(date.offset)}[${date.timeZone}]`;
}

// ----------------------------------------------------------- DateFormatter

/** An option of the `intl.*` option string (`;` and `=` separate them). */
function option(out: string[], key: string, value: string | undefined): void {
  if (value === undefined) return;
  if (value.includes(';') || value.includes('='))
    throw unsupported(`the Intl.DateTimeFormat option ${key}: ${value}`);
  out.push(`${key}=${value}`);
}

function dateFormatSpec(o: Intl.DateTimeFormatOptions): string {
  const out = ['m=f'];
  option(out, 'localeMatcher', o.localeMatcher);
  option(out, 'weekday', o.weekday);
  option(out, 'era', o.era);
  option(out, 'year', o.year);
  option(out, 'month', o.month);
  option(out, 'day', o.day);
  option(out, 'hour', o.hour);
  option(out, 'minute', o.minute);
  option(out, 'second', o.second);
  option(out, 'timeZoneName', o.timeZoneName);
  option(out, 'formatMatcher', o.formatMatcher);
  const hour12 = o.hour12;
  option(out, 'hour12', hour12 === undefined ? undefined : hour12 ? 'true' : 'false');
  option(out, 'timeZone', o.timeZone);
  option(out, 'calendar', o.calendar);
  option(out, 'dayPeriod', o.dayPeriod);
  option(out, 'numberingSystem', o.numberingSystem);
  option(out, 'dateStyle', o.dateStyle);
  option(out, 'timeStyle', o.timeStyle);
  option(out, 'hourCycle', o.hourCycle);
  const digits = o.fractionalSecondDigits;
  option(out, 'fractionalSecondDigits', digits === undefined ? undefined : String(digits));
  return out.join(';');
}

export class DateFormatter {
  #locale: string;
  #spec: string;

  constructor(locale: string, options?: Intl.DateTimeFormatOptions) {
    const spec = dateFormatSpec(options ?? {});
    // new Intl.DateTimeFormat(locale, options) checks both here.
    __runic.formatDate(0, spec, locale);
    this.#locale = locale;
    this.#spec = spec;
  }

  format(value: Date): string {
    return __runic.formatDate(value.getTime(), this.#spec, this.#locale);
  }

  formatToParts(_value: Date): Intl.DateTimeFormatPart[] {
    throw unsupported('DateFormatter#formatToParts');
  }

  formatRange(_start: Date, _end: Date): string {
    throw unsupported('DateFormatter#formatRange');
  }
}
