const OpenAI = require('openai');
const logger = require('../utils/logger');

class OpenAIService {
  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    this.systemPrompt = `Ти — "Український Юрист" — експертний AI-асистент з українського права.

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

    this.defaultConfig = {
      model: 'gpt-4-turbo-preview',
      max_tokens: 1500,
      temperature: 0.3,
      presence_penalty: 0.1,
      frequency_penalty: 0.1
    };
  }

  async generateResponse(messages, sessionId) {
    try {
      logger.info('Generating OpenAI response', { 
        sessionId: this.hashSessionId(sessionId),
        messageCount: messages.length 
      });

      const response = await this.client.chat.completions.create({
        ...this.defaultConfig,
        messages: [
          { role: 'system', content: this.systemPrompt },
          ...messages.map(msg => ({
            role: msg.role,
            content: msg.content
          }))
        ]
      });

      const aiResponse = response.choices[0].message.content;
      const tokensUsed = response.usage?.total_tokens || 0;

      logger.info('OpenAI response generated', {
        sessionId: this.hashSessionId(sessionId),
        tokensUsed,
        responseLength: aiResponse.length
      });

      return {
        content: aiResponse,
        tokensUsed
      };

    } catch (error) {
      logger.error('OpenAI API Error:', {
        error: error.message,
        sessionId: this.hashSessionId(sessionId),
        type: error.type || 'unknown'
      });

      // Handle specific OpenAI errors
      if (error.status === 429) {
        throw new Error('Занадто багато запитів. Спробуйте пізніше.');
      } else if (error.status === 401) {
        throw new Error('Помилка автентифікації API.');
      } else if (error.status >= 500) {
        throw new Error('Сервіс тимчасово недоступний. Спробуйте пізніше.');
      } else {
        throw new Error('Помилка генерації відповіді. Спробуйте ще раз.');
      }
    }
  }

  async checkHealth() {
    try {
      const response = await this.client.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'Test' }],
        max_tokens: 5
      });
      return { status: 'healthy', message: 'OpenAI API accessible' };
    } catch (error) {
      return { 
        status: 'unhealthy', 
        message: `OpenAI API error: ${error.message}` 
      };
    }
  }

  // Hash session ID for logging (privacy)
  hashSessionId(sessionId) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(sessionId).digest('hex').substring(0, 8);
  }

  // Get fallback response when OpenAI is unavailable
  getFallbackResponse() {
    const fallbackResponses = [
      "Вибачте, наразі сервіс тимчасово недоступний. Спробуйте пізніше або зверніться до професійного юриста.",
      "Технічні роботи на сервері. Ваше питання важливе - рекомендую звернутися до кваліфікованого юриста.",
      "Сервіс перевантажений. Для термінових питань зверніться до безоплатної правової допомоги: 0 800 213 103"
    ];
    
    return fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
  }
}

module.exports = new OpenAIService();