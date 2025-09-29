import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { chatSessionService, chatMessageService, type ChatSession, type ChatMessage as SupabaseChatMessage } from '@/lib/supabase';

export interface ChatMessage {
  id: string;
  type: 'user' | 'agent' | 'system';
  content: string;
  timestamp: Date;
  tokensUsed?: number;
}

export interface Chat {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
}

interface ChatStore {
  chats: Chat[];
  currentChatId: string | null;
  currentMessages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
  
  // Actions
  createNewChat: () => Promise<void>;
  selectChat: (chatId: string) => Promise<void>;
  addMessage: (message: Omit<ChatMessage, 'id'>) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  loadChats: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  cancelMessage: () => void;
  clearError: () => void;
  
  // Utility functions
  getCurrentChat: () => Chat | null;
  clearAllData: () => void;
}

// API Response types
interface ChatAPIResponse {
  response: string;
  tokensUsed?: number;
  sessionId: string;
}

interface ChatAPIError {
  error: string;
  requestId?: string;
}

const convertSupabaseMessage = (msg: SupabaseChatMessage): ChatMessage => ({
  id: msg.id,
  type: msg.role === 'assistant' ? 'agent' : msg.role as 'user' | 'system',
  content: msg.content,
  timestamp: new Date(msg.created_at),
  tokensUsed: msg.tokens_used
});

