import { describe, expect, it } from 'vitest';

const buildFunctionUrl = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    // fallback to known project ref if env is not available in CI
    const projectRef = 'lhltmmzwvikdgxxakbcl';
    return `https://${projectRef}.functions.supabase.co/app_78e3d871a2_chat`;
  }
  const projectRef = new URL(supabaseUrl).host.split('.')[0];
  return `https://${projectRef}.functions.supabase.co/app_78e3d871a2_chat`;
};

const callFunction = async (body: any) => {
  const url = buildFunctionUrl();
  const anonKey = process.env.SUPABASE_ANON_KEY as string;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave as null
  }

  return { res, json, raw: text };
};

describe('Supreme Court RAG HTTP integration (prod edge function)', () => {
  it('handles premium request and returns structured response', async () => {
    const { res, json } = await callFunction({
      userMessage:
        'Потрібна практика Верховного Суду щодо виселення з орендованого житла за ст. 12 ЦК України.',
      isPremiumUser: true
    });

    expect(res.status).toBe(200);
    expect(json).toHaveProperty('response');
    expect(json).toHaveProperty('debug');
    expect(json.debug).toHaveProperty('supremeCourt');
  });

  it('handles non-premium request and respects Supreme Court gating', async () => {
    const { res, json } = await callFunction({
      userMessage:
        'Потрібна практика Верховного Суду щодо виселення з орендованого житла за ст. 12 ЦК України.',
      isPremiumUser: false
    });

    expect(res.status).toBe(200);
    expect(json).toHaveProperty('response');
    expect(json).toHaveProperty('debug');
    expect(json.debug).toHaveProperty('supremeCourt');
    if (Array.isArray(json.supremeCourtCases)) {
      expect(json.supremeCourtCases.length).toBeLessThanOrEqual(1);
    }
  });

  it('does not trigger Supreme Court for non-legal question', async () => {
    const { res, json } = await callFunction({
      userMessage: 'Як приготувати борщ?',
      isPremiumUser: true
    });

    expect(res.status).toBe(200);
    expect(json).toHaveProperty('debug');
    expect(json.debug.supremeCourt.enabled).toBe(false);
  });

  it('returns 400 for malformed payload without userMessage', async () => {
    const { res } = await callFunction({
      foo: 'bar'
    });

    expect(res.status).toBe(400);
  });
});


