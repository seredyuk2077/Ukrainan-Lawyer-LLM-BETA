import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Send, User, Sparkles, Scale, FileText, Zap, Crown, Copy, ThumbsUp, ThumbsDown, AlertCircle, ChevronDown, X, Square, MessageCircle, BookOpen } from 'lucide-react';
import { useChatStore } from '@/store/chatStore';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

interface ChatInterfaceProps {
  onOpenContractGenerator: () => void;
}

const formatMessage = (content: string, isUserMessage: boolean = false) => {
  let formatted = content;
  
  // Bold text (**text** or __text__)
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, `<strong class="${isUserMessage ? 'text-white' : 'text-slate-900'} font-bold ${isUserMessage ? 'bg-white/20' : 'bg-gradient-to-r from-amber-100 to-orange-100'} px-1 rounded">$1</strong>`);
  formatted = formatted.replace(/__(.*?)__/g, `<strong class="${isUserMessage ? 'text-white' : 'text-slate-900'} font-bold">$1</strong>`);
  
  // Italic text (*text* or _text_)
  formatted = formatted.replace(/\*(.*?)\*/g, `<em class="${isUserMessage ? 'text-white' : 'text-slate-800'} italic font-medium">$1</em>`);
  formatted = formatted.replace(/_(.*?)_/g, `<em class="${isUserMessage ? 'text-white' : 'text-slate-800'} italic">$1</em>`);
  
  // Code blocks (```code```)
  if (isUserMessage) {
    formatted = formatted.replace(/```(.*?)```/gs, '<div class="bg-white/20 border-l-4 border-blue-300 rounded-r-xl p-4 my-4 font-mono text-sm overflow-x-auto shadow-lg break-words" style="word-break: break-word; overflow-wrap: break-word;"><code class="text-white break-words">$1</code></div>');
  } else {
  formatted = formatted.replace(/```(.*?)```/gs, '<div class="bg-gradient-to-r from-slate-800 to-slate-900 border-l-4 border-amber-400 rounded-r-xl p-4 my-4 font-mono text-sm overflow-x-auto shadow-lg break-words" style="word-break: break-word; overflow-wrap: break-word;"><code class="text-green-300 break-words">$1</code></div>');
  }
  
  // Inline code (`code`)
  if (isUserMessage) {
    formatted = formatted.replace(/`(.*?)`/g, '<code class="bg-white/20 px-2 py-1 rounded-lg text-sm font-mono text-white border border-white/30 shadow-sm break-words" style="word-break: break-word; overflow-wrap: break-word;">$1</code>');
  } else {
  formatted = formatted.replace(/`(.*?)`/g, '<code class="bg-gradient-to-r from-amber-50 to-orange-50 px-2 py-1 rounded-lg text-sm font-mono text-slate-900 border border-amber-200 shadow-sm break-words" style="word-break: break-word; overflow-wrap: break-word;">$1</code>');
  }
  
  // Lists with enhanced styling
  const listColor = isUserMessage ? 'text-white' : 'text-slate-800';
  const bulletColor = isUserMessage ? 'bg-blue-300' : 'bg-gradient-to-r from-amber-400 to-orange-500';
  const dashColor = isUserMessage ? 'bg-blue-300' : 'bg-gradient-to-b from-blue-400 to-blue-600';
  
  formatted = formatted.replace(/^• (.*$)/gm, `<li class="ml-8 mb-3 ${listColor} relative flex items-start"><span class="absolute -left-6 top-1 w-2 h-2 ${bulletColor} rounded-full shadow-sm"></span><span class="leading-relaxed">$1</span></li>`);
  formatted = formatted.replace(/^- (.*$)/gm, `<li class="ml-8 mb-3 ${listColor} relative flex items-start"><span class="absolute -left-6 top-2 w-1 h-4 ${dashColor} rounded-full"></span><span class="leading-relaxed">$1</span></li>`);
  formatted = formatted.replace(/^\d+\. (.*$)/gm, `<li class="ml-8 mb-3 ${listColor} list-decimal font-medium leading-relaxed">$1</li>`);
  
  // Wrap consecutive list items with enhanced container
  const listBg = isUserMessage ? 'bg-white/10' : 'bg-gradient-to-r from-slate-50/80 via-white to-slate-50/80';
  const listBorder = isUserMessage ? 'border-blue-300' : 'border-amber-300';
  formatted = formatted.replace(/(<li.*?<\/li>\s*)+/g, `<ul class="space-y-2 my-6 ${listBg} p-5 rounded-xl border-l-4 ${listBorder} shadow-sm backdrop-blur-sm">$&</ul>`);
  
  // Enhanced section headers
  const headerColor = isUserMessage ? 'text-white' : 'text-slate-900';
  const headerGradient = isUserMessage ? 'bg-gradient-to-r from-blue-300 to-blue-500' : 'bg-gradient-to-r from-amber-500 to-orange-600';
  const headerBorder = isUserMessage ? 'border-blue-300' : 'border-amber-300';
  formatted = formatted.replace(/^(#{1,3})\s*(.*$)/gm, `<h3 class="text-lg font-bold ${headerColor} mt-6 mb-3 pb-2 border-b-2 ${headerBorder} ${headerGradient} bg-clip-text text-transparent">$2</h3>`);
  
  // Line breaks with better spacing
  formatted = formatted.replace(/\n\n/g, `</p><p class="mt-4 ${isUserMessage ? 'text-white' : 'text-slate-800'} leading-relaxed">`);
  formatted = formatted.replace(/\n/g, '<br>');
  
  return `<div class="prose prose-slate max-w-none break-words overflow-wrap-anywhere" style="word-break: break-word; overflow-wrap: break-word; hyphens: auto;"><p class="${isUserMessage ? 'text-white' : 'text-slate-800'} leading-relaxed break-words">${formatted}</p></div>`;
};

export default function ChatInterface({ onOpenContractGenerator }: ChatInterfaceProps) {
  const { 
    currentMessages, 
    currentChatId, 
    sendMessage, 
    cancelMessage,
    isLoading, 
    error, 
    clearError,
    clearLoadingState,
    getCurrentChat
  } = useChatStore();
  
  const [inputMessage, setInputMessage] = useState('');
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const currentChat = getCurrentChat();

  // Clear loading state when chat changes
  useEffect(() => {
    if (currentChatId) {
      // Clear loading state immediately when switching chats
      clearLoadingState();
    }
  }, [currentChatId, clearLoadingState]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    const scrollToBottom = () => {
      if (scrollAreaRef.current) {
        scrollAreaRef.current.scrollTo({
          top: scrollAreaRef.current.scrollHeight,
          behavior: 'smooth'
        });
      }
    };

    // Use setTimeout to ensure DOM is updated
    const timeoutId = setTimeout(scrollToBottom, 50);
    return () => clearTimeout(timeoutId);
  }, [currentMessages, isLoading]);

  // Auto-scroll when loading state changes
  useEffect(() => {
    if (isLoading) {
      const scrollToBottom = () => {
        if (scrollAreaRef.current) {
          scrollAreaRef.current.scrollTo({
            top: scrollAreaRef.current.scrollHeight,
            behavior: 'smooth'
          });
        }
      };
      setTimeout(scrollToBottom, 30);
    }
  }, [isLoading]);

  useEffect(() => {
    if (error) {
      toast.error(error);
      clearError();
    }
  }, [error, clearError]);

  const handleSendMessage = async () => {
    if (!inputMessage.trim() || isLoading || !currentChatId) return;

    const message = inputMessage.trim();
    setInputMessage('');
    
    try {
      await sendMessage(message);
    } catch (error) {
      console.error('Error sending message:', error);
      const errorMessage = error instanceof Error ? error.message : 'Помилка відправки повідомлення';
      toast.error(errorMessage);
    }
  };

  const handleCancelPrompt = () => {
    cancelMessage();
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleCopyMessage = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      toast.success('Повідомлення скопійовано!');
    } catch (error) {
      console.error('Error copying message:', error);
      toast.error('Помилка копіювання повідомлення');
    }
  };

  if (!currentChatId) {
    return (
      <div className="h-full flex items-center justify-center bg-gradient-to-br from-slate-900/10 via-slate-800/5 to-slate-900/10 backdrop-blur-sm rounded-2xl border border-white/10">
        <motion.div 
          className="text-center"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        >
          <motion.div
            animate={{ 
              rotate: 360,
              scale: [1, 1.1, 1]
            }}
            transition={{ 
              rotate: { duration: 20, repeat: Infinity, ease: "linear" },
              scale: { duration: 2, repeat: Infinity, ease: "easeInOut" }
            }}
            className="relative"
          >
            <div className="absolute inset-0 bg-gradient-to-r from-amber-400 to-orange-500 rounded-full blur-xl opacity-30"></div>
            <Scale className="h-20 w-20 mx-auto mb-6 text-amber-500 relative z-10" />
          </motion.div>
          <h3 className="text-2xl font-bold bg-gradient-to-r from-slate-700 to-slate-900 bg-clip-text text-transparent mb-3">
            Оберіть чат або створіть новий
          </h3>
          <p className="text-slate-600 text-lg">
            Розпочніть чат з Mike Ross
          </p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="p-2 border-b border-slate-200/40 bg-gradient-to-r from-slate-50 to-blue-50/30 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-6 h-6 bg-gradient-to-br from-blue-500 via-blue-600 to-blue-700 rounded-md flex items-center justify-center shadow-sm">
              <BookOpen className="h-3 w-3 text-white" />
            </div>
            <div>
              <motion.h3 
                key={currentChatId}
                initial={{ opacity: 0, y: -5 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                className="text-base font-bold text-slate-800"
              >
                {currentChat ? currentChat.title : 'Новий чат'}
              </motion.h3>
              <p className="text-xs text-slate-500">
                Швидкі відповіді на юридичні запитання
              </p>
            </div>
          </div>
          
          <Button
            onClick={onOpenContractGenerator}
            className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-md font-medium shadow-sm hover:shadow-md transition-all duration-200 text-xs"
          >
            <FileText className="h-3 w-3 mr-1" />
            Створити договір
          </Button>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 flex items-center space-x-2 text-red-700">
          <AlertCircle className="h-4 w-4" />
          <span className="text-sm font-medium">{error}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearError}
            className="ml-auto h-6 w-6 p-0 text-red-500 hover:text-red-700"
          >
            ×
          </Button>
        </div>
      )}

      {/* Enhanced Messages Area */}
      <div 
        className="flex-1 min-h-0 bg-gradient-to-b from-slate-50/40 via-white/95 to-slate-50/40 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent hover:scrollbar-thumb-slate-400 backdrop-blur-sm" 
        ref={scrollAreaRef}
        style={{ 
          scrollBehavior: 'smooth',
          height: '100%',
          maxHeight: 'calc(100vh - 240px)'
        }}
      >
        <motion.div
          key={currentChatId}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          className="p-4 md:p-6 space-y-3 md:space-y-4 pb-4"
          style={{ minHeight: '100%' }}
        >
          <AnimatePresence mode="wait">
            {/* Welcome Screen */}
            {currentMessages.length === 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
                className="flex flex-col items-center justify-center h-full px-4 py-8"
              >
                <motion.div
                  initial={{ scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ delay: 0.2, duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
                  className="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-blue-500 via-blue-600 to-blue-700 rounded-xl flex items-center justify-center shadow-lg"
                >
                  <BookOpen className="h-8 w-8 text-white" />
                </motion.div>
                
                <motion.div
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3, duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
                  className="text-center mb-6"
                >
                  <h2 className="text-2xl font-bold text-slate-800 mb-2">
                    Вітаємо! Це ваш юридичний помічник
                  </h2>
                  <p className="text-base text-slate-600 mb-4">
                    Почніть розмову, щоб отримати допомогу з українським законодавством
                  </p>
                </motion.div>

                {/* Feature Cards */}
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4, duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
                  className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full max-w-4xl mb-6"
                >
                  <div className="bg-gradient-to-br from-blue-50 to-blue-100 p-4 rounded-lg border border-blue-200 hover:shadow-md transition-all duration-300">
                    <div className="w-10 h-10 bg-blue-500 rounded-lg flex items-center justify-center mb-3 mx-auto">
                      <MessageCircle className="h-5 w-5 text-white" />
                    </div>
                    <h3 className="text-base font-semibold text-slate-800 mb-2 text-center">
                      Правові питання
                    </h3>
                    <p className="text-xs text-slate-600 text-center">
                      Задавайте питання про права та обов'язки згідно з українським правом
                    </p>
                  </div>

                  <div className="bg-gradient-to-br from-amber-50 to-amber-100 p-4 rounded-lg border border-amber-200 hover:shadow-md transition-all duration-300">
                    <div className="w-10 h-10 bg-amber-500 rounded-lg flex items-center justify-center mb-3 mx-auto">
                      <FileText className="h-5 w-5 text-white" />
                    </div>
                    <h3 className="text-base font-semibold text-slate-800 mb-2 text-center">
                      Документи
                    </h3>
                    <p className="text-xs text-slate-600 text-center">
                      Створюйте договори, заяви та інші правові документи
                    </p>
                  </div>

                  <div className="bg-gradient-to-br from-green-50 to-green-100 p-4 rounded-lg border border-green-200 hover:shadow-md transition-all duration-300">
                    <div className="w-10 h-10 bg-green-500 rounded-lg flex items-center justify-center mb-3 mx-auto">
                      <BookOpen className="h-5 w-5 text-white" />
                    </div>
                    <h3 className="text-base font-semibold text-slate-800 mb-2 text-center">
                      Аналіз НПА
                    </h3>
                    <p className="text-xs text-slate-600 text-center">
                      Розбирайте складні правові ситуації та нормативно-правові акти
                    </p>
                  </div>
                </motion.div>

                <motion.div
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.5, duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
                  className="mt-4 text-center"
                >
                  <p className="text-slate-500 text-xs">
                    Почніть розмову, щоб отримати допомогу з українським законодавством
                  </p>
                </motion.div>
              </motion.div>
            )}

            {/* Messages */}
            {currentMessages.map((message, index) => (
              <motion.div
                key={`${currentChatId}-${message.id}`}
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.95 }}
                transition={{ 
                  delay: Math.min(index * 0.01, 0.1), // Cap the delay to prevent long animations
                  duration: 0.2,
                  type: "spring",
                  stiffness: 400,
                  damping: 30
                }}
                className={`flex ${message.type === 'user' ? 'justify-end' : 'justify-start'} px-2 md:px-0`}
              >
                <motion.div
                  whileHover={{ 
                    scale: 1.005,
                    y: -1,
                    transition: { duration: 0.2, ease: [0.4, 0, 0.2, 1] }
                  }}
                  className={`max-w-[75%] sm:max-w-[70%] md:max-w-[65%] lg:max-w-[60%] xl:max-w-[55%] min-w-[200px] rounded-xl p-3 transition-all duration-300 group relative ${
                    message.type === 'user'
                      ? 'bg-gradient-to-br from-blue-500 via-blue-600 to-blue-700 text-white border border-blue-400/20 shadow-md shadow-blue-500/10 backdrop-blur-sm'
                      : 'bg-gradient-to-br from-slate-50/90 to-white/90 text-slate-800 border border-slate-200/50 shadow-lg shadow-slate-200/20 backdrop-blur-sm'
                  }`}
                >
                  <div className="flex items-start space-x-3">
                    {message.type === 'agent' && (
                      <motion.div 
                        className="flex-shrink-0 mt-1"
                        initial={{ rotate: -10, scale: 0.9, opacity: 0 }}
                        animate={{ rotate: 0, scale: 1, opacity: 1 }}
                        transition={{ type: "spring", stiffness: 400, damping: 25, delay: 0.1 }}
                      >
                        <div className="w-8 h-8 bg-gradient-to-br from-slate-100 to-slate-200 rounded-full flex items-center justify-center shadow-sm border border-slate-200">
                          <Scale className="h-4 w-4 text-slate-600" />
                        </div>
                      </motion.div>
                    )}
                    {message.type === 'user' && (
                      <motion.div 
                        className="flex-shrink-0 mt-1"
                        initial={{ rotate: 10, scale: 0.9, opacity: 0 }}
                        animate={{ rotate: 0, scale: 1, opacity: 1 }}
                        transition={{ type: "spring", stiffness: 400, damping: 25, delay: 0.1 }}
                      >
                        <div className="w-6 h-6 bg-white/20 rounded-full flex items-center justify-center backdrop-blur-sm border border-white/30 shadow-sm">
                          <User className="h-3 w-3 text-white" />
                        </div>
                      </motion.div>
                    )}
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-2">
                        <span className={`text-sm font-semibold ${
                          message.type === 'user' ? 'text-white' : 'text-slate-800'
                        }`}>
                          {message.type === 'user' ? 'Ви' : 'Mike Ross'}
                        </span>
                        <span className={`text-xs ${
                          message.type === 'user' ? 'text-white/70' : 'text-slate-500'
                        }`}>
                          {message.timestamp.toLocaleTimeString('uk-UA', { 
                            hour: '2-digit', 
                            minute: '2-digit' 
                          })}
                        </span>
                      </div>
                      
                      <div 
                        className={`prose prose-slate max-w-none ${
                          message.type === 'user' ? 'prose-invert' : ''
                        }`}
                        dangerouslySetInnerHTML={{ 
                          __html: formatMessage(message.content, message.type === 'user') 
                        }}
                      />
                      
                      {message.type === 'agent' && (
                        <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-200">
                          <div className="flex items-center space-x-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleCopyMessage(message.content)}
                              className="h-8 w-8 p-0 text-slate-500 hover:text-slate-700 hover:bg-slate-100"
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 text-slate-500 hover:text-green-600 hover:bg-green-50"
                            >
                              <ThumbsUp className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 text-slate-500 hover:text-red-600 hover:bg-red-50"
                            >
                              <ThumbsDown className="h-3 w-3" />
                            </Button>
                          </div>
                          
                          {message.tokensUsed && (
                            <div className="flex items-center space-x-1 text-xs text-slate-500">
                              <Zap className="h-3 w-3" />
                              <span>{message.tokensUsed} токенів</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            ))}

            {/* Loading Indicator - only show when actually sending a message */}
            {isLoading && currentMessages.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.95 }}
                transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                className="flex justify-start px-2 md:px-0"
              >
                <motion.div
                  whileHover={{ 
                    scale: 1.005,
                    y: -1,
                    transition: { duration: 0.2, ease: [0.4, 0, 0.2, 1] }
                  }}
                  className="max-w-[85%] md:max-w-[80%] rounded-2xl p-4 transition-all duration-300 group relative bg-gradient-to-br from-slate-50/90 to-white/90 text-slate-800 border border-slate-200/50 shadow-lg shadow-slate-200/20 backdrop-blur-sm"
                >
                  <div className="flex items-start space-x-4">
                    <motion.div 
                      className="flex-shrink-0 mt-1"
                      initial={{ rotate: -10, scale: 0.9, opacity: 0 }}
                      animate={{ rotate: 0, scale: 1, opacity: 1 }}
                      transition={{ type: "spring", stiffness: 400, damping: 25, delay: 0.1 }}
                    >
                      <div className="w-8 h-8 bg-gradient-to-br from-slate-100 to-slate-200 rounded-full flex items-center justify-center shadow-sm border border-slate-200">
                        <motion.div
                          animate={{ rotate: [0, 360] }}
                          transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                        >
                          <Scale className="h-4 w-4 text-slate-600" />
                        </motion.div>
                      </div>
                    </motion.div>
                    <div className="flex-1 min-w-0">
                      <motion.div 
                        className="leading-relaxed"
                        initial={{ opacity: 0, y: 3 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.2, duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
                      >
                        <div className="flex items-center space-x-3">
                          <span className="text-sm text-slate-700 font-medium">Mike аналізує правову ситуацію</span>
                          <div className="flex space-x-1">
                            {[0, 1, 2].map((i) => (
                              <motion.div
                                key={i}
                                className="w-2 h-2 bg-blue-500 rounded-full"
                                animate={{ 
                                  scale: [1, 1.3, 1],
                                  opacity: [0.4, 1, 0.4]
                                }}
                                transition={{ 
                                  duration: 1.2, 
                                  repeat: Infinity,
                                  delay: i * 0.15,
                                  ease: "easeInOut"
                                }}
                              />
                            ))}
                          </div>
                        </div>
                      </motion.div>
                      <div className="flex items-center justify-between mt-4">
                        <motion.p 
                          className="text-xs font-medium text-slate-400"
                          initial={{ opacity: 0, y: 2 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: 0.4, duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
                        >
                          {new Date().toLocaleTimeString('uk-UA', {
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: false
                          })}
                        </motion.p>
                        <motion.div
                          initial={{ opacity: 0, scale: 0.8 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ delay: 0.6, duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                          className="flex items-center space-x-1"
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleCancelPrompt}
                            className="h-6 w-6 p-0 text-slate-400 hover:text-red-600 hover:bg-red-50 transition-all duration-200"
                          >
                            <Square className="h-3 w-3" />
                          </Button>
                        </motion.div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>

      {/* Input Area */}
      <motion.div 
        key={currentChatId}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
        className="p-6 pb-12 bg-transparent flex-shrink-0"
      >
        <div className="relative max-w-2xl mx-auto">
          {/* Integrated Input with Button */}
          <div className="integrated-input-container">
            <input
              type="text"
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Над чим ви працюєте?"
              className="integrated-input"
              disabled={isLoading}
            />
            <AnimatePresence mode="wait">
              {isLoading ? (
                <motion.div 
                  key="cancel"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                >
                  <button 
                    type="button"
                    onClick={handleCancelPrompt}
                    className="integrated-button bg-slate-500 hover:bg-slate-600 text-white font-medium"
                  >
                    <Square className="h-4 w-4" />
                  </button>
                </motion.div>
              ) : (
                <motion.div
                  key="send"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
                >
                  <button 
                    type="button"
                    onClick={handleSendMessage} 
                    disabled={!inputMessage.trim()}
                    className="integrated-button bg-blue-500 hover:bg-blue-600 disabled:bg-slate-300 disabled:opacity-50 text-white font-medium"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </motion.div>
    </div>
  );
}