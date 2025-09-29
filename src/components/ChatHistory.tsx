import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { 
  MessageSquare, 
  Plus, 
  Search, 
  Trash2, 
  Calendar,
  Clock,
  Sparkles
} from 'lucide-react';
import { useChatStore } from '@/store/chatStore';
import { motion, AnimatePresence } from 'framer-motion';

interface ChatHistoryProps {
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
}

export default function ChatHistory({ onSelectChat, onNewChat }: ChatHistoryProps) {
  const { chats, currentChatId, deleteChat } = useChatStore();
  const [searchTerm, setSearchTerm] = useState('');

  const filteredChats = chats.filter(chat =>
    chat.title.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const formatDate = (date: Date | string) => {
    const dateObj = date instanceof Date ? date : new Date(date);
    
    if (isNaN(dateObj.getTime())) {
      return 'Невідома дата';
    }

    const now = new Date();
    const diffTime = Math.abs(now.getTime() - dateObj.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 1) return 'Сьогодні';
    if (diffDays === 2) return 'Вчора';
    if (diffDays <= 7) return `${diffDays} днів тому`;
    
    return dateObj.toLocaleDateString('uk-UA', {
      day: 'numeric',
      month: 'short'
    });
  };

  return (
    <div className="h-full flex flex-col bg-white overflow-hidden border-r border-slate-200/50 shadow-sm">
      {/* Header */}
      <div className="p-3 border-b border-slate-200/50 bg-white">
        <div className="flex items-center justify-between min-w-0">
          <div className="flex items-center space-x-2 min-w-0 flex-1">
            <div className="w-7 h-7 bg-gradient-to-br from-blue-500 via-blue-600 to-blue-700 rounded-md flex items-center justify-center shadow-sm flex-shrink-0">
              <MessageSquare className="h-3.5 w-3.5 text-white" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-slate-800 whitespace-nowrap">
                Історія чатів
              </h2>
            </div>
          </div>
          <div className="flex items-center space-x-1.5 flex-shrink-0">
            <Button
              onClick={onNewChat}
              size="sm"
              className="bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 text-xs rounded-md shadow-sm hover:shadow-md transition-all duration-200 whitespace-nowrap"
            >
              <Plus className="h-3 w-3 mr-1" />
              Новий чат
            </Button>
            {chats.length > 0 && (
              <Button
                onClick={() => {
                  if (confirm('Ви впевнені, що хочете видалити всі чати?')) {
                    chats.forEach(chat => deleteChat(chat.id));
                  }
                }}
                size="sm"
                variant="ghost"
                className="text-slate-400 hover:text-red-500 hover:bg-red-50 p-1 rounded-md flex-shrink-0"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>

        {/* Search */}
        <div className="relative mt-3">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            placeholder="Пошук чатів..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9 h-9 bg-slate-50 border-slate-200 text-slate-800 placeholder:text-slate-400 focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20 rounded-lg text-sm"
          />
        </div>
      </div>

      {/* Chat List */}
      <div className="flex-1 bg-white overflow-y-auto scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent hover:scrollbar-thumb-slate-400" style={{ scrollBehavior: 'smooth' }}>
        <div className="p-3 space-y-2 pb-4">
          <AnimatePresence>
            {filteredChats.length === 0 ? (
              <div className="text-center py-12 px-4">
                <div className="w-16 h-16 bg-gradient-to-br from-slate-100 to-slate-200 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <MessageSquare className="h-8 w-8 text-slate-400" />
                </div>
                <p className="text-sm text-slate-600 font-medium mb-2">
                  {searchTerm ? 'Чатів не знайдено' : 'Немає збережених чатів'}
                </p>
                <p className="text-xs text-slate-500">
                  Створіть новий чат для початку роботи
                </p>
              </div>
            ) : (
              filteredChats.map((chat, index) => (
                <motion.div
                  key={chat.id}
                  initial={{ opacity: 0, y: 8, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, x: -50, scale: 0.96 }}
                  transition={{ 
                    delay: index * 0.01,
                    duration: 0.4,
                    ease: [0.4, 0, 0.2, 1]
                  }}
                  whileHover={{ 
                    scale: 1.01,
                    y: -1,
                    transition: { duration: 0.2, ease: [0.4, 0, 0.2, 1] }
                  }}
                  className={`group relative p-3 rounded-xl cursor-pointer transition-all duration-300 border ${
        currentChatId === chat.id
          ? 'bg-blue-50 border-blue-200 shadow-sm'
          : 'bg-white border-slate-200 hover:bg-slate-50 hover:border-blue-300 hover:shadow-sm'
      }`}
                  onClick={() => onSelectChat(chat.id)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0 pr-3">
                      <h3 
                        className={`text-sm font-semibold truncate mb-2 ${
                          currentChatId === chat.id ? 'text-blue-800' : 'text-slate-800'
                        }`}
                      >
                        {chat.title}
                      </h3>
                      
                      <div className="flex items-center text-xs text-slate-500 space-x-3">
                        <div className="flex items-center">
                          <Calendar className="h-3 w-3 mr-1" />
                          {formatDate(chat.updatedAt)}
                        </div>
                        <div className="flex items-center">
                          <Clock className="h-3 w-3 mr-1" />
                          {chat.messages.length} повідомлень
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center space-x-1">
                      {currentChatId === chat.id && (
                        <div className="w-2 h-2 bg-blue-500 rounded-full shadow-sm" />
                      )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteChat(chat.id);
                          }}
                        className="h-6 w-6 p-0 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all duration-200 opacity-0 group-hover:opacity-100"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                    </div>
                  </div>

                  {/* Preview of last message */}
                  {chat.messages.length > 1 && (
                    <p className="text-xs text-slate-500 mt-2 truncate leading-relaxed bg-slate-50 p-2 rounded-lg">
                      {chat.messages[chat.messages.length - 1].content.slice(0, 80)}...
                    </p>
                  )}

                </motion.div>
              ))
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}