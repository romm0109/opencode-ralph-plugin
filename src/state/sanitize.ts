/** Runtime values are read only for redaction and never serialized as configuration. */
export function referencedSecretValues(names: string[]): string[] {
  return names.flatMap((name) => {
    const value = process.env[name];
    return value &&
      (/TOKEN|PASSWORD|SECRET|API_?KEY|PRIVATE_?KEY/i.test(name) ||
        value.length >= 8)
      ? [value]
      : [];
  });
}
export function runtimeSecretValues(): string[] {
  return Object.entries(process.env)
    .filter(
      ([name, value]) =>
        /TOKEN|PASSWORD|SECRET|API_?KEY|PRIVATE_?KEY/i.test(name) && !!value,
    )
    .map(([, value]) => value as string);
}
export function sanitizeDisplay(
  value: string,
  secrets: readonly string[] = [],
): string {
  let clean = value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal escape bytes.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: remove control bytes from untrusted output.
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  for (const secret of secrets)
    if (secret) clean = clean.split(secret).join("[REDACTED]");
  return clean
    .replace(/\b(Bearer\s+)[\w.+/=-]+/gi, "$1[REDACTED]")
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]");
}

/** Redact strings before serialization, including quotes and nested typed causes. */
export function sanitizeValue<T>(value: T, secrets: readonly string[] = []): T {
  if (typeof value === "string") return sanitizeDisplay(value, secrets) as T;
  if (Array.isArray(value))
    return value.map((item) => sanitizeValue(item, secrets)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeValue(item, secrets),
      ]),
    ) as T;
  return value;
}
