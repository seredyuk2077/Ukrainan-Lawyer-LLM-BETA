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
    <Card className="h-full flex flex-col bg-gradient-to-br from-white/95 to-slate-50/95 border border-white/20 shadow-2xl backdrop-blur-xl overflow-hidden" style={{ height: '100%', maxHeight: 'calc(100vh - 100px)' }}>
      {/* Header */}
      <motion.div 
        className="p-5 border-b border-white/20 bg-gradient-to-r from-slate-900/95 via-slate-800/95 to-slate-900/95"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <div className="flex items-center justify-between mb-4">
          <motion.h2 
            className="text-lg font-bold text-white flex items-center"
            whileHover={{ scale: 1.02 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
          >
            <motion.div
              animate={{ rotate: [0, 10, -10, 0] }}
              transition={{ duration: 4, repeat: Infinity }}
            >
              <MessageSquare className="h-5 w-5 mr-2 text-amber-400" />
            </motion.div>
            Історія чатів
          </motion.h2>
          <motion.div
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
          >
            <Button
              onClick={onNewChat}
              size="sm"
              className="bg-gradient-to-r from-amber-500 via-amber-600 to-orange-600 hover:from-amber-600 hover:via-amber-700 hover:to-orange-700 text-white shadow-xl border border-amber-400/50"
            >
              <Plus className="h-4 w-4 mr-1" />
              Новий
            </Button>
          </motion.div>
        </div>

        {/* Search */}
        <motion.div 
          className="relative"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2, duration: 0.5 }}
        >
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            placeholder="Пошук чатів..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 h-10 bg-white/90 border-slate-300/50 focus:border-amber-400 focus:ring-amber-400/20 backdrop-blur-sm"
          />
        </motion.div>
      </motion.div>

      {/* Chat List */}
      <div className="flex-1 bg-gradient-to-b from-white/50 to-slate-50/30 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent hover:scrollbar-thumb-slate-400" style={{ scrollBehavior: 'smooth', height: '100%', maxHeight: 'calc(100vh - 200px)' }}>
        <div className="p-3 space-y-2 pb-4">
          <AnimatePresence>
            {filteredChats.length === 0 ? (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.4 }}
                className="text-center py-12 px-4"
              >
                <motion.div
                  animate={{ 
                    rotate: [0, 10, -10, 0],
                    scale: [1, 1.1, 1]
                  }}
                  transition={{ duration: 3, repeat: Infinity }}
                >
                  <MessageSquare className="h-16 w-16 mx-auto mb-4 text-slate-300" />
                </motion.div>
                <p className="text-sm text-slate-500 font-medium">
                  {searchTerm ? 'Чатів не знайдено' : 'Немає збережених чатів'}
                </p>
                <p className="text-xs text-slate-400 mt-2">
                  Створіть новий чат для початку роботи
                </p>
                {/* Test content for scrolling */}
                <div className="mt-8 space-y-4 text-left">
                  <div className="bg-slate-100 rounded-lg p-3">
                    <p className="text-xs text-slate-500 font-medium mb-1">Приклад чату 1</p>
                    <p className="text-xs text-slate-400">Питання про трудове право</p>
                  </div>
                  <div className="bg-slate-100 rounded-lg p-3">
                    <p className="text-xs text-slate-500 font-medium mb-1">Приклад чату 2</p>
                    <p className="text-xs text-slate-400">Консультація з сімейного права</p>
                  </div>
                  <div className="bg-slate-100 rounded-lg p-3">
                    <p className="text-xs text-slate-500 font-medium mb-1">Приклад чату 3</p>
                    <p className="text-xs text-slate-400">Питання про цивільне право</p>
                  </div>
                  <div className="bg-slate-100 rounded-lg p-3">
                    <p className="text-xs text-slate-500 font-medium mb-1">Приклад чату 4</p>
                    <p className="text-xs text-slate-400">Консультація з кримінального права</p>
                  </div>
                  <div className="bg-slate-100 rounded-lg p-3">
                    <p className="text-xs text-slate-500 font-medium mb-1">Приклад чату 5</p>
                    <p className="text-xs text-slate-400">Питання про адміністративне право</p>
                  </div>
                </div>
              </motion.div>
            ) : (
              filteredChats.map((chat, index) => (
                <motion.div
                  key={chat.id}
                  initial={{ opacity: 0, y: 20, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, x: -100, scale: 0.9 }}
                  transition={{ 
                    delay: index * 0.05,
                    duration: 0.4,
                    type: "spring",
                    stiffness: 300,
                    damping: 25
                  }}
                  whileHover={{ 
                    scale: 1.02,
                    y: -2,
                    transition: { duration: 0.2 }
                  }}
                  whileTap={{ scale: 0.98 }}
                  className={`group relative p-4 rounded-xl cursor-pointer transition-all duration-300 ${
                    currentChatId === chat.id
                      ? 'bg-gradient-to-r from-amber-50 via-orange-50 to-amber-50 border-2 border-amber-300 shadow-lg'
                      : 'bg-white/80 border border-slate-200/50 hover:border-amber-300/50 hover:shadow-md backdrop-blur-sm'
                  }`}
                  onClick={() => onSelectChat(chat.id)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0 pr-3">
                      <motion.h3 
                        className={`text-sm font-semibold truncate ${
                          currentChatId === chat.id ? 'text-amber-800' : 'text-slate-800'
                        }`}
                        layoutId={`title-${chat.id}`}
                      >
                        {chat.title}
                      </motion.h3>
                      
                      <div className="flex items-center mt-2 text-xs text-slate-500 space-x-3">
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

                    <motion.div
                      initial={{ opacity: 0, scale: 0 }}
                      animate={{ 
                        opacity: currentChatId === chat.id ? 1 : 0,
                        scale: currentChatId === chat.id ? 1 : 0
                      }}
                      className="flex items-center space-x-2"
                    >
                      {currentChatId === chat.id && (
                        <motion.div
                          animate={{ 
                            rotate: [0, 360],
                            scale: [1, 1.2, 1]
                          }}
                          transition={{ duration: 2, repeat: Infinity }}
                        >
                          <Sparkles className="h-4 w-4 text-amber-500" />
                        </motion.div>
                      )}
                      <motion.div
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.9 }}
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteChat(chat.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 transition-all duration-200 h-7 w-7 p-0 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </motion.div>
                    </motion.div>
                  </div>

                  {/* Preview of last message */}
                  {chat.messages.length > 1 && (
                    <motion.p 
                      className="text-xs text-slate-400 mt-3 truncate leading-relaxed"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.1 }}
                    >
                      {chat.messages[chat.messages.length - 1].content.slice(0, 80)}...
                    </motion.p>
                  )}

                  {/* Active chat indicator */}
                  {currentChatId === chat.id && (
                    <motion.div
                      className="absolute left-0 top-1/2 transform -translate-y-1/2 w-1 h-8 bg-gradient-to-b from-amber-400 to-orange-500 rounded-r-full"
                      layoutId="activeIndicator"
                      transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    />
                  )}
                </motion.div>
              ))
            )}
          </AnimatePresence>
        </div>
      </div>
    </Card>
  );
}