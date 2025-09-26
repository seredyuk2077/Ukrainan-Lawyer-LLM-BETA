const Session = require('../models/Session');
const Message = require('../models/Message');
const openaiService = require('../config/openai');
const { cache } = require('../config/database');
const logger = require('../utils/logger');

class ChatController {
  // Send message to chat
  async sendMessage(req, res) {
    try {
      const { message, sessionId } = req.body;

      // Get or create session
      let session = await Session.findById(sessionId);
      if (!session) {
        return res.status(404).json({ 
          error: 'Сесію не знайдено',
          code: 'SESSION_NOT_FOUND'
        });
      }

      // Create user message
      const userMessage = await Message.create(sessionId, 'user', message);

      // Get recent messages for context
      const recentMessages = await Message.getRecentForContext(sessionId, 10);
      const openaiMessages = recentMessages.map(msg => msg.toOpenAIFormat());

      let aiResponse, tokensUsed = 0;

      try {
        // Generate AI response
        const response = await openaiService.generateResponse(openaiMessages, sessionId);
        aiResponse = response.content;
        tokensUsed = response.tokensUsed;

      } catch (openaiError) {
        logger.error('OpenAI service error:', openaiError);
        
        // Use fallback response
        aiResponse = openaiService.getFallbackResponse();
        tokensUsed = 0;
      }

      // Create assistant message
      const assistantMessage = await Message.create(
        sessionId, 
        'assistant', 
        aiResponse, 
        tokensUsed
      );

      // Update session title if it's the first user message
      if (recentMessages.filter(m => m.role === 'user').length === 1) {
        const title = message.length > 50 ? message.substring(0, 47) + '...' : message;
        await session.update({ title });
      }

      // Log interaction
      logger.logChatInteraction(
        sessionId,
        message.length,
        aiResponse.length,
        tokensUsed,
        session.userId
      );

      // Cache recent conversation for faster access
      const cacheKey = `conversation:${sessionId}`;
      const conversationData = {
        sessionId,
        title: session.title,
        messages: [...openaiMessages, { role: 'assistant', content: aiResponse }]
      };
      await cache.set(cacheKey, conversationData, 3600); // 1 hour

      res.json({
        success: true,
        data: {
          message: assistantMessage.toJSON(),
          session: {
            id: session.id,
            title: session.title,
            updatedAt: session.updatedAt
          },
          tokensUsed
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

  // Get chat history
  async getHistory(req, res) {
    try {
      const { sessionId } = req.params;
      const { limit = 50, offset = 0 } = req.query;

      // Check cache first
      const cacheKey = `history:${sessionId}:${limit}:${offset}`;
      const cachedHistory = await cache.get(cacheKey);
      
      if (cachedHistory) {
        return res.json({
          success: true,
          data: cachedHistory,
          cached: true
        });
      }

      // Get session with messages
      const session = await Session.findById(sessionId);
      if (!session) {
        return res.status(404).json({ 
          error: 'Сесію не знайдено',
          code: 'SESSION_NOT_FOUND'
        });
      }

      const messages = await Message.findBySessionId(sessionId, limit, offset);

      const historyData = {
        session: session.toJSON(),
        messages: messages.map(msg => msg.toJSON()),
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: messages.length
        }
      };

      // Cache for 5 minutes
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

  // Create new session
  async createSession(req, res) {
    try {
      const { userId, title } = req.body;

      const session = await Session.create(userId, title);

      // Clear cache for user sessions
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

  // Delete session
  async deleteSession(req, res) {
    try {
      const { sessionId } = req.params;

      const session = await Session.findById(sessionId);
      if (!session) {
        return res.status(404).json({ 
          error: 'Сесію не знайдено',
          code: 'SESSION_NOT_FOUND'
        });
      }

      await session.delete();

      // Clear related caches
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

  // Get user sessions
  async getUserSessions(req, res) {
    try {
      const { userId } = req.params;
      const { limit = 20, offset = 0 } = req.query;

      // Check cache first
      const cacheKey = `user_sessions:${userId}:${limit}:${offset}`;
      const cachedSessions = await cache.get(cacheKey);
      
      if (cachedSessions) {
        return res.json({
          success: true,
          data: cachedSessions,
          cached: true
        });
      }

      const sessions = await Session.findByUserId(userId, limit, offset);

      const sessionsData = {
        sessions: sessions.map(session => session.toJSON()),
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: sessions.length
        }
      };

      // Cache for 10 minutes
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

  // Update session
  async updateSession(req, res) {
    try {
      const { sessionId } = req.params;
      const updates = req.body;

      const session = await Session.findById(sessionId);
      if (!session) {
        return res.status(404).json({ 
          error: 'Сесію не знайдено',
          code: 'SESSION_NOT_FOUND'
        });
      }

      await session.update(updates);

      // Clear related caches
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

  // Get chat statistics (admin endpoint)
  async getStats(req, res) {
    try {
      const sessionStats = await Session.getStats();
      const messageStats = await Message.getStats();

      const stats = {
        sessions: sessionStats,
        messages: messageStats,
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
}

module.exports = new ChatController();