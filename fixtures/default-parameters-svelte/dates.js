// Untyped helpers in the shape of bits-ui's internal/date-time/utils.js:
// each is specialised for the types its callers pass, and instanceof of a
// pack class is decided by the class the value carries.
import { CalendarDate, CalendarDateTime, ZonedDateTime, endOfMonth } from '@internationalized/date';

function isCalendarDateTime(dateValue) {
  return dateValue instanceof CalendarDateTime;
}

export function isZonedDateTime(dateValue) {
  return dateValue instanceof ZonedDateTime;
}

export function hasTime(dateValue) {
  return isCalendarDateTime(dateValue) || isZonedDateTime(dateValue);
}

export function isCalendarDate(value) {
  return value instanceof CalendarDate;
}

export function daysInMonth(date) {
  if (date instanceof Date) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    return new Date(year, month, 0).getDate();
  } else {
    return endOfMonth(date).day;
  }
}
