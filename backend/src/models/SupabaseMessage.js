const { supabase, query } = require('../config/supabase');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

class SupabaseMessage {
  constructor(data) {
    this.id = data.id;
    this.sessionId = data.session_id;
    this.role = data.role;
    this.content = data.content;
    this.createdAt = data.created_at;
    this.tokensUsed = data.tokens_used || 0;
    this.metadata = data.metadata || {};
  }

  // Create new message
  static async create(sessionId, role, content, tokensUsed = 0, metadata = {}) {
    try {
      const messageId = uuidv4();
      
      const result = await query('chat_messages', 'insert', {
        data: {
          id: messageId,
          session_id: sessionId,
          role,
          content,
          tokens_used: tokensUsed,
          metadata
        }
      });

      logger.info('Message created', { 
        messageId: messageId.substring(0, 8),
        sessionId: sessionId.substring(0, 8),
        role,
        contentLength: content.length,
        tokensUsed
      });

      return new SupabaseMessage(result.rows[0]);
    } catch (error) {
      logger.error('Error creating message:', error);
      throw new Error('Помилка створення повідомлення');
    }
  }

  // Get messages by session ID
  static async findBySessionId(sessionId, limit = 50, offset = 0) {
    try {
      const result = await query('chat_messages', 'select', {
        eq: { column: 'session_id', value: sessionId },
        order: { column: 'created_at', ascending: true },
        range: { from: offset, to: offset + limit - 1 }
      });

      return result.rows.map(row => new SupabaseMessage(row));
    } catch (error) {
      logger.error('Error finding messages by session:', error);
      throw new Error('Помилка отримання повідомлень');
    }
  }

  // Get recent messages for context (excluding system messages)
  static async getRecentForContext(sessionId, limit = 10) {
    try {
      const result = await supabase
        .from('chat_messages')
        .select('*')
        .eq('session_id', sessionId)
        .neq('role', 'system')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (result.error) {
        throw new Error(result.error.message);
      }

      // Return in chronological order for OpenAI API
      return result.data.reverse().map(row => new SupabaseMessage(row));
    } catch (error) {
      logger.error('Error getting recent messages:', error);
      throw new Error('Помилка отримання контексту повідомлень');
    }
  }

  // Update message
  async update(updates) {
    try {
      const updateData = {};
      
      if (updates.content !== undefined) updateData.content = updates.content;
      if (updates.tokensUsed !== undefined) updateData.tokens_used = updates.tokensUsed;
      if (updates.metadata !== undefined) updateData.metadata = updates.metadata;

      const result = await query('chat_messages', 'update', {
        data: updateData,
        eq: { column: 'id', value: this.id }
      });

      if (result.rows.length === 0) {
        throw new Error('Повідомлення не знайдено');
      }

      // Update current instance
      Object.assign(this, new SupabaseMessage(result.rows[0]));
      
      logger.info('Message updated', { 
        messageId: this.id.substring(0, 8),
        updates: Object.keys(updates)
      });

      return this;
    } catch (error) {
      logger.error('Error updating message:', error);
      throw new Error('Помилка оновлення повідомлення');
    }
  }

  // Delete message
  async delete() {
    try {
      await query('chat_messages', 'delete', {
        eq: { column: 'id', value: this.id }
      });
      
      logger.info('Message deleted', { 
        messageId: this.id.substring(0, 8)
      });

      return true;
    } catch (error) {
      logger.error('Error deleting message:', error);
      throw new Error('Помилка видалення повідомлення');
    }
  }

  // Get message statistics
  static async getStats() {
    try {
      const { data, error } = await supabase.rpc('get_message_stats');
      
      if (error) {
        throw new Error(error.message);
      }

      return data || {
        total_messages: 0,
        user_messages: 0,
        assistant_messages: 0,
        messages_today: 0,
        messages_week: 0,
        avg_tokens: 0,
        total_tokens: 0
      };
    } catch (error) {
      logger.error('Error getting message stats:', error);
      throw new Error('Помилка отримання статистики повідомлень');
    }
  }

  // Clean up old messages
  static async cleanup(daysOld = 90) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);
      
      const result = await query('chat_messages', 'delete', {
        eq: { column: 'created_at', value: cutoffDate.toISOString() }
      });

      logger.info('Messages cleaned up', { 
        count: result.rowCount,
        daysOld 
      });

      return result.rowCount;
    } catch (error) {
      logger.error('Error cleaning up messages:', error);
      throw new Error('Помилка очищення старих повідомлень');
    }
  }

  // Convert to OpenAI format
  toOpenAIFormat() {
    return {
      role: this.role,
      content: this.content
    };
  }

  // Convert to JSON
  toJSON() {
    return {
      id: this.id,
      sessionId: this.sessionId,
      role: this.role,
      content: this.content,
      createdAt: this.createdAt,
      tokensUsed: this.tokensUsed,
      metadata: this.metadata
    };
  }
}

module.exports = SupabaseMessage;
