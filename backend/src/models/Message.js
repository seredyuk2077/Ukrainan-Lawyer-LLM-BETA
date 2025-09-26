const { query } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

class Message {
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
      
      const result = await query(
        `INSERT INTO chat_messages (id, session_id, role, content, tokens_used, metadata) 
         VALUES ($1, $2, $3, $4, $5, $6) 
         RETURNING *`,
        [messageId, sessionId, role, content, tokensUsed, metadata]
      );

      logger.info('Message created', { 
        messageId: messageId.substring(0, 8),
        sessionId: sessionId.substring(0, 8),
        role,
        contentLength: content.length,
        tokensUsed
      });

      return new Message(result.rows[0]);
    } catch (error) {
      logger.error('Error creating message:', error);
      throw new Error('Помилка створення повідомлення');
    }
  }

  // Get messages by session ID
  static async findBySessionId(sessionId, limit = 50, offset = 0) {
    try {
      const result = await query(
        `SELECT * FROM chat_messages 
         WHERE session_id = $1 
         ORDER BY created_at ASC 
         LIMIT $2 OFFSET $3`,
        [sessionId, limit, offset]
      );

      return result.rows.map(row => new Message(row));
    } catch (error) {
      logger.error('Error finding messages by session:', error);
      throw new Error('Помилка отримання повідомлень');
    }
  }

  // Get recent messages for context (excluding system messages)
  static async getRecentForContext(sessionId, limit = 10) {
    try {
      const result = await query(
        `SELECT * FROM chat_messages 
         WHERE session_id = $1 AND role != 'system'
         ORDER BY created_at DESC 
         LIMIT $1`,
        [sessionId, limit]
      );

      // Return in chronological order for OpenAI API
      return result.rows.reverse().map(row => new Message(row));
    } catch (error) {
      logger.error('Error getting recent messages:', error);
      throw new Error('Помилка отримання контексту повідомлень');
    }
  }

  // Update message
  async update(updates) {
    try {
      const setClause = [];
      const values = [];
      let paramIndex = 1;

      Object.keys(updates).forEach(key => {
        if (key === 'content' || key === 'tokensUsed' || key === 'metadata') {
          const dbKey = key === 'tokensUsed' ? 'tokens_used' : key;
          setClause.push(`${dbKey} = $${paramIndex}`);
          values.push(updates[key]);
          paramIndex++;
        }
      });

      if (setClause.length === 0) {
        return this;
      }

      values.push(this.id);
      
      const result = await query(
        `UPDATE chat_messages 
         SET ${setClause.join(', ')} 
         WHERE id = $${paramIndex} 
         RETURNING *`,
        values
      );

      if (result.rows.length === 0) {
        throw new Error('Повідомлення не знайдено');
      }

      // Update current instance
      Object.assign(this, new Message(result.rows[0]));
      
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
      await query('DELETE FROM chat_messages WHERE id = $1', [this.id]);
      
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
      const result = await query(`
        SELECT 
          COUNT(*) as total_messages,
          COUNT(*) FILTER (WHERE role = 'user') as user_messages,
          COUNT(*) FILTER (WHERE role = 'assistant') as assistant_messages,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as messages_today,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as messages_week,
          AVG(tokens_used) FILTER (WHERE tokens_used > 0) as avg_tokens,
          SUM(tokens_used) as total_tokens
        FROM chat_messages
      `);

      return result.rows[0];
    } catch (error) {
      logger.error('Error getting message stats:', error);
      throw new Error('Помилка отримання статистики повідомлень');
    }
  }

  // Clean up old messages
  static async cleanup(daysOld = 90) {
    try {
      const result = await query(
        `DELETE FROM chat_messages 
         WHERE created_at < NOW() - INTERVAL '${daysOld} days'
         RETURNING id`,
      );

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

module.exports = Message;