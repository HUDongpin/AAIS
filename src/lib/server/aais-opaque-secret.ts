const minimumOpaqueSecretBytes = 32;
const maximumOpaqueSecretBytes = 512;
const obviousOpaqueSecretPattern = /^(?:change|replace|todo|tbd|example|sample|test)[-_ ]?me/i;

export function isAaisStrongOpaqueSecret(
  value: string | null | undefined,
): value is string {
  const secret = value?.trim() ?? "";
  if (!secret || secret !== value || /\s/.test(secret)) {
    return false;
  }
  const byteLength = Buffer.byteLength(secret, "utf8");
  return byteLength >= minimumOpaqueSecretBytes
    && byteLength <= maximumOpaqueSecretBytes
    && new Set([...secret]).size >= 8
    && !obviousOpaqueSecretPattern.test(secret)
    && !/^(?:password|secret|changeme)$/i.test(secret);
}

export function areAaisOpaqueSecretsDistinct(
  values: ReadonlyArray<string | null | undefined>,
) {
  const configured = values
    .map((value) => value?.trim() ?? "")
    .filter(Boolean);
  return new Set(configured).size === configured.length;
}
