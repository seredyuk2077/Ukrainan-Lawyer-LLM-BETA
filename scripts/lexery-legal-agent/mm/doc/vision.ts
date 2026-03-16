import { config } from '../../lib/config.js';

interface VisionParseResult {
  lines: string[];
  warnings: string[];
  model: string;
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return fenced.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1).trim();
  return null;
}

function sanitizeVisionLines(lines: unknown): string[] {
  if (!Array.isArray(lines)) return [];
  return lines
    .map((line) => (typeof line === 'string' ? line.trim() : ''))
    .filter(Boolean)
    .slice(0, 48);
}

function normalizeVisionResponseText(content: string): { lines: string[]; warnings: string[] } {
  const jsonText = extractJsonObject(content);
  if (!jsonText) {
    const lines = content
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 32);
    return {
      lines,
      warnings: lines.length > 0 ? ['IMAGE_VISION_PARSE_FALLBACK_TEXT'] : ['IMAGE_VISION_EMPTY_OUTPUT'],
    };
  }

  try {
    const parsed = JSON.parse(jsonText) as {
      extracted_text_lines?: unknown;
      table_like_lines?: unknown;
      visual_notes?: unknown;
      warnings?: unknown;
    };
    const lines = [
      ...sanitizeVisionLines(parsed.extracted_text_lines),
      ...sanitizeVisionLines(parsed.table_like_lines),
      ...sanitizeVisionLines(parsed.visual_notes),
    ].slice(0, 64);
    const warnings = sanitizeVisionLines(parsed.warnings);
    return {
      lines,
      warnings: warnings.length > 0 ? warnings : lines.length > 0 ? [] : ['IMAGE_VISION_EMPTY_OUTPUT'],
    };
  } catch {
    const lines = content
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 32);
    return {
      lines,
      warnings: lines.length > 0 ? ['IMAGE_VISION_INVALID_JSON'] : ['IMAGE_VISION_EMPTY_OUTPUT'],
    };
  }
}

export async function parseMmDocImageWithVision(params: {
  buffer: Buffer;
  filename: string;
  contentType?: string;
}): Promise<VisionParseResult> {
  if (!config.mmDocsVisionEnabled) {
    throw new Error('MM Docs image vision parsing is disabled');
  }
  const apiKey = config.openRouterApiKey || process.env.OPENROUTER_API_KEY_BRAIN || process.env.OPENROUTER_API_KEY_ONLINE || '';
  if (!apiKey) {
    throw new Error('MM Docs image vision parsing requires OPENROUTER_API_KEY');
  }
  if (params.buffer.length > config.mmDocsVisionMaxImageBytes) {
    throw new Error(
      `MM Docs image too large for vision parse: ${params.buffer.length} > ${config.mmDocsVisionMaxImageBytes}`
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.mmDocsVisionTimeoutSec * 1000);
  try {
    const dataUrl = `data:${params.contentType || 'image/png'};base64,${params.buffer.toString('base64')}`;
    const prompt =
      'Extract only grounded information from this image document. ' +
      'Return strict JSON with keys: extracted_text_lines, table_like_lines, visual_notes, warnings. ' +
      'Keep it concise, preserve visible numbers/dates/amounts/labels, mention charts/graphs only as short factual notes, and do not invent missing text.';
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://lexery-legal-agent/mm-doc-vision',
      },
      body: JSON.stringify({
        model: config.mmDocsVisionModelId,
        temperature: 0,
        max_tokens: config.mmDocsVisionMaxTokens,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MM Docs image vision request failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> | null } }>;
    };
    const raw = json.choices?.[0]?.message?.content;
    const content =
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? raw.map((part) => part?.text ?? '').join('\n')
          : '';
    const normalized = normalizeVisionResponseText(content);
    return {
      lines: normalized.lines,
      warnings: normalized.warnings,
      model: config.mmDocsVisionModelId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/aborted|AbortError/i.test(message)) {
      throw new Error(`MM Docs image vision timeout after ${config.mmDocsVisionTimeoutSec}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
