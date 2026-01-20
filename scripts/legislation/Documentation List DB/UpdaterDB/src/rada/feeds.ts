import type { Logger } from 'pino';
import { safeUrl } from '../utils.js';
import type { RadaHttpClient } from './client.js';
import { extractNregFromRadaHref } from './nreg.js';

export const RADA_UPDATED_FEED_URL = 'https://data.rada.gov.ua/laws/main/r.txt';
export const RADA_NEW_TODAY_FEED_URL = 'https://data.rada.gov.ua/laws/main/nn';
export const RADA_BACKSTOP_30D_FEED_URL = 'https://data.rada.gov.ua/laws/main/n';

export interface FeedResult {
  status: 200 | 304;
  lastModified: string | null;
  nregs: string[];
}

function parseUpdatedFeed(text: string): string[] {
  // r.txt is a plain-text list. In the wild it may contain extra columns.
  const out: string[] = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue;
    const first = t.split(/\s+/g)[0]?.trim();
    if (!first) continue;
    if (first.toLowerCase() === 'nreg') continue;
    out.push(first);
  }
  return out;
}

function extractNregsFromHtml(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  for (;;) {
    const m = re.exec(html);
    if (!m) break;
    const href = m[1];
    if (!href) continue;
    if (!href.includes('/laws/show/') && !href.includes('/go/')) continue;
    const nreg = extractNregFromRadaHref(href);
    if (!nreg) continue;
    // Defensive filters against malformed href parsing (observed: stray "r", "a", etc).
    if (nreg.length < 3) continue;
    if (!/\d/.test(nreg)) continue;
    if (seen.has(nreg)) continue;
    seen.add(nreg);
    out.push(nreg);
  }
  return out;
}

export async function fetchUpdatedFeed(params: {
  logger: Logger;
  client: RadaHttpClient;
  ifModifiedSince?: string | null;
}): Promise<FeedResult> {
  const res = await params.client.fetchText(RADA_UPDATED_FEED_URL, { ifModifiedSince: params.ifModifiedSince });
  if (!res.ok) {
    throw new Error(`Failed to fetch updated feed: ${safeUrl(RADA_UPDATED_FEED_URL)} (status=${res.status})`);
  }
  if (res.status === 304) {
    params.logger.info({ url: safeUrl(RADA_UPDATED_FEED_URL) }, 'rada updated feed: 304 not modified');
    return { status: 304, lastModified: res.lastModified, nregs: [] };
  }
  const nregs = parseUpdatedFeed(res.data || '');
  params.logger.info({ url: safeUrl(RADA_UPDATED_FEED_URL), count: nregs.length }, 'rada updated feed fetched');
  return { status: 200, lastModified: res.lastModified, nregs };
}

export async function fetchNewTodayFeed(params: {
  logger: Logger;
  client: RadaHttpClient;
  ifModifiedSince?: string | null;
}): Promise<FeedResult> {
  const res = await params.client.fetchText(RADA_NEW_TODAY_FEED_URL, { ifModifiedSince: params.ifModifiedSince });
  if (!res.ok) {
    throw new Error(`Failed to fetch new-today feed: ${safeUrl(RADA_NEW_TODAY_FEED_URL)} (status=${res.status})`);
  }
  if (res.status === 304) {
    params.logger.info({ url: safeUrl(RADA_NEW_TODAY_FEED_URL) }, 'rada new-today feed: 304 not modified');
    return { status: 304, lastModified: res.lastModified, nregs: [] };
  }
  const nregs = extractNregsFromHtml(res.data || '');
  params.logger.info({ url: safeUrl(RADA_NEW_TODAY_FEED_URL), count: nregs.length }, 'rada new-today feed fetched');
  return { status: 200, lastModified: res.lastModified, nregs };
}

export async function fetchBackstop30dFeed(params: {
  logger: Logger;
  client: RadaHttpClient;
  ifModifiedSince?: string | null;
}): Promise<FeedResult> {
  const res = await params.client.fetchText(RADA_BACKSTOP_30D_FEED_URL, { ifModifiedSince: params.ifModifiedSince });
  if (!res.ok) {
    throw new Error(`Failed to fetch backstop feed: ${safeUrl(RADA_BACKSTOP_30D_FEED_URL)} (status=${res.status})`);
  }
  if (res.status === 304) {
    params.logger.info({ url: safeUrl(RADA_BACKSTOP_30D_FEED_URL) }, 'rada backstop feed: 304 not modified');
    return { status: 304, lastModified: res.lastModified, nregs: [] };
  }
  const nregs = extractNregsFromHtml(res.data || '');
  params.logger.info({ url: safeUrl(RADA_BACKSTOP_30D_FEED_URL), count: nregs.length }, 'rada backstop feed fetched');
  return { status: 200, lastModified: res.lastModified, nregs };
}

