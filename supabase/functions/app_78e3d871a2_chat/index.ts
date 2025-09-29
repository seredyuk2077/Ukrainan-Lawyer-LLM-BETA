import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://esm.sh/openai@4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

Deno.serve(async (req) => {
  // Generate unique request ID for logging
  const requestId = crypto.randomUUID();
  
  const headersObj: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headersObj[key] = value;
  });
  
  console.log(`[${requestId}] Request received:`, {
    method: req.method,
    url: req.url,
    headers: headersObj
  });

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || 'https://lhltmmzwvikdgxxakbcl.supabase.co';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY');
    console.log(`[${requestId}] Supabase URL: ${supabaseUrl}`);
    console.log(`[${requestId}] Supabase key: ${supabaseKey ? '***' + supabaseKey.slice(-4) : 'NOT SET'}`);
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase environment variables not set');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Initialize OpenAI client
    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
    
    if (!openaiApiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    const openai = new OpenAI({
      apiKey: openaiApiKey
    });

    let body;
    try {
      body = await req.json();
    } catch (error) {
      console.error(`[${requestId}] Invalid JSON:`, error);
      return new Response(
        JSON.stringify({ error: 'Невірний формат JSON' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { messages, sessionId, userMessage } = body;

    if (!sessionId) {
      return new Response(
        JSON.stringify({ error: 'Session ID обов\'язковий' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[${requestId}] Processing chat request:`, {
      sessionId: sessionId.substring(0, 8),
      messageCount: messages?.length || 0,
      hasUserMessage: !!userMessage
    });

    // Verify session exists
    const { data: session, error: sessionError } = await supabase
      .from('chat_sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('is_active', true)
      .single();

    if (sessionError || !session) {
      console.error(`[${requestId}] Session not found:`, sessionError);
      return new Response(
        JSON.stringify({ error: 'Сесію не знайдено' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Save user message if provided
    if (userMessage) {
      const { error: userMsgError } = await supabase
        .from('chat_messages')
        .insert({
          session_id: sessionId,
          role: 'user',
          content: userMessage,
          tokens_used: 0
        });

      if (userMsgError) {
        console.error(`[${requestId}] Error saving user message:`, userMsgError);
        return new Response(
          JSON.stringify({ error: 'Помилка збереження повідомлення' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // System prompt for Ukrainian lawyer
    const systemPrompt = `Ти — "Mike Ross" — експертний AI-асистент з українського права.

ПРАВИЛА РОБОТИ:
1. Відповідай ЛИШЕ українською мовою
2. Спеціалізуйся на українському законодавстві: Конституція України, ЦК України, ГК України, КК України, КУпАП, ТК України
3. Завжди починай відповідь коротким резюме (1-2 речення)
4. Цитуй конкретні статті у форматі: "ст. X Назва закону"
5. Додавай посилання на офіційні джерела (zakon.rada.gov.ua, pravo.minjust.gov.ua)
6. Якщо питання виходить за межі твоєї компетенції - чесно про це скажи
7. Не надавай конкретні юридичні послуги, лише загальні пояснення
8. Поважай конфіденційність - не зберігай персональні дані

ФОРМАТ ВІДПОВІДІ:
- Коротке резюме
- Детальне пояснення з посиланнями на закони
- Рекомендації щодо подальших дій (якщо потрібно)

СТИЛЬ:
- Професійний, але доступний
- Структурований з використанням списків та підзаголовків
- Конкретний з практичними порадами`;

    // Prepare messages for OpenAI
    const openaiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    console.log(`[${requestId}] Calling OpenAI API with ${openaiMessages.length} messages`);

    // Generate AI response
    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo-preview',
      messages: openaiMessages,
      max_tokens: 1500,
      temperature: 0.3,
      presence_penalty: 0.1,
      frequency_penalty: 0.1
    });

    const aiResponse = completion.choices[0].message.content;
    const tokensUsed = completion.usage?.total_tokens || 0;

    console.log(`[${requestId}] OpenAI response generated:`, {
      responseLength: aiResponse?.length || 0,
      tokensUsed
    });

    if (!aiResponse) {
      throw new Error('Порожня відповідь від OpenAI');
    }

    // Save AI response
    const { error: aiMsgError } = await supabase
      .from('chat_messages')
      .insert({
        session_id: sessionId,
        role: 'assistant',
        content: aiResponse,
        tokens_used: tokensUsed
      });

    if (aiMsgError) {
      console.error(`[${requestId}] Error saving AI message:`, aiMsgError);
      return new Response(
        JSON.stringify({ error: 'Помилка збереження відповіді' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Update session title if it's the first user message
    if (userMessage && messages.filter((m: any) => m.role === 'user').length === 1) {
      const title = userMessage.length > 50 ? userMessage.substring(0, 47) + '...' : userMessage;
      await supabase
        .from('chat_sessions')
        .update({ title })
        .eq('id', sessionId);
    }

    console.log(`[${requestId}] Request completed successfully`);

    return new Response(
      JSON.stringify({
        response: aiResponse,
        tokensUsed,
        sessionId
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    const err = error as Error & { status?: number };
    console.error(`[${requestId}] Error in chat function:`, {
      message: err.message,
      stack: err.stack,
      name: err.name
    });

    // Handle specific OpenAI errors
    let errorMessage = 'Внутрішня помилка сервера';
    let statusCode = 500;

    if (err.status === 429) {
      errorMessage = 'Занадто багато запитів. Спробуйте пізніше.';
      statusCode = 429;
    } else if (err.status === 401) {
      errorMessage = 'Помилка автентифікації API.';
      statusCode = 401;
    } else if (err.status && err.status >= 500) {
      errorMessage = 'Сервіс тимчасово недоступний. Спробуйте пізніше.';
      statusCode = 503;
    } else if (err.message.includes('OpenAI')) {
      errorMessage = 'Помилка AI сервісу. Спробуйте пізніше.';
    }

    return new Response(
      JSON.stringify({ 
        error: errorMessage,
        requestId 
      }),
      { 
        status: statusCode, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});