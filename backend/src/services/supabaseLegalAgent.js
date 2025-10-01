const { query } = require('../config/supabase');
const radaOfficialApiParser = require('./radaOfficialApiParser');
const logger = require('../utils/logger');
const crypto = require('crypto');

class SupabaseLegalAgent {
  constructor() {
    this.systemPrompt = `Ти — "Український Юрист" — експертний AI-асистент з українського права.

ПРАВИЛА РОБОТИ:
1. Відповідай ЛИШЕ українською мовою
2. Спеціалізуйся на українському законодавстві
3. Завжди починай відповідь коротким резюме (1-2 речення)
4. Цитуй конкретні статті у форматі: "ст. X Назва закону"
5. Додавай посилання на офіційні джерела (zakon.rada.gov.ua)
6. Якщо питання виходить за межі твоєї компетенції - чесно про це скажи
7. Не надавай конкретні юридичні послуги, лише загальні пояснення
8. Поважай конфіденційність - не зберігай персональні дані
9. ВИКОРИСТОВУЙ ТІЛЬКИ НАДАНИЙ КОНТЕКСТ - не вигадуй закони
10. Якщо в контексті немає інформації - скажи про це

ФОРМАТ ВІДПОВІДІ:
- Коротке резюме
- Детальне пояснення з посиланнями на закони
- Рекомендації щодо подальших дій (якщо потрібно)
- Джерела інформації

СТИЛЬ:
- Професійний, але доступний
- Структурований з використанням списків та підзаголовків
- Конкретний з практичними порадами`;

    this.legalCategories = {
      'цивільне': ['договір', 'власність', 'спадщина', 'шкода', 'відшкодування', 'купівля', 'продаж'],
      'трудове': ['робота', 'заробітна плата', 'відпустка', 'звільнення', 'трудовий договір', 'роботодавець', 'працівник'],
      'сімейне': ['шлюб', 'розлучення', 'діти', 'аліменти', 'сім\'я', 'подружжя'],
      'кримінальне': ['злочин', 'кримінал', 'покарання', 'вбивство', 'крадіжка', 'шахрайство'],
      'господарське': ['бізнес', 'підприємство', 'господарство', 'комерція', 'торгівля', 'ФОП'],
      'адміністративне': ['штраф', 'порушення', 'адміністративне', 'поліція', 'протокол']
    };
  }

  // Основна функція генерації відповіді
  async generateResponse(userMessage, sessionId, conversationHistory = []) {
    try {
      logger.info('Supabase Legal Agent generating response', { 
        sessionId: this.hashSessionId(sessionId),
        messageLength: userMessage.length 
      });

      // 1. Класифікація питання
      const questionAnalysis = this.analyzeQuestion(userMessage);
      
      // 2. Пошук релевантної інформації
      const relevantContext = await this.retrieveRelevantContext(questionAnalysis);
      
      // 3. Перевірка кешу
      const cachedResponse = await this.getCachedResponse(userMessage);
      if (cachedResponse && this.isCacheValid(cachedResponse)) {
        logger.info('Using cached response', { 
          sessionId: this.hashSessionId(sessionId),
          cacheHit: true 
        });
        return {
          content: cachedResponse.answer_text,
          tokensUsed: cachedResponse.tokens_used,
          sources: cachedResponse.law_references,
          fromCache: true
        };
      }

      // 4. Генерація контексту для OpenAI
      const enhancedContext = this.buildEnhancedContext(questionAnalysis, relevantContext, conversationHistory);
      
      // 5. Валідація та обмеження токенів
      const optimizedContext = this.optimizeContextForTokens(enhancedContext);

      return {
        content: optimizedContext,
        tokensUsed: this.estimateTokens(optimizedContext),
        sources: relevantContext.sources,
        fromCache: false,
        questionAnalysis
      };

    } catch (error) {
      logger.error('Error in Supabase Legal Agent', { 
        error: error.message,
        sessionId: this.hashSessionId(sessionId)
      });
      
      return {
        content: this.getFallbackResponse(),
        tokensUsed: 0,
        sources: [],
        fromCache: false,
        error: true
      };
    }
  }

