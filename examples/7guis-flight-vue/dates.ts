// Dates of 7GUIs Flight Booker, shared by the framework versions.
//
// Differences from the 7GUIs task (https://eugenkiss.github.io/7guis/tasks):
// both fields start at a fixed date (27.03.2014, as in the original
// implementations) rather than today, so the app does not depend on the
// clock, and the booking message is shown in the page instead of a dialog.

const pattern = /^(\d{2})\.(\d{2})\.(\d{4})$/;

/**
 * The time value (UTC midnight) of a date written as dd.mm.yyyy, or null when
 * the text is not such a date or names a day the calendar does not have.
 */
export function parseDate(text: string): number | null {
  const m = pattern.exec(text);
  if (m === null) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return time;
}
