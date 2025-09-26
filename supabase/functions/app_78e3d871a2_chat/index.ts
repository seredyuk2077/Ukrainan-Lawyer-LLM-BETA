import { createClient } from 'npm:@supabase/supabase-js@2';
import OpenAI from 'npm:openai@4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

Deno.serve(async (req) => {
  // Generate unique request ID for logging
  const requestId = crypto.randomUUID();
  
  console.log(`[${requestId}] Request received:`, {
    method: req.method,
    url: req.url,
    headers: Object.fromEntries(req.headers.entries())
  });

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // Initialize Supabase client
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Initialize OpenAI client
    const openai = new OpenAI({
      apiKey: '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'
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
    if (userMessage && messages.filter(m => m.role === 'user').length === 1) {
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
    console.error(`[${requestId}] Error in chat function:`, {
      message: error.message,
      stack: error.stack,
      name: error.name
    });

    // Handle specific OpenAI errors
    let errorMessage = 'Внутрішня помилка сервера';
    let statusCode = 500;

    if (error.status === 429) {
      errorMessage = 'Занадто багато запитів. Спробуйте пізніше.';
      statusCode = 429;
    } else if (error.status === 401) {
      errorMessage = 'Помилка автентифікації API.';
      statusCode = 401;
    } else if (error.status >= 500) {
      errorMessage = 'Сервіс тимчасово недоступний. Спробуйте пізніше.';
      statusCode = 503;
    } else if (error.message.includes('OpenAI')) {
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