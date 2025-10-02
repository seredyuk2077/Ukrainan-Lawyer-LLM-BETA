const OpenAI = require('openai');
const logger = require('../utils/logger');

class OpenAIService {
  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    this.systemPrompt = `Ти — український юрист-асистент.

ПРАВИЛА:
1. Відповідай українською
2. Використовуй ТІЛЬКИ наданий контекст
3. Цитуй статті: "ст. X Назва закону"
4. Якщо немає інформації - скажи про це
5. Не вигадуй закони

ФОРМАТ: резюме → пояснення → рекомендації`;

    this.defaultConfig = {
      model: 'gpt-3.5-turbo', // Перемкнули на GPT-3.5 для економії токенів
      max_tokens: 500, // Ще більше зменшили для економії
      temperature: 0.1, // Ще більш детерміновані відповіді
      presence_penalty: 0.0,
      frequency_penalty: 0.0
    };
  }

  async generateResponse(messages, sessionId) {
    try {
      logger.info('Generating OpenAI response', { 
        sessionId: this.hashSessionId(sessionId),
        messageCount: messages.length,
        model: this.defaultConfig.model, // Додаємо модель в логи
        maxTokens: this.defaultConfig.max_tokens
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
        responseLength: aiResponse.length,
        model: this.defaultConfig.model,
        usage: response.usage // Додаємо детальну інформацію про використання
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