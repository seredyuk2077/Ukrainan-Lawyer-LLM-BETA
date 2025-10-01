const { supabase, query } = require('../config/supabase');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

class SupabaseSession {
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
      
      const result = await query('chat_sessions', 'insert', {
        data: {
          id: sessionId,
          user_id: userId,
          title,
          metadata: {},
          is_active: true
        }
      });

      logger.info('Session created', { 
        sessionId: sessionId.substring(0, 8),
        userId: userId ? userId.substring(0, 8) : null 
      });

      return new SupabaseSession(result.rows[0]);
    } catch (error) {
      logger.error('Error creating session:', error);
      throw new Error('Помилка створення сесії');
    }
  }

  // Get session by ID
  static async findById(sessionId) {
    try {
      const result = await query('chat_sessions', 'select', {
        eq: { column: 'id', value: sessionId },
        limit: 1
      });

      if (result.rows.length === 0) {
        return null;
      }

      const session = new SupabaseSession(result.rows[0]);
      return session.isActive ? session : null;
    } catch (error) {
      logger.error('Error finding session:', error);
      throw new Error('Помилка отримання сесії');
    }
  }

  // Get sessions by user ID
  static async findByUserId(userId, limit = 50, offset = 0) {
    try {
      const result = await query('chat_sessions', 'select', {
        eq: { column: 'user_id', value: userId },
        order: { column: 'updated_at', ascending: false },
        range: { from: offset, to: offset + limit - 1 }
      });

      return result.rows
        .filter(row => row.is_active)
        .map(row => new SupabaseSession(row));
    } catch (error) {
      logger.error('Error finding sessions by user:', error);
      throw new Error('Помилка отримання сесій користувача');
    }
  }

  // Update session
  async update(updates) {
    try {
      const updateData = {};
      
      if (updates.title !== undefined) updateData.title = updates.title;
      if (updates.metadata !== undefined) updateData.metadata = updates.metadata;
      if (updates.isActive !== undefined) updateData.is_active = updates.isActive;
      
      updateData.updated_at = new Date().toISOString();

      const result = await query('chat_sessions', 'update', {
        data: updateData,
        eq: { column: 'id', value: this.id }
      });

      if (result.rows.length === 0) {
        throw new Error('Сесію не знайдено');
      }

      // Update current instance
      Object.assign(this, new SupabaseSession(result.rows[0]));
      
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
      await query('chat_sessions', 'update', {
        data: { is_active: false },
        eq: { column: 'id', value: this.id }
      });

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
      const { data, error } = await supabase
        .from('chat_sessions')
        .select(`
          *,
          chat_messages (
            id,
            role,
            content,
            created_at,
            tokens_used,
            metadata
          )
        `)
        .eq('id', this.id)
        .eq('is_active', true)
        .order('created_at', { ascending: true }, { foreignTable: 'chat_messages' })
        .limit(limit, { foreignTable: 'chat_messages' })
        .range(offset, offset + limit - 1, { foreignTable: 'chat_messages' });

      if (error) {
        throw new Error(error.message);
      }

      if (data.length === 0) {
        return null;
      }

      const sessionData = data[0];
      const session = new SupabaseSession(sessionData);
      session.messages = sessionData.chat_messages || [];

      return session;
    } catch (error) {
      logger.error('Error getting session with messages:', error);
      throw new Error('Помилка отримання сесії з повідомленнями');
    }
  }

  // Clean up old sessions
  static async cleanup(daysOld = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);
      
      const result = await query('chat_sessions', 'update', {
        data: { is_active: false },
        eq: { column: 'updated_at', value: cutoffDate.toISOString() }
      });

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
      const { data, error } = await supabase.rpc('get_session_stats');
      
      if (error) {
        throw new Error(error.message);
      }

      return data || {
        total_sessions: 0,
        active_sessions: 0,
        sessions_today: 0,
        sessions_week: 0
      };
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

module.exports = SupabaseSession;