const convertSupabaseSession = (session: ChatSession, messages: SupabaseChatMessage[] = []): Chat => ({
  id: session.id,
  title: session.title,
  messages: messages.map(convertSupabaseMessage),
  createdAt: new Date(session.created_at),
  updatedAt: new Date(session.updated_at)
});

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
      chats: [],
      currentChatId: null,
      currentMessages: [],
      isLoading: false,
      error: null,

      clearError: () => set({ error: null }),

      createNewChat: async () => {
        try {
          set({ isLoading: true, error: null });
          
          const session = await chatSessionService.create();
          const newChat = convertSupabaseSession(session);
          
          set(state => ({
            chats: [newChat, ...state.chats],
            currentChatId: session.id,
            currentMessages: [],
            isLoading: false
          }));
        } catch (error) {
          console.error('Error creating new chat:', error);
          set({ 
            error: error instanceof Error ? error.message : 'Помилка створення чату',
            isLoading: false 
          });
        }
      },

      selectChat: async (chatId: string) => {
        try {
          // Don't show loading state for chat switching to avoid visual artifacts
          set({ error: null });
          
          const messages = await chatMessageService.getBySessionId(chatId);
          const convertedMessages = messages.map(convertSupabaseMessage);
          
          set({
            currentChatId: chatId,
            currentMessages: convertedMessages,
            isLoading: false
          });
        } catch (error) {
          console.error('Error selecting chat:', error);
          set({ 
            error: error instanceof Error ? error.message : 'Помилка завантаження чату',
            isLoading: false 
          });
        }
      },

      addMessage: async (message: Omit<ChatMessage, 'id'>) => {
        const { currentChatId } = get();
        if (!currentChatId) return;

        try {
          const role = message.type === 'agent' ? 'assistant' : message.type;
          const savedMessage = await chatMessageService.create(
            currentChatId,
            role as 'user' | 'assistant' | 'system',
            message.content,
            message.tokensUsed || 0
          );

          const convertedMessage = convertSupabaseMessage(savedMessage);
          
          set(state => ({
            currentMessages: [...state.currentMessages, convertedMessage]
          }));

          // Update chat in the list
          set(state => ({
            chats: state.chats.map(chat => 
              chat.id === currentChatId 
                ? { ...chat, messages: [...chat.messages, convertedMessage], updatedAt: new Date() }
                : chat
            )
          }));
        } catch (error) {
          console.error('Error adding message:', error);
          set({ error: error instanceof Error ? error.message : 'Помилка додавання повідомлення' });
        }
      },

      sendMessage: async (content: string) => {
        const { currentChatId, currentMessages } = get();
        if (!currentChatId) return;

        try {
          set({ isLoading: true, error: null });

          // Add user message locally first
          const userMessage: ChatMessage = {
            id: crypto.randomUUID(),
            type: 'user',
            content,
            timestamp: new Date()
          };

          // Update state with user message
          set(state => ({
            currentMessages: [...state.currentMessages, userMessage]
          }));

          // Prepare messages for API (including the new user message)
          const allMessages = [...currentMessages, userMessage];
          const messages = allMessages.map(msg => ({
            role: msg.type === 'agent' ? 'assistant' : msg.type,
            content: msg.content
          }));

          // Get Supabase configuration
          const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
          const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
          
          if (!supabaseUrl || !supabaseAnonKey) {
            throw new Error('Відсутні Supabase змінні середовища. Перевірте .env файл.');
          }
          
          const response = await fetch(`${supabaseUrl}/functions/v1/app_78e3d871a2_chat`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseAnonKey}`
            },
            body: JSON.stringify({
              messages,
              sessionId: currentChatId,
              userMessage: content
            })
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error('API Error Response:', errorText);
            
            // Try to parse as JSON, fallback to text
            let errorData: ChatAPIError;
            try {
              errorData = JSON.parse(errorText);
            } catch {
              errorData = { error: `HTTP ${response.status}: ${errorText}` };
            }
            
            // Handle specific error cases
            if (response.status === 401) {
              throw new Error('Помилка автентифікації. Перевірте налаштування Supabase та API ключі.');
            } else if (response.status === 404) {
              throw new Error('Функція чату не знайдена. Перевірте налаштування Edge Function.');
            } else if (response.status === 429) {
              throw new Error('Занадто багато запитів. Спробуйте пізніше.');
            } else if (response.status >= 500) {
              throw new Error('Помилка сервера. Спробуйте пізніше.');
            }
            
            throw new Error(errorData.error || 'Помилка відправки повідомлення');
          }

          const data: ChatAPIResponse = await response.json();
          
          // Add AI response
          const aiMessage: ChatMessage = {
            id: crypto.randomUUID(),
            type: 'agent',
            content: data.response || 'Порожня відповідь від AI',
            timestamp: new Date(),
            tokensUsed: data.tokensUsed || 0
          };

          set(state => ({
            currentMessages: [...state.currentMessages, aiMessage],
            isLoading: false
          }));

          // Update chat in the list with AI message
          set(state => ({
            chats: state.chats.map(chat => 
              chat.id === currentChatId 
                ? { ...chat, messages: [...chat.messages, aiMessage], updatedAt: new Date() }
                : chat
            )
          }));

          // Update chat title if it's the first user message
          const userMessages = currentMessages.filter(m => m.type === 'user');
          if (userMessages.length === 0) {
            const title = content.length > 50 ? content.substring(0, 47) + '...' : content;
            set(state => ({
              chats: state.chats.map(chat => 
                chat.id === currentChatId ? { ...chat, title } : chat
              )
            }));
          }

        } catch (error) {
          console.error('Error sending message:', error);
          set({ 
            error: error instanceof Error ? error.message : 'Помилка відправки повідомлення',
            isLoading: false 
          });
          
          // Remove the user message if there was an error
          set(state => ({
            currentMessages: state.currentMessages.slice(0, -1)
          }));
        }
      },

      cancelMessage: () => {
        const { currentMessages } = get();
        
        // Remove the last user message if it exists and we're loading
        if (currentMessages.length > 0) {
          const lastMessage = currentMessages[currentMessages.length - 1];
          if (lastMessage.type === 'user') {
            set(state => ({
              currentMessages: state.currentMessages.slice(0, -1),
              isLoading: false
            }));
          }
        }
        
        set({ isLoading: false });
      },

      deleteChat: async (chatId: string) => {
        try {
          await chatSessionService.delete(chatId);
          
          set(state => ({
            chats: state.chats.filter(chat => chat.id !== chatId),
            currentChatId: state.currentChatId === chatId ? null : state.currentChatId,
            currentMessages: state.currentChatId === chatId ? [] : state.currentMessages
          }));
        } catch (error) {
          console.error('Error deleting chat:', error);
          set({ error: error instanceof Error ? error.message : 'Помилка видалення чату' });
        }
      },

      loadChats: async () => {
        try {
          set({ isLoading: true, error: null });
          
          const sessions = await chatSessionService.getAllSessions();
          const chats = sessions.map(session => convertSupabaseSession(session));
          
          set({ 
            chats,
            isLoading: false 
          });
        } catch (error) {
          console.error('Error loading chats:', error);
          set({ 
            error: error instanceof Error ? error.message : 'Помилка завантаження чатів',
            isLoading: false 
          });
        }
      },

      // Utility function to get current chat
      getCurrentChat: () => {
        const { chats, currentChatId } = get();
        return chats.find(chat => chat.id === currentChatId) || null;
      },

      // Utility function to clear all data
      clearAllData: () => {
        set({
          chats: [],
          currentChatId: null,
          currentMessages: [],
          isLoading: false,
          error: null
        });
      }
    }),
    {
      name: 'ukrainian-lawyer-chat-store',
      partialize: (state) => ({
        chats: state.chats.map(chat => ({
          ...chat,
          createdAt: chat.createdAt.toISOString(),
          updatedAt: chat.updatedAt.toISOString(),
          messages: chat.messages.map(msg => ({
            ...msg,
            timestamp: msg.timestamp.toISOString()
          }))
        }))
      }),
      onRehydrateStorage: () => (state) => {
        if (state?.chats) {
          state.chats = state.chats.map((chat: any) => ({
            ...chat,
            createdAt: new Date(chat.createdAt),
            updatedAt: new Date(chat.updatedAt),
            messages: chat.messages.map((msg: any) => ({
              ...msg,
              timestamp: new Date(msg.timestamp)
            }))
          }));
        }
      }
    }
  )
);