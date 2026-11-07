// Converts an amount exactly as printed ("$1,234.50", "12", "0.5") to integer
// cents using string arithmetic only. Anything ambiguous returns null.
export function parseMoneyToCents(value: string | null | undefined): number | null {
  if (value == null) return null;
  const cleaned = value.trim().replace(/^(USD|US\$|\$)\s*/i, "").replace(/,/g, "");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "0").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function parseQuantity(value: string | null | undefined): number | null {
  if (value == null) return null;
  const cleaned = value.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}
