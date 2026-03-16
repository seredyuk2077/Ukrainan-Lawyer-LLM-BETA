import { StorageError } from './storage.js';

export function isTransientGatewayIoError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (/fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|network/i.test(msg)) return true;
  if (err instanceof StorageError) {
    return /fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|network/i.test(err.message);
  }
  return false;
}

export async function withTransientGatewayIoRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 300
): Promise<T> {
  const maxAttempts = Math.max(1, attempts);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientGatewayIoError(err) || attempt === maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
