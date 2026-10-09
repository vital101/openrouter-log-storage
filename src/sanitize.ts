const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function sanitizeString(value: string): string {
  return value
    .replace(/\u0000/g, "\uFFFD")
    .replace(UNPAIRED_SURROGATE, "\uFFFD");
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (value !== null && typeof value === "object" && isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        sanitizeString(key),
        sanitizeJsonValue(entry),
      ]),
    );
  }
  return value;
}
