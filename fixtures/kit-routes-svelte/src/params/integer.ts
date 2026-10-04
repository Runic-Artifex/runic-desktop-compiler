// The `integer` param matcher: `[id=integer]` matches digits only.
export function match(param: string): boolean {
  return /^\d+$/.test(param);
}
