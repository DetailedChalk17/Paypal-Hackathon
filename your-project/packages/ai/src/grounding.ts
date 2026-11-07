// Rule: explanations may cite only numbers present in the input. These helpers
// find every number in a piece of model-written text and check each one
// against the numbers the model was given.

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

// "1,234.50" -> 1234.5, "40.00" -> 40, "75" -> 75
export function numbersIn(text: string): number[] {
  return (text.match(NUMBER) ?? [])
    .map((raw) => Number(raw.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
}

export function allowedNumbers(...sources: Array<string | number | null | undefined>): Set<number> {
  const set = new Set<number>();
  for (const source of sources) {
    if (source == null) continue;
    if (typeof source === "number") set.add(source);
    else for (const n of numbersIn(source)) set.add(n);
  }
  return set;
}

// True when every number cited in text appears in the allowed set.
export function citesOnlyAllowedNumbers(text: string, allowed: Set<number>): boolean {
  return numbersIn(text).every((n) => allowed.has(n));
}

export const formatDollars = (cents: number) =>
  "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
