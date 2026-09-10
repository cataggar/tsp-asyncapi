/** Object member order is insignificant in JSON; array order and primitive types are not. */
export function identityOf(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const entries = Object.entries(item as Record<string, unknown>);
    entries.sort(([a], [b]) => a.localeCompare(b) || compareCodePoints(a, b));
    return Object.fromEntries(entries);
  });
}

function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
