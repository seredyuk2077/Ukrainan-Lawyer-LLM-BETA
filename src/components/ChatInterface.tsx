import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Send, User, Sparkles, Scale, FileText, Zap, Crown, Copy, ThumbsUp, ThumbsDown, AlertCircle, ChevronDown } from 'lucide-react';
import { useChatStore } from '@/store/chatStore';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

interface ChatInterfaceProps {
  onOpenContractGenerator: () => void;
}

const formatMessage = (content: string) => {
  let formatted = content;
  
  // Bold text (**text** or __text__)
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong class="text-slate-900 font-bold bg-gradient-to-r from-amber-100 to-orange-100 px-1 rounded">$1</strong>');
  formatted = formatted.replace(/__(.*?)__/g, '<strong class="text-slate-900 font-bold">$1</strong>');
  
  // Italic text (*text* or _text_)
  formatted = formatted.replace(/\*(.*?)\*/g, '<em class="text-slate-800 italic font-medium">$1</em>');
  formatted = formatted.replace(/_(.*?)_/g, '<em class="text-slate-800 italic">$1</em>');
  
  // Code blocks (```code```)
  formatted = formatted.replace(/```(.*?)```/gs, '<div class="bg-gradient-to-r from-slate-800 to-slate-900 border-l-4 border-amber-400 rounded-r-xl p-4 my-4 font-mono text-sm overflow-x-auto shadow-lg"><code class="text-green-300">$1</code></div>');
  
  // Inline code (`code`)
  formatted = formatted.replace(/`(.*?)`/g, '<code class="bg-gradient-to-r from-amber-50 to-orange-50 px-2 py-1 rounded-lg text-sm font-mono text-slate-900 border border-amber-200 shadow-sm">$1</code>');
  
  // Lists with enhanced styling
  formatted = formatted.replace(/^• (.*$)/gm, '<li class="ml-8 mb-3 text-slate-800 relative flex items-start"><span class="absolute -left-6 top-1 w-2 h-2 bg-gradient-to-r from-amber-400 to-orange-500 rounded-full shadow-sm"></span><span class="leading-relaxed">$1</span></li>');
  formatted = formatted.replace(/^- (.*$)/gm, '<li class="ml-8 mb-3 text-slate-800 relative flex items-start"><span class="absolute -left-6 top-2 w-1 h-4 bg-gradient-to-b from-blue-400 to-blue-600 rounded-full"></span><span class="leading-relaxed">$1</span></li>');
  formatted = formatted.replace(/^\d+\. (.*$)/gm, '<li class="ml-8 mb-3 text-slate-800 list-decimal font-medium leading-relaxed">$1</li>');
  
  // Wrap consecutive list items with enhanced container
  formatted = formatted.replace(/(<li.*?<\/li>\s*)+/g, '<ul class="space-y-2 my-6 bg-gradient-to-r from-slate-50/80 via-white to-slate-50/80 p-5 rounded-xl border-l-4 border-amber-300 shadow-sm backdrop-blur-sm">$&</ul>');
  
  // Enhanced section headers
  formatted = formatted.replace(/^(#{1,3})\s*(.*$)/gm, '<h3 class="text-lg font-bold text-slate-900 mt-6 mb-3 pb-2 border-b-2 border-gradient-to-r from-amber-300 to-orange-300 bg-gradient-to-r from-amber-500 to-orange-600 bg-clip-text text-transparent">$2</h3>');
  
  // Line breaks with better spacing
  formatted = formatted.replace(/\n\n/g, '</p><p class="mt-4 text-slate-800 leading-relaxed">');
  formatted = formatted.replace(/\n/g, '<br>');
  
  return `<div class="prose prose-slate max-w-none"><p class="text-slate-800 leading-relaxed">${formatted}</p></div>`;
};

export default function ChatInterface({ onOpenContractGenerator }: ChatInterfaceProps) {
  const { 
    currentMessages, 
    currentChatId, 
    sendMessage, 
    isLoading, 
    error, 
    clearError,
    getCurrentChat
  } = useChatStore();
  
  const [inputMessage, setInputMessage] = useState('');
  const [showScrollButton, setShowScrollButton] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const currentChat = getCurrentChat();

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
    const timeoutId = setTimeout(scrollToBottom, 100);
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
      setTimeout(scrollToBottom, 50);
    }
  }, [isLoading]);

  // Check if user is scrolled up to show scroll button
  useEffect(() => {
    const checkScrollPosition = () => {
      if (scrollAreaRef.current) {
        const { scrollTop, scrollHeight, clientHeight } = scrollAreaRef.current;
        const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
        setShowScrollButton(!isNearBottom && currentMessages.length > 0);
      }
    };

    if (scrollAreaRef.current) {
      scrollAreaRef.current.addEventListener('scroll', checkScrollPosition);
      return () => scrollAreaRef.current?.removeEventListener('scroll', checkScrollPosition);
    }
  }, [currentMessages]);

  // Manual scroll to bottom function
  const scrollToBottom = () => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTo({
        top: scrollAreaRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  };

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
            Розпочніть консультацію з Mike Ross
          </p>
        </motion.div>
      </div>
    );
  }

  return (
    <Card className="h-full flex flex-col shadow-2xl border border-slate-200/50 backdrop-blur-xl bg-gradient-to-br from-white via-slate-50/50 to-white overflow-hidden" style={{ height: '100%', maxHeight: 'calc(100vh - 100px)' }}>
      {/* Enhanced Header */}
      <motion.div 
        className="p-6 border-b border-slate-200/50 bg-gradient-to-r from-white via-slate-50 to-white backdrop-blur-xl shadow-sm"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <motion.div 
              className="relative"
              whileHover={{ scale: 1.05 }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
            >
              <motion.div 
                className="w-14 h-14 bg-gradient-to-br from-amber-400 via-amber-500 to-orange-500 rounded-2xl flex items-center justify-center shadow-xl border-2 border-white"
                animate={{
                  boxShadow: [
                    "0 0 20px rgba(245, 158, 11, 0.3)",
                    "0 0 30px rgba(245, 158, 11, 0.5)",
                    "0 0 20px rgba(245, 158, 11, 0.3)"
                  ]
                }}
                transition={{ duration: 3, repeat: Infinity }}
              >
                <Scale className="h-7 w-7 text-white" />
              </motion.div>
              <motion.div 
                className="absolute -top-1 -right-1 w-5 h-5 bg-gradient-to-r from-green-400 to-emerald-500 rounded-full border-2 border-white shadow-lg"
                animate={{ 
                  scale: [1, 1.3, 1],
                  opacity: [0.8, 1, 0.8]
                }}
                transition={{ duration: 2, repeat: Infinity }}
              />
            </motion.div>
            <div>
              <motion.h3 
                className="text-xl font-bold bg-gradient-to-r from-slate-800 to-slate-600 bg-clip-text text-transparent flex items-center"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.2 }}
              >
                Mike Ross
                <Crown className="h-5 w-5 ml-2 text-yellow-500" />
                <motion.div
                  animate={{ rotate: [0, 360] }}
                  transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
                >
                  <Sparkles className="h-5 w-5 ml-1 text-amber-500" />
                </motion.div>
              </motion.h3>
              <motion.p 
                className="text-sm text-slate-600 flex items-center font-medium"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.3 }}
              >
                <Zap className="h-4 w-4 mr-1 text-blue-500" />
                Powered by Supabase • Український Юрист
              </motion.p>
            </div>
          </div>
          
          <motion.div
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
          >
            <Button
              onClick={onOpenContractGenerator}
              className="bg-gradient-to-r from-amber-500 via-amber-600 to-orange-600 hover:from-amber-600 hover:via-amber-700 hover:to-orange-700 text-white shadow-xl border border-amber-400/30 backdrop-blur-sm px-6 py-3 rounded-xl font-semibold"
            >
              <FileText className="h-5 w-5 mr-2" />
              Створити договір
            </Button>
          </motion.div>
        </div>
      </motion.div>

      {/* Error Display */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="px-6 py-3 bg-red-50 border-b border-red-200 flex items-center space-x-2 text-red-700"
        >
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
        </motion.div>
      )}

      {/* Enhanced Messages Area */}
      <div 
        className="flex-1 bg-gradient-to-b from-slate-50/30 via-white to-slate-50/30 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent hover:scrollbar-thumb-slate-400" 
        ref={scrollAreaRef}
        style={{ 
          scrollBehavior: 'smooth',
          height: '100%',
          maxHeight: 'calc(100vh - 200px)'
        }}
      >
        <div className="p-4 md:p-8 space-y-6 md:space-y-8 pb-8" style={{ minHeight: '100%' }}>
          <AnimatePresence>
            {/* Test content for scrolling */}
            {currentMessages.length === 0 && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center py-8"
              >
                <motion.div
                  animate={{ 
                    scale: [1, 1.05, 1],
                    opacity: [0.7, 1, 0.7]
                  }}
                  transition={{ duration: 2, repeat: Infinity }}
                  className="w-16 h-16 mx-auto mb-4 bg-gradient-to-br from-amber-400 to-orange-500 rounded-2xl flex items-center justify-center"
                >
                  <Scale className="h-8 w-8 text-white" />
                </motion.div>
                <h3 className="text-lg font-semibold text-slate-700 mb-2">
                  Привіт! Я Mike Ross
                </h3>
                <p className="text-slate-500 mb-4">
                  Ваш AI-асистент з українського права
                </p>
                <div className="space-y-2 text-sm text-slate-400">
                  <p>• Задайте питання про права та обов'язки</p>
                  <p>• Отримайте консультацію з законодавства</p>
                  <p>• Створіть правові документи</p>
                </div>
              </motion.div>
            )}
            {currentMessages.map((message, index) => (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, y: 30, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -30, scale: 0.95 }}
                transition={{ 
                  delay: index * 0.1,
                  duration: 0.5,
                  type: "spring",
                  stiffness: 300,
                  damping: 25
                }}
                className={`flex ${message.type === 'user' ? 'justify-end' : 'justify-start'} px-2 md:px-0`}
              >
                <motion.div
                  whileHover={{ 
                    scale: 1.01,
                    y: -2,
                    transition: { duration: 0.2 }
                  }}
                  className={`max-w-[90%] md:max-w-[85%] rounded-2xl md:rounded-3xl p-4 md:p-6 shadow-xl transition-all duration-300 group relative ${
                    message.type === 'user'
                      ? 'bg-gradient-to-br from-blue-600 via-blue-700 to-blue-800 text-white border border-blue-500/30 shadow-blue-200/50'
                      : 'bg-gradient-to-br from-white via-slate-50/50 to-white text-slate-800 border border-slate-200/50 shadow-slate-200/50'
                  }`}
                >
                  <div className="flex items-start space-x-4">
                    {message.type === 'agent' && (
                      <motion.div 
                        className="flex-shrink-0 mt-1"
                        initial={{ rotate: -15, scale: 0.8 }}
                        animate={{ rotate: 0, scale: 1 }}
                        transition={{ type: "spring", stiffness: 400, damping: 25 }}
                      >
                        <motion.div 
                          className="w-10 h-10 bg-gradient-to-br from-amber-400 via-amber-500 to-orange-500 rounded-2xl flex items-center justify-center shadow-lg border-2 border-white"
                          animate={{
                            boxShadow: [
                              "0 0 15px rgba(245, 158, 11, 0.3)",
                              "0 0 25px rgba(245, 158, 11, 0.5)",
                              "0 0 15px rgba(245, 158, 11, 0.3)"
                            ]
                          }}
                          transition={{ duration: 2, repeat: Infinity }}
                        >
                          <Scale className="h-5 w-5 text-white" />
                        </motion.div>
                      </motion.div>
                    )}
                    {message.type === 'user' && (
                      <motion.div 
                        className="flex-shrink-0 mt-1"
                        initial={{ rotate: 15, scale: 0.8 }}
                        animate={{ rotate: 0, scale: 1 }}
                        transition={{ type: "spring", stiffness: 400, damping: 25 }}
                      >
                        <div className="w-10 h-10 bg-white/20 rounded-2xl flex items-center justify-center backdrop-blur-sm border-2 border-white/30 shadow-lg">
                          <User className="h-5 w-5 text-white" />
                        </div>
                      </motion.div>
                    )}
                    <div className="flex-1 min-w-0">
                      <motion.div 
                        className="leading-relaxed"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.2 }}
                        dangerouslySetInnerHTML={{ 
                          __html: formatMessage(message.content)
                        }}
                      />
                      <div className="flex items-center justify-between mt-4">
                        <motion.p 
                          className={`text-xs font-medium ${
                            message.type === 'user' ? 'text-blue-100' : 'text-slate-500'
                          }`}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: 0.4 }}
                        >
                          {message.timestamp.toLocaleTimeString('uk-UA', {
                            hour: '2-digit',
                            minute: '2-digit'
                          })}
                          {message.tokensUsed && (
                            <span className="ml-2 opacity-70">• {message.tokensUsed} токенів</span>
                          )}
                        </motion.p>
                        
                        {/* Message Actions */}
                        <motion.div 
                          className="flex items-center space-x-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                          initial={{ scale: 0.8 }}
                          animate={{ scale: 1 }}
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleCopyMessage(message.content)}
                            className={`h-8 w-8 p-0 rounded-lg ${
                              message.type === 'user' 
                                ? 'hover:bg-white/20 text-white/70 hover:text-white' 
                                : 'hover:bg-slate-100 text-slate-400 hover:text-slate-600'
                            }`}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                          {message.type === 'agent' && (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0 rounded-lg hover:bg-green-100 text-slate-400 hover:text-green-600"
                              >
                                <ThumbsUp className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0 rounded-lg hover:bg-red-100 text-slate-400 hover:text-red-600"
                              >
                                <ThumbsDown className="h-4 w-4" />
                              </Button>
                            </>
                          )}
                        </motion.div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            ))}
          </AnimatePresence>

          {isLoading && (
            <motion.div
              initial={{ opacity: 0, y: 30, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -30, scale: 0.9 }}
              transition={{ duration: 0.4 }}
              className="flex justify-start"
            >
              <div className="bg-gradient-to-br from-white via-slate-50/50 to-white border border-slate-200/50 rounded-3xl p-6 max-w-[85%] shadow-xl">
                <div className="flex items-center space-x-4">
                  <motion.div 
                    className="w-10 h-10 bg-gradient-to-br from-amber-400 via-amber-500 to-orange-500 rounded-2xl flex items-center justify-center shadow-lg border-2 border-white"
                    animate={{ rotate: [0, 360] }}
                    transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                  >
                    <Scale className="h-5 w-5 text-white" />
                  </motion.div>
                  <div className="flex items-center space-x-4">
                    <span className="text-sm text-slate-700 font-semibold">Mike аналізує правову ситуацію</span>
                    <div className="flex space-x-1">
                      {[0, 1, 2].map((i) => (
                        <motion.div
                          key={i}
                          className="w-3 h-3 bg-gradient-to-r from-amber-400 to-orange-500 rounded-full"
                          animate={{ 
                            scale: [1, 1.5, 1],
                            opacity: [0.5, 1, 0.5]
                          }}
                          transition={{ 
                            duration: 1.5, 
                            repeat: Infinity,
                            delay: i * 0.2
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </div>
      </div>

      {/* Scroll to Bottom Button */}
      <AnimatePresence>
        {showScrollButton && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 20 }}
            className="absolute bottom-24 right-4 md:right-6 z-10"
          >
            <Button
              onClick={scrollToBottom}
              className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white shadow-xl border border-blue-500/30 backdrop-blur-sm rounded-full w-10 h-10 md:w-12 md:h-12 p-0"
              size="sm"
            >
              <ChevronDown className="h-4 w-4 md:h-5 md:w-5" />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Enhanced Input Area */}
      <motion.div 
        className="p-6 border-t border-slate-200/50 bg-gradient-to-r from-white via-slate-50/30 to-white backdrop-blur-xl"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <div className="flex space-x-4">
          <div className="flex-1 relative">
            <Input
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Опишіть вашу правову ситуацію..."
              className="h-14 text-base border-2 border-slate-300/50 focus:border-amber-400 focus:ring-4 focus:ring-amber-400/20 rounded-2xl shadow-lg pr-14 bg-white/80 backdrop-blur-sm transition-all duration-300 placeholder:text-slate-400 font-medium"
              disabled={isLoading}
            />
            <motion.div 
              className="absolute right-4 top-1/2 transform -translate-y-1/2"
              animate={{ 
                rotate: [0, 15, -15, 0],
                scale: [1, 1.1, 1]
              }}
              transition={{ duration: 3, repeat: Infinity }}
            >
              <Sparkles className="h-6 w-6 text-amber-500" />
            </motion.div>
          </div>
          <motion.div
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
          >
            <Button 
              onClick={handleSendMessage} 
              disabled={!inputMessage.trim() || isLoading}
              className="h-14 px-8 bg-gradient-to-r from-blue-600 via-blue-700 to-blue-800 hover:from-blue-700 hover:via-blue-800 hover:to-blue-900 rounded-2xl shadow-xl transition-all duration-300 disabled:opacity-50 border border-blue-500/30 font-semibold"
            >
              <Send className="h-6 w-6" />
            </Button>
          </motion.div>
        </div>
      </motion.div>
    </Card>
  );
}