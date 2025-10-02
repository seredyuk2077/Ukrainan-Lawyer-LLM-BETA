const SupabaseSession = require('../models/SupabaseSession');
const SupabaseMessage = require('../models/SupabaseMessage');
const openaiService = require('../config/openai');
const enhancedLegalAgent = require('../services/supabaseLegalAgent');
const responseValidator = require('../services/supabaseResponseValidator');
const radaOfficialApiParser = require('../services/radaOfficialApiParser');
const { cache } = require('../config/supabase');
const logger = require('../utils/logger');

class SupabaseChatController {
  // Відправка повідомлення з покращеною логікою
  async sendMessage(req, res) {
    try {
      const { message, sessionId } = req.body;

      // Валідація вхідних даних
      if (!message || message.trim().length === 0) {
        return res.status(400).json({
          error: 'Повідомлення не може бути порожнім',
          code: 'EMPTY_MESSAGE'
        });
      }

      if (message.length > 2000) {
        return res.status(400).json({
          error: 'Повідомлення занадто довге (максимум 2000 символів)',
          code: 'MESSAGE_TOO_LONG'
        });
      }

      // Отримання або створення сесії
      let session = await SupabaseSession.findById(sessionId);
      if (!session) {
        return res.status(404).json({
          error: 'Сесію не знайдено',
          code: 'SESSION_NOT_FOUND'
        });
      }

      // Створення повідомлення користувача
      const userMessage = await SupabaseMessage.create(sessionId, 'user', message);

      // Отримання контексту розмови
      const recentMessages = await SupabaseMessage.getRecentForContext(sessionId, 5);
      const conversationHistory = recentMessages.map(msg => msg.toOpenAIFormat());

      let aiResponse, tokensUsed = 0, validation = null, sources = [], legalContext = null;

      try {
        // Використання покращеного Legal Agent
        legalContext = await enhancedLegalAgent.generateResponse(
          message, 
          sessionId, 
          conversationHistory
        );

        // Якщо є кешована відповідь
        if (legalContext.fromCache) {
          aiResponse = legalContext.content;
          tokensUsed = legalContext.tokensUsed;
          sources = legalContext.sources;
        } else {
          // Генерація відповіді через OpenAI з покращеним контекстом
          const openaiMessages = [
            { role: 'system', content: legalContext.content },
            ...conversationHistory
          ];

          const response = await openaiService.generateResponse(openaiMessages, sessionId);
          aiResponse = response.content;
          tokensUsed = response.tokensUsed + legalContext.tokensUsed;
          sources = legalContext.sources;

          // Валідація відповіді
          validation = await responseValidator.validateResponse(
            message, 
            aiResponse, 
            sources
          );

          // Якщо відповідь не пройшла валідацію, генеруємо fallback
          if (!validation.isValid) {
            logger.warn('Response failed validation, using fallback', {
              sessionId: sessionId.substring(0, 8),
              score: validation.score,
              issues: validation.issues
            });

            aiResponse = enhancedLegalAgent.getFallbackResponse();
            tokensUsed = 0;
            validation.score = 50; // Базовий бал для fallback
          }

          // Кешування відповіді (якщо валідна)
          if (validation.isValid && validation.score >= 70) {
            await enhancedLegalAgent.cacheResponse(
              message,
              aiResponse,
              sources,
              tokensUsed,
              validation.score
            );
          }
        }

      } catch (openaiError) {
        logger.error('OpenAI service error:', openaiError);
        
        // Використання fallback відповіді
        aiResponse = enhancedLegalAgent.getFallbackResponse();
        tokensUsed = 0;
        validation = {
          isValid: false,
          score: 30,
          issues: ['Помилка генерації відповіді'],
          warnings: [],
          suggestions: ['Спробуйте переформулювати питання']
        };
      }

      // Створення повідомлення асистента
      const assistantMessage = await SupabaseMessage.create(
        sessionId,
        'assistant',
        aiResponse,
        tokensUsed,
        {
          validation: validation,
          sources: sources,
          fromCache: legalContext && legalContext.fromCache ? true : false
        }
      );

      // Оновлення заголовка сесії (якщо це перше повідомлення)
      if (recentMessages.filter(m => m.role === 'user').length === 1) {
        const title = message.length > 50 ? message.substring(0, 47) + '...' : message;
        await session.update({ title });
      }

      // Логування взаємодії
      logger.logChatInteraction(
        sessionId,
        message.length,
        aiResponse.length,
        tokensUsed,
        session.userId,
        {
          validationScore: validation?.score,
          sourcesCount: sources.length,
          fromCache: legalContext && legalContext.fromCache ? true : false
        }
      );

      // Кешування розмови
      const cacheKey = `conversation:${sessionId}`;
      const conversationData = {
        sessionId,
        title: session.title,
        messages: [...conversationHistory, { role: 'assistant', content: aiResponse }],
        lastUpdated: new Date()
      };
      await cache.set(cacheKey, conversationData, 3600);

      // Відповідь клієнту
      res.json({
        success: true,
        data: {
          message: assistantMessage.toJSON(),
          session: {
            id: session.id,
            title: session.title,
            updatedAt: session.updatedAt
          },
          tokensUsed,
          validation: validation ? {
            isValid: validation.isValid,
            score: validation.score,
            issues: validation.issues,
            warnings: validation.warnings,
            suggestions: validation.suggestions
          } : null,
          sources: sources,
          fromCache: legalContext && legalContext.fromCache ? true : false
        }
      });

    } catch (error) {
      logger.logError(error, {
        endpoint: 'sendMessage',
        sessionId: req.body.sessionId,
        ip: req.ip
      });

      res.status(500).json({
        error: 'Внутрішня помилка сервера',
        code: 'INTERNAL_ERROR',
        message: 'Спробуйте пізніше або зверніться до підтримки'
      });
    }
  }

