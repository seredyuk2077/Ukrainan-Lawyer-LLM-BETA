import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { chatSessionService, chatMessageService, type ChatSession, type ChatMessage } from '@/lib/supabase';

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
  clearError: () => void;
}

const convertSupabaseMessage = (msg: ChatMessage): ChatMessage => ({
  id: msg.id,
  type: msg.role === 'assistant' ? 'agent' : msg.role as 'user' | 'system',
  content: msg.content,
  timestamp: new Date(msg.created_at),
  tokensUsed: msg.tokens_used
});

const convertSupabaseSession = (session: ChatSession, messages: ChatMessage[] = []): Chat => ({
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
          set({ isLoading: true, error: null });
          
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

          set(state => ({
            currentMessages: [...state.currentMessages, userMessage]
          }));

          // Prepare messages for API
          const messages = [...currentMessages, userMessage].map(msg => ({
            role: msg.type === 'agent' ? 'assistant' : msg.type,
            content: msg.content
          }));

          // Call Supabase Edge Function with correct URL
          const supabaseUrl = 'https://lhltmmzwvikdgxxakbcl.supabase.co';
          const response = await fetch(`${supabaseUrl}/functions/v1/app_78e3d871a2_chat`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxobHRtbXp3dmlrZGd4eGFrYmNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg5MDI1ODksImV4cCI6MjA3NDQ3ODU4OX0.e7KwgbRDSxzugIuNoM-aFnMYXrgDSRrOOd6LKRsbvMQ`
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
            let errorData;
            try {
              errorData = JSON.parse(errorText);
            } catch {
              errorData = { error: `HTTP ${response.status}: ${errorText}` };
            }
            
            throw new Error(errorData.error || 'Помилка відправки повідомлення');
          }

          const data = await response.json();
          
          // Add AI response
          const aiMessage: ChatMessage = {
            id: crypto.randomUUID(),
            type: 'agent',
            content: data.response,
            timestamp: new Date(),
            tokensUsed: data.tokensUsed
          };

          set(state => ({
            currentMessages: [...state.currentMessages, aiMessage],
            isLoading: false
          }));

          // Update chat title if it's the first message
          if (currentMessages.filter(m => m.type === 'user').length === 0) {
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