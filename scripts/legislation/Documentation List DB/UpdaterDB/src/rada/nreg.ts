export function encodeNregForPath(nreg: string): string {
  // CRITICAL: do not encode "/" as %2F.
  // We encode each segment between slashes.
  const raw = String(nreg || '');
  const parts = raw.split('/');
  const encoded = parts.map((p) => encodeURIComponent(p));
  return encoded.join('/');
}

export function decodeNregFromHrefPathTail(tailPath: string): string {
  // The tailPath may contain percent-encoded segments; decode safely per-segment.
  // We intentionally preserve "/" separators.
  const raw = String(tailPath || '').replace(/^\/+/, '');
  const parts = raw.split('/');
  const decoded = parts.map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  return decoded.join('/');
}

export function extractNregFromLawsShowHref(href: string): string | null {
  return extractNregFromRadaHref(href, ['/laws/show/']);
}

export function extractNregFromRadaHref(href: string, prefixes: string[] = ['/laws/show/', '/go/']): string | null {
  // Known href shapes observed in the wild:
  // - /laws/show/<nreg>
  // - /go/<nreg>
  //
  // nreg can include slashes and unicode. We decode each path segment.
  try {
    const u = new URL(href, 'https://data.rada.gov.ua');
    const p = u.pathname || '';
    for (const prefix of prefixes) {
      if (!p.startsWith(prefix)) continue;
      const tail = p.slice(prefix.length);
      if (!tail) return null;
      return decodeNregFromHrefPathTail(tail);
    }
    return null;
  } catch {
    // Best-effort fallback for raw strings.
    for (const prefix of prefixes) {
      const safePrefix = prefix.replace(/\//g, '\\/');
      const re = new RegExp(`${safePrefix}([^"'#?]+)`, 'i');
      const m = href.match(re);
      if (m?.[1]) return decodeNregFromHrefPathTail(m[1]);
    }
    return null;
  }
}