  // Отримання історії чату з покращеною інформацією
  async getHistory(req, res) {
    try {
      const { sessionId } = req.params;
      const { limit = 50, offset = 0 } = req.query;

      // Перевірка кешу
      const cacheKey = `history:${sessionId}:${limit}:${offset}`;
      const cachedHistory = await cache.get(cacheKey);
      
      if (cachedHistory) {
        return res.json({
          success: true,
          data: cachedHistory,
          cached: true
        });
      }

      // Отримання сесії з повідомленнями
      const session = await SupabaseSession.findById(sessionId);
      if (!session) {
        return res.status(404).json({
          error: 'Сесію не знайдено',
          code: 'SESSION_NOT_FOUND'
        });
      }

      const messages = await SupabaseMessage.findBySessionId(sessionId, limit, offset);

      // Обробка повідомлень для відображення
      const processedMessages = messages.map(msg => {
        const messageData = msg.toJSON();
        
        // Додавання інформації про валідацію та джерела
        if (msg.metadata) {
          messageData.validation = msg.metadata.validation;
          messageData.sources = msg.metadata.sources;
          messageData.fromCache = msg.metadata.fromCache;
        }

        return messageData;
      });

      const historyData = {
        session: session.toJSON(),
        messages: processedMessages,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: messages.length
        }
      };

      // Кешування на 5 хвилин
      await cache.set(cacheKey, historyData, 300);

      res.json({
        success: true,
        data: historyData
      });

    } catch (error) {
      logger.logError(error, {
        endpoint: 'getHistory',
        sessionId: req.params.sessionId,
        ip: req.ip
      });

      res.status(500).json({
        error: 'Помилка отримання історії',
        code: 'HISTORY_ERROR'
      });
    }
  }

  // Створення нової сесії
  async createSession(req, res) {
    try {
      const { userId, title = 'Нова юридична консультація' } = req.body;

      const session = await SupabaseSession.create(userId, title);

      // Очищення кешу сесій користувача
      if (userId) {
        await cache.del(`user_sessions:${userId}`);
      }

      res.status(201).json({
        success: true,
        data: {
          session: session.toJSON()
        }
      });

    } catch (error) {
      logger.logError(error, {
        endpoint: 'createSession',
        userId: req.body.userId,
        ip: req.ip
      });

      res.status(500).json({
        error: 'Помилка створення сесії',
        code: 'SESSION_CREATE_ERROR'
      });
    }
  }

  // Видалення сесії
  async deleteSession(req, res) {
    try {
      const { sessionId } = req.params;

      const session = await SupabaseSession.findById(sessionId);
      if (!session) {
        return res.status(404).json({
          error: 'Сесію не знайдено',
          code: 'SESSION_NOT_FOUND'
        });
      }

      await session.delete();

      // Очищення пов'язаних кешів
      await cache.del(`conversation:${sessionId}`);
      await cache.del(`history:${sessionId}:*`);
      if (session.userId) {
        await cache.del(`user_sessions:${session.userId}`);
      }

      res.json({
        success: true,
        message: 'Сесію видалено'
      });

    } catch (error) {
      logger.logError(error, {
        endpoint: 'deleteSession',
        sessionId: req.params.sessionId,
        ip: req.ip
      });

      res.status(500).json({
        error: 'Помилка видалення сесії',
        code: 'SESSION_DELETE_ERROR'
      });
    }
  }

  // Отримання сесій користувача
  async getUserSessions(req, res) {
    try {
      const { userId } = req.params;
      const { limit = 20, offset = 0 } = req.query;

      // Перевірка кешу
      const cacheKey = `user_sessions:${userId}:${limit}:${offset}`;
      const cachedSessions = await cache.get(cacheKey);
      
      if (cachedSessions) {
        return res.json({
          success: true,
          data: cachedSessions,
          cached: true
        });
      }

      const sessions = await SupabaseSession.findByUserId(userId, limit, offset);

      const sessionsData = {
        sessions: sessions.map(session => session.toJSON()),
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: sessions.length
        }
      };

      // Кешування на 10 хвилин
      await cache.set(cacheKey, sessionsData, 600);

      res.json({
        success: true,
        data: sessionsData
      });

    } catch (error) {
      logger.logError(error, {
        endpoint: 'getUserSessions',
        userId: req.params.userId,
        ip: req.ip
      });

      res.status(500).json({
        error: 'Помилка отримання сесій користувача',
        code: 'USER_SESSIONS_ERROR'
      });
    }
  }

  // Оновлення сесії
  async updateSession(req, res) {
    try {
      const { sessionId } = req.params;
      const updates = req.body;

      const session = await SupabaseSession.findById(sessionId);
      if (!session) {
        return res.status(404).json({
          error: 'Сесію не знайдено',
          code: 'SESSION_NOT_FOUND'
        });
      }

      await session.update(updates);

      // Очищення пов'язаних кешів
      await cache.del(`conversation:${sessionId}`);
      if (session.userId) {
        await cache.del(`user_sessions:${session.userId}`);
      }

      res.json({
        success: true,
        data: {
          session: session.toJSON()
        }
      });

    } catch (error) {
      logger.logError(error, {
        endpoint: 'updateSession',
        sessionId: req.params.sessionId,
        ip: req.ip
      });

      res.status(500).json({
        error: 'Помилка оновлення сесії',
        code: 'SESSION_UPDATE_ERROR'
      });
    }
  }

  // Отримання статистики (розширена)
  async getStats(req, res) {
    try {
      const sessionStats = await SupabaseSession.getStats();
      const messageStats = await SupabaseMessage.getStats();
      const legalStats = await enhancedLegalAgent.getStats();
      const validationStats = await responseValidator.getValidationStats();

      const stats = {
        sessions: sessionStats,
        messages: messageStats,
        legal: legalStats,
        validation: validationStats,
        timestamp: new Date().toISOString()
      };

      res.json({
        success: true,
        data: stats
      });

    } catch (error) {
      logger.logError(error, {
        endpoint: 'getStats',
        ip: req.ip
      });

      res.status(500).json({
        error: 'Помилка отримання статистики',
        code: 'STATS_ERROR'
      });
    }
  }

  // Пошук законів (новий endpoint)
  async searchLaws(req, res) {
    try {
      const { query: searchQuery, limit = 10 } = req.query;

      if (!searchQuery || searchQuery.trim().length === 0) {
        return res.status(400).json({
          error: 'Пошуковий запит не може бути порожнім',
          code: 'EMPTY_QUERY'
        });
      }

      const keywords = searchQuery.trim().split(/\s+/);
      const results = await radaParser.hybridSearch(keywords, parseInt(limit));

      res.json({
        success: true,
        data: {
          query: searchQuery,
          results: results,
          total: results.length
        }
      });

    } catch (error) {
      logger.logError(error, {
        endpoint: 'searchLaws',
        query: req.query.query,
        ip: req.ip
      });

      res.status(500).json({
        error: 'Помилка пошуку законів',
        code: 'SEARCH_ERROR'
      });
    }
  }

  // Оновлення бази знань (admin endpoint)
  async updateKnowledgeBase(req, res) {
    try {
      const { force = false } = req.body;

      // Перевірка прав доступу (тут можна додати перевірку ролі адміністратора)
      
      const updatedCount = await radaParser.updateDatabase();
      
      res.json({
        success: true,
        data: {
          updatedLaws: updatedCount,
          message: 'База знань оновлена успішно'
        }
      });

    } catch (error) {
      logger.logError(error, {
        endpoint: 'updateKnowledgeBase',
        ip: req.ip
      });

      res.status(500).json({
        error: 'Помилка оновлення бази знань',
        code: 'UPDATE_ERROR'
      });
    }
  }

  // Очищення кешу (admin endpoint)
  async clearCache(req, res) {
    try {
      const { type = 'all' } = req.body;

      let clearedCount = 0;

      if (type === 'all' || type === 'conversations') {
        // Очищення кешу розмов
        const conversationKeys = await cache.keys('conversation:*');
        clearedCount += conversationKeys.length;
        await Promise.all(conversationKeys.map(key => cache.del(key)));
      }

      if (type === 'all' || type === 'responses') {
        // Очищення кешу відповідей
        const responseKeys = await cache.keys('response:*');
        clearedCount += responseKeys.length;
        await Promise.all(responseKeys.map(key => cache.del(key)));
      }

      if (type === 'all' || type === 'expired') {
        // Очищення застарілого кешу
        clearedCount += await enhancedLegalAgent.cleanupCache();
      }

      res.json({
        success: true,
        data: {
          clearedItems: clearedCount,
          message: 'Кеш очищено успішно'
        }
      });

    } catch (error) {
      logger.logError(error, {
        endpoint: 'clearCache',
        type: req.body.type,
        ip: req.ip
      });

      res.status(500).json({
        error: 'Помилка очищення кешу',
        code: 'CACHE_CLEAR_ERROR'
      });
    }
  }
}

module.exports = new SupabaseChatController();
