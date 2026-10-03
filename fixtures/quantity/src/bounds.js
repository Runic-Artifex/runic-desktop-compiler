export function constrain(value, lower, upper) {
  return Math.min(Math.max(value, lower), upper);
}