  // Аналіз питання користувача
  analyzeQuestion(message) {
    const lowerMessage = message.toLowerCase();
    
    // Визначення категорії права
    const categories = [];
    Object.entries(this.legalCategories).forEach(([category, keywords]) => {
      const matchCount = keywords.filter(keyword => 
        lowerMessage.includes(keyword)
      ).length;
      if (matchCount > 0) {
        categories.push({ category, score: matchCount });
      }
    });

    // Сортування за релевантністю
    categories.sort((a, b) => b.score - a.score);

    // Витягування ключових слів
    const keywords = this.extractKeywords(message);
    
    // Визначення типу питання
    const questionType = this.determineQuestionType(message);

    return {
      originalMessage: message,
      categories: categories.map(c => c.category),
      primaryCategory: categories[0]?.category || 'загальне',
      keywords,
      questionType,
      complexity: this.assessComplexity(message)
    };
  }

  // Витягування ключових слів
  extractKeywords(message) {
    const stopWords = new Set([
      'що', 'як', 'де', 'коли', 'чому', 'хто', 'який', 'яка', 'яке',
      'але', 'або', 'та', 'і', 'в', 'на', 'з', 'до', 'від', 'про',
      'для', 'за', 'під', 'над', 'між', 'серед', 'без', 'через'
    ]);

    return message
      .toLowerCase()
      .replace(/[^\u0400-\u04FF\s]/g, '') // Тільки українські літери
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word))
      .slice(0, 10); // Максимум 10 ключових слів
  }

  // Визначення типу питання
  determineQuestionType(message) {
    const lowerMessage = message.toLowerCase();
    
    if (lowerMessage.includes('що таке') || lowerMessage.includes('що означає')) {
      return 'definition';
    }
    if (lowerMessage.includes('як') && lowerMessage.includes('оформити')) {
      return 'procedure';
    }
    if (lowerMessage.includes('чи можна') || lowerMessage.includes('чи маю')) {
      return 'permission';
    }
    if (lowerMessage.includes('які права') || lowerMessage.includes('які обов\'язки')) {
      return 'rights_obligations';
    }
    if (lowerMessage.includes('якщо') || lowerMessage.includes('у випадку')) {
      return 'scenario';
    }
    
    return 'general';
  }

  // Оцінка складності питання
  assessComplexity(message) {
    const indicators = {
      simple: ['що', 'як', 'де', 'коли'],
      medium: ['договір', 'права', 'обов\'язки', 'відповідальність'],
      complex: ['суперечка', 'позов', 'суд', 'розгляд', 'апеляція', 'касація']
    };

    let score = 0;
    Object.entries(indicators).forEach(([level, words]) => {
      const matches = words.filter(word => message.toLowerCase().includes(word)).length;
      if (level === 'simple') score += matches * 1;
      if (level === 'medium') score += matches * 2;
      if (level === 'complex') score += matches * 3;
    });

    if (score <= 2) return 'simple';
    if (score <= 5) return 'medium';
    return 'complex';
  }

  // Пошук релевантного контексту
  async retrieveRelevantContext(questionAnalysis) {
    try {
      const { keywords, primaryCategory, questionType } = questionAnalysis;
      
      // Пошук в базі даних
      const dbResults = await this.searchInDatabase(keywords, 5);
      
      // Пошук в rada.gov.ua (якщо результатів мало)
      let webResults = [];
      if (dbResults.length < 3) {
        webResults = await radaParser.hybridSearch(keywords, 3);
      }

      // Об'єднання результатів
      const allResults = [...dbResults, ...webResults];
      
      // Сортування за релевантністю
      const sortedResults = this.rankResults(allResults, questionAnalysis);
      
      // Витягування найрелевантніших
      const topResults = sortedResults.slice(0, 3);
      
      return {
        laws: topResults,
        sources: topResults.map(r => ({
          title: r.title,
          url: r.source_url || r.link,
          lawNumber: r.law_number
        })),
        totalFound: allResults.length
      };

    } catch (error) {
      logger.error('Error retrieving context', { 
        error: error.message,
        keywords: questionAnalysis.keywords 
      });
      return { laws: [], sources: [], totalFound: 0 };
    }
  }

  // Пошук в базі даних
  async searchInDatabase(keywords, limit) {
    try {
      // Спочатку шукаємо в локальній базі
      const result = await query('legal_laws', 'select', {
        select: 'id, title, content, law_number, source_url, articles',
        limit: limit
      });

      // Filter results using text search
      const filteredResults = result.rows.filter(row => {
        const text = `${row.title} ${row.content}`.toLowerCase();
        return keywords.some(keyword => text.includes(keyword.toLowerCase()));
      });

      const localLaws = filteredResults.map(row => ({
        ...row,
        rank: 1.0 // Basic ranking for now
      }));

      // Якщо в локальній базі мало результатів, шукаємо через API
      if (localLaws.length < 2) {
        logger.info('🔍 Searching laws via official Rada API', { keywords, limit, localLawsCount: localLaws.length });
        
        try {
          const apiLaws = await radaOfficialApiParser.searchLaws(keywords, limit);
          logger.info('📊 API search results', { found: apiLaws.length, keywords });
          
          if (apiLaws.length > 0) {
            // Зберігаємо нові закони в базу
            await radaOfficialApiParser.saveLawsToDatabase(apiLaws);
            logger.info('💾 Laws saved to database', { count: apiLaws.length });
            
            // Повертаємо комбінацію локальних та нових законів
            const combinedLaws = [...localLaws, ...apiLaws.slice(0, limit - localLaws.length)];
            logger.info('✅ Combined laws result', { total: combinedLaws.length, local: localLaws.length, api: apiLaws.length });
            return combinedLaws;
          } else {
            logger.warn('⚠️ No laws found via API', { keywords });
          }
        } catch (apiError) {
          logger.warn('Official Rada API search failed, using local results only:', apiError.message);
        }
      } else {
        logger.info('✅ Using local laws only', { count: localLaws.length });
      }

      return localLaws;

    } catch (error) {
      logger.error('Error searching database', { error: error.message, keywords });
      return [];
    }
  }

  // Ранжування результатів
  rankResults(results, questionAnalysis) {
    return results.map(result => {
      let score = result.rank || 0;
      
      // Бонус за збіг категорії
      if (questionAnalysis.categories.includes(result.category)) {
        score += 0.5;
      }
      
      // Бонус за збіг ключових слів в заголовку
      const titleMatches = questionAnalysis.keywords.filter(keyword =>
        result.title.toLowerCase().includes(keyword)
      ).length;
      score += titleMatches * 0.3;
      
      return { ...result, relevanceScore: score };
    }).sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  // Побудова покращеного контексту
  buildEnhancedContext(questionAnalysis, relevantContext, conversationHistory) {
    let context = this.systemPrompt + '\n\n';
    
    // Додавання релевантних законів
    if (relevantContext.laws.length > 0) {
      context += 'РЕЛЕВАНТНІ ПРАВОВІ ДЖЕРЕЛА:\n\n';
      
      relevantContext.laws.forEach((law, index) => {
        context += `${index + 1}. ${law.title}\n`;
        if (law.law_number) {
          context += `   Номер: ${law.law_number}\n`;
        }
        context += `   Джерело: ${law.source_url || law.link}\n`;
        context += `   Зміст: ${law.content.substring(0, 500)}...\n\n`;
      });
    }

    // Додавання контексту розмови (якщо є)
    if (conversationHistory.length > 0) {
      context += 'КОНТЕКСТ РОЗМОВИ:\n';
      conversationHistory.slice(-3).forEach(msg => {
        context += `${msg.role}: ${msg.content}\n`;
      });
      context += '\n';
    }

    // Додавання аналізу питання
    context += `АНАЛІЗ ПИТАННЯ:\n`;
    context += `- Категорія права: ${questionAnalysis.primaryCategory}\n`;
    context += `- Тип питання: ${questionAnalysis.questionType}\n`;
    context += `- Складність: ${questionAnalysis.complexity}\n`;
    context += `- Ключові слова: ${questionAnalysis.keywords.join(', ')}\n\n`;

    context += `ПИТАННЯ КОРИСТУВАЧА: ${questionAnalysis.originalMessage}\n\n`;
    context += `ВІДПОВІДЬ (використовуй ТІЛЬКИ надану вище інформацію):`;

    return context;
  }

  // Оптимізація контексту для токенів
  optimizeContextForTokens(context, maxTokens = 3000) {
    const estimatedTokens = this.estimateTokens(context);
    
    if (estimatedTokens <= maxTokens) {
      return context;
    }

    // Якщо контекст занадто великий, скорочуємо його
    const lines = context.split('\n');
    let optimizedContext = '';
    let currentTokens = 0;
    
    for (const line of lines) {
      const lineTokens = this.estimateTokens(line);
      if (currentTokens + lineTokens > maxTokens) {
        break;
      }
      optimizedContext += line + '\n';
      currentTokens += lineTokens;
    }

    return optimizedContext + '\n[Контекст скорочено для оптимізації]';
  }

  // Оцінка кількості токенів
  estimateTokens(text) {
    // Приблизна оцінка: 1 токен ≈ 4 символи для української мови
    return Math.ceil(text.length / 4);
  }

  // Перевірка кешу
  async getCachedResponse(question) {
    try {
      const questionHash = crypto.createHash('sha256').update(question.toLowerCase().trim()).digest('hex');
      
      const result = await query('response_cache', 'select', {
        eq: { column: 'question_hash', value: questionHash },
        limit: 1
      });

      if (result.rows.length > 0) {
        return result.rows[0];
      }

      return null;
    } catch (error) {
      logger.error('Error checking cache', { error: error.message });
      return null;
    }
  }

  // Перевірка валідності кешу
  isCacheValid(cachedResponse) {
    return cachedResponse && 
           new Date(cachedResponse.expires_at) > new Date() && 
           cachedResponse.quality_score >= 3;
  }

  // Збереження відповіді в кеш
  async cacheResponse(question, answer, sources, tokensUsed, qualityScore = 3) {
    try {
      const questionHash = crypto.createHash('sha256').update(question.toLowerCase().trim()).digest('hex');
      
      await query('response_cache', 'upsert', {
        data: {
          question_hash: questionHash,
          question_text: question,
          answer_text: answer,
          law_references: sources,
          tokens_used: tokensUsed,
          quality_score: qualityScore,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        },
        onConflict: 'question_hash'
      });

      logger.info('Response cached', { 
        questionHash: questionHash.substring(0, 8),
        qualityScore 
      });

    } catch (error) {
      logger.error('Error caching response', { error: error.message });
    }
  }

  // Fallback відповідь
  getFallbackResponse() {
    const fallbackResponses = [
      "Вибачте, наразі я не можу надати детальну відповідь на ваше питання. Рекомендую звернутися до кваліфікованого юриста або використати офіційні правові ресурси.",
      "Для отримання точної правової консультації з вашого питання, будь ласка, зверніться до професійного юриста або безоплатної правової допомоги: 0 800 213 103",
      "Ваше питання потребує детального аналізу. Рекомендую консультацію з юристом, який спеціалізується на відповідній галузі права."
    ];
    
    return fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
  }

  // Хешування session ID для логування
  hashSessionId(sessionId) {
    return crypto.createHash('sha256').update(sessionId).digest('hex').substring(0, 8);
  }

  // Отримання статистики
  async getStats() {
    try {
      const result = await query('legal_laws', 'select', {
        select: 'count(*) as total_laws',
        limit: 1
      });

      return {
        total_laws: result.rows[0]?.total_laws || 0,
        total_articles: 0,
        total_precedents: 0,
        total_consultations: 0,
        total_templates: 0,
        cache_hit_rate: 0
      };
    } catch (error) {
      logger.error('Error getting stats', { error: error.message });
      return null;
    }
  }

  // Очищення застарілого кешу
  async cleanupCache() {
    try {
      const result = await query('response_cache', 'delete', {
        eq: { column: 'expires_at', value: new Date().toISOString() }
      });
      
      logger.info('Cache cleaned up', { deletedCount: result.rowCount });
      return result.rowCount;
    } catch (error) {
      logger.error('Error cleaning up cache', { error: error.message });
      return 0;
    }
  }
}

module.exports = new SupabaseLegalAgent();
