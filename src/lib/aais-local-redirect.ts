const localRedirectFallback = "/learning";

export function normalizeAaisLocalRedirectTarget(
  value: string | null | undefined,
  fallback = localRedirectFallback,
) {
  return isSafeAaisLocalRedirectTarget(value) ? value : fallback;
}

export function isSafeAaisLocalRedirectTarget(
  value: string | null | undefined,
): value is string {
  if (!value) {
    return false;
  }

  let candidate = value;
  for (let pass = 0; pass < 4; pass += 1) {
    if (!isPlainLocalPath(candidate)) {
      return false;
    }
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) {
        return true;
      }
      candidate = decoded;
    } catch {
      return false;
    }
  }

  return isPlainLocalPath(candidate);
}

function isPlainLocalPath(value: string) {
  return value.startsWith("/")
    && !value.startsWith("//")
    && !/[\\\u0000-\u001F\u007F]/.test(value);
}
