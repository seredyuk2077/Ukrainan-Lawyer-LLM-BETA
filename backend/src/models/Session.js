const { query, transaction } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

class Session {
  constructor(data) {
    this.id = data.id;
    this.userId = data.user_id;
    this.title = data.title;
    this.createdAt = data.created_at;
    this.updatedAt = data.updated_at;
    this.metadata = data.metadata || {};
    this.isActive = data.is_active;
  }

  // Create new session
  static async create(userId = null, title = 'Нова консультація') {
    try {
      const sessionId = uuidv4();
      
      const result = await query(
        `INSERT INTO chat_sessions (id, user_id, title, metadata) 
         VALUES ($1, $2, $3, $4) 
         RETURNING *`,
        [sessionId, userId, title, {}]
      );

      logger.info('Session created', { 
        sessionId: sessionId.substring(0, 8),
        userId: userId ? userId.substring(0, 8) : null 
      });

      return new Session(result.rows[0]);
    } catch (error) {
      logger.error('Error creating session:', error);
      throw new Error('Помилка створення сесії');
    }
  }

  // Get session by ID
  static async findById(sessionId) {
    try {
      const result = await query(
        'SELECT * FROM chat_sessions WHERE id = $1 AND is_active = true',
        [sessionId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return new Session(result.rows[0]);
    } catch (error) {
      logger.error('Error finding session:', error);
      throw new Error('Помилка отримання сесії');
    }
  }

  // Get sessions by user ID
  static async findByUserId(userId, limit = 50, offset = 0) {
    try {
      const result = await query(
        `SELECT * FROM chat_sessions 
         WHERE user_id = $1 AND is_active = true 
         ORDER BY updated_at DESC 
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      return result.rows.map(row => new Session(row));
    } catch (error) {
      logger.error('Error finding sessions by user:', error);
      throw new Error('Помилка отримання сесій користувача');
    }
  }

  // Update session
  async update(updates) {
    try {
      const setClause = [];
      const values = [];
      let paramIndex = 1;

      Object.keys(updates).forEach(key => {
        if (key === 'title' || key === 'metadata' || key === 'isActive') {
          const dbKey = key === 'isActive' ? 'is_active' : key;
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
        `UPDATE chat_sessions 
         SET ${setClause.join(', ')} 
         WHERE id = $${paramIndex} 
         RETURNING *`,
        values
      );

      if (result.rows.length === 0) {
        throw new Error('Сесію не знайдено');
      }

      // Update current instance
      Object.assign(this, new Session(result.rows[0]));
      
      logger.info('Session updated', { 
        sessionId: this.id.substring(0, 8),
        updates: Object.keys(updates)
      });

      return this;
    } catch (error) {
      logger.error('Error updating session:', error);
      throw new Error('Помилка оновлення сесії');
    }
  }

  // Delete session (soft delete)
  async delete() {
    try {
      await query(
        'UPDATE chat_sessions SET is_active = false WHERE id = $1',
        [this.id]
      );

      this.isActive = false;
      
      logger.info('Session deleted', { 
        sessionId: this.id.substring(0, 8)
      });

      return true;
    } catch (error) {
      logger.error('Error deleting session:', error);
      throw new Error('Помилка видалення сесії');
    }
  }

  // Get session with messages
  async getWithMessages(limit = 50, offset = 0) {
    try {
      const result = await query(
        `SELECT 
           s.*,
           json_agg(
             json_build_object(
               'id', m.id,
               'role', m.role,
               'content', m.content,
               'created_at', m.created_at,
               'tokens_used', m.tokens_used,
               'metadata', m.metadata
             ) ORDER BY m.created_at ASC
           ) FILTER (WHERE m.id IS NOT NULL) as messages
         FROM chat_sessions s
         LEFT JOIN chat_messages m ON s.id = m.session_id
         WHERE s.id = $1 AND s.is_active = true
         GROUP BY s.id
         LIMIT $2 OFFSET $3`,
        [this.id, limit, offset]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const sessionData = result.rows[0];
      const session = new Session(sessionData);
      session.messages = sessionData.messages || [];

      return session;
    } catch (error) {
      logger.error('Error getting session with messages:', error);
      throw new Error('Помилка отримання сесії з повідомленнями');
    }
  }

  // Clean up old sessions
  static async cleanup(daysOld = 30) {
    try {
      const result = await query(
        `UPDATE chat_sessions 
         SET is_active = false 
         WHERE updated_at < NOW() - INTERVAL '${daysOld} days' 
         AND is_active = true
         RETURNING id`,
      );

      logger.info('Sessions cleaned up', { 
        count: result.rowCount,
        daysOld 
      });

      return result.rowCount;
    } catch (error) {
      logger.error('Error cleaning up sessions:', error);
      throw new Error('Помилка очищення старих сесій');
    }
  }

  // Get session statistics
  static async getStats() {
    try {
      const result = await query(`
        SELECT 
          COUNT(*) as total_sessions,
          COUNT(*) FILTER (WHERE is_active = true) as active_sessions,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as sessions_today,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as sessions_week
        FROM chat_sessions
      `);

      return result.rows[0];
    } catch (error) {
      logger.error('Error getting session stats:', error);
      throw new Error('Помилка отримання статистики сесій');
    }
  }

  // Convert to JSON
  toJSON() {
    return {
      id: this.id,
      userId: this.userId,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      metadata: this.metadata,
      isActive: this.isActive,
      messages: this.messages || undefined
    };
  }
}

module.exports = Session;