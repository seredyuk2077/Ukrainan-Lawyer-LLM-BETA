import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://lhltmmzwvikdgxxakbcl.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxobHRtbXp3dmlrZGd4eGFrYmNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg5MDI1ODksImV4cCI6MjA3NDQ3ODU4OX0.e7KwgbRDSxzugIuNoM-aFnMYXrgDSRrOOd6LKRsbvMQ';

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Відсутні Supabase змінні середовища. Перевірте .env файл.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Database types
export interface ChatSession {
  id: string;
  user_id?: string;
  title: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, any>;
  is_active: boolean;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
  tokens_used: number;
  metadata: Record<string, any>;
}

// Chat session operations
export const chatSessionService = {
  async create(title: string = 'Новий чат', userId?: string): Promise<ChatSession> {
    const { data, error } = await supabase
      .from('chat_sessions')
      .insert({
        title,
        user_id: userId,
        metadata: {},
        is_active: true
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating chat session:', error);
      throw new Error('Помилка створення сесії чату');
    }

    return data;
  },

  async getById(sessionId: string): Promise<ChatSession | null> {
    const { data, error } = await supabase
      .from('chat_sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('is_active', true)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      console.error('Error fetching chat session:', error);
      throw new Error('Помилка отримання сесії чату');
    }

    return data;
  },

  async getByUserId(userId: string, limit: number = 50): Promise<ChatSession[]> {
    const { data, error } = await supabase
      .from('chat_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching user sessions:', error);
      throw new Error('Помилка отримання сесій користувача');
    }

    return data || [];
  },

  async getAllSessions(limit: number = 50): Promise<ChatSession[]> {
    const { data, error } = await supabase
      .from('chat_sessions')
      .select('*')
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching all sessions:', error);
      throw new Error('Помилка отримання всіх сесій');
    }

    return data || [];
  },

  async update(sessionId: string, updates: Partial<ChatSession>): Promise<ChatSession> {
    const { data, error } = await supabase
      .from('chat_sessions')
      .update(updates)
      .eq('id', sessionId)
      .select()
      .single();

    if (error) {
      console.error('Error updating chat session:', error);
      throw new Error('Помилка оновлення сесії чату');
    }

    return data;
  },

  async updateTitle(sessionId: string, title: string): Promise<ChatSession> {
    const { data, error } = await supabase
      .from('chat_sessions')
      .update({ 
        title: title.trim(),
        updated_at: new Date().toISOString()
      })
      .eq('id', sessionId)
      .select()
      .single();

    if (error) {
      console.error('Error updating chat title:', error);
      throw new Error('Помилка оновлення назви чату');
    }

    return data;
  },

  async delete(sessionId: string): Promise<void> {
    // First delete all messages for this session
    const { error: messagesError } = await supabase
      .from('chat_messages')
      .delete()
      .eq('session_id', sessionId);

    if (messagesError) {
      console.error('Error deleting messages:', messagesError);
      throw new Error('Помилка видалення повідомлень');
    }

    // Then delete the session
    const { error } = await supabase
      .from('chat_sessions')
      .delete()
      .eq('id', sessionId);

    if (error) {
      console.error('Error deleting chat session:', error);
      throw new Error('Помилка видалення сесії чату');
    }
  },

  async deleteAll(): Promise<void> {
    // First, get all active sessions
    const { data: sessions, error: fetchError } = await supabase
      .from('chat_sessions')
      .select('id')
      .eq('is_active', true);

    if (fetchError) {
      console.error('Error fetching sessions for deletion:', fetchError);
      throw new Error('Помилка отримання сесій для видалення');
    }

    if (!sessions || sessions.length === 0) {
      return; // No sessions to delete
    }

    const sessionIds = sessions.map(session => session.id);

    // Delete all messages for these sessions first
    const { error: messagesError } = await supabase
      .from('chat_messages')
      .delete()
      .in('session_id', sessionIds);

    if (messagesError) {
      console.error('Error deleting messages:', messagesError);
      throw new Error('Помилка видалення повідомлень');
    }

    // Then delete all sessions
    const { error: sessionsError } = await supabase
      .from('chat_sessions')
      .delete()
      .in('id', sessionIds);

    if (sessionsError) {
      console.error('Error deleting sessions:', sessionsError);
      throw new Error('Помилка видалення сесій');
    }
  }
};

// Chat message operations
export const chatMessageService = {
  async create(
    sessionId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    tokensUsed: number = 0
  ): Promise<ChatMessage> {
    const { data, error } = await supabase
      .from('chat_messages')
      .insert({
        session_id: sessionId,
        role,
        content,
        tokens_used: tokensUsed,
        metadata: {}
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating chat message:', error);
      throw new Error('Помилка створення повідомлення');
    }

    return data;
  },

  async getBySessionId(sessionId: string, limit: number = 100): Promise<ChatMessage[]> {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) {
      console.error('Error fetching messages:', error);
      throw new Error('Помилка отримання повідомлень');
    }

    return data || [];
  },

  async getRecentMessages(sessionId: string, limit: number = 10): Promise<ChatMessage[]> {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .neq('role', 'system')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching recent messages:', error);
      throw new Error('Помилка отримання останніх повідомлень');
    }

    return (data || []).reverse(); // Return in chronological order
  }
};

// Note: OpenAI integration is now handled by Supabase Edge Functions
// This service is no longer needed as we use direct API calls to Edge Functions