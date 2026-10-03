export function limitIncrease(current, amount, maximum) {
  return Math.min(current + amount, maximum);
}
