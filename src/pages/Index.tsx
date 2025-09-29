import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import ChatInterface from '@/components/ChatInterface';
import ChatHistory from '@/components/ChatHistory';
import ContractGenerator from '@/components/ContractGenerator';
import { useChatStore } from '@/store/chatStore';
import { Scale, Sparkles, Crown, Zap, Database } from 'lucide-react';

type ViewMode = 'chat' | 'contracts';

export default function Index() {
  const { createNewChat, selectChat, currentChatId, loadChats } = useChatStore();
  const [viewMode, setViewMode] = useState<ViewMode>('chat');

  useEffect(() => {
    // Load chats from Supabase on component mount
    loadChats();
    
    // Create initial chat if none exists
    if (!currentChatId) {
      createNewChat();
    }
  }, [currentChatId, createNewChat, loadChats]);

  const handleNewChat = () => {
    createNewChat();
    setViewMode('chat');
  };

  const handleSelectChat = (chatId: string) => {
    selectChat(chatId);
    setViewMode('chat');
  };

  const handleOpenContractGenerator = () => {
    setViewMode('contracts');
  };

  const handleBackToChat = () => {
    setViewMode('chat');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 relative overflow-hidden">
      {/* Enhanced animated background elements */}
      <div className="absolute inset-0 overflow-hidden">
        <motion.div 
          className="absolute -top-40 -right-40 w-80 h-80 bg-gradient-to-br from-amber-400/10 to-orange-500/10 rounded-full blur-3xl"
          animate={{ 
            scale: [1, 1.1, 1],
            opacity: [0.3, 0.5, 0.3],
            rotate: [0, 180, 360]
          }}
          transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
        />
        <motion.div 
          className="absolute -bottom-40 -left-40 w-80 h-80 bg-gradient-to-br from-blue-400/10 to-purple-500/10 rounded-full blur-3xl"
          animate={{ 
            scale: [1, 1.2, 1],
            opacity: [0.2, 0.4, 0.2],
            rotate: [360, 180, 0]
          }}
          transition={{ duration: 25, repeat: Infinity, ease: "linear" }}
        />
        <motion.div 
          className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-gradient-to-br from-emerald-400/5 to-teal-500/5 rounded-full blur-3xl"
          animate={{ 
            scale: [1, 1.15, 1],
            opacity: [0.1, 0.3, 0.1]
          }}
          transition={{ duration: 30, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>

      {/* Header */}
      <motion.header 
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="relative z-10 bg-gradient-to-r from-slate-900/95 via-slate-800/95 to-slate-900/95 backdrop-blur-xl border-b border-white/10 shadow-2xl"
      >
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <motion.div 
              className="flex items-center space-x-4"
              whileHover={{ scale: 1.02 }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
            >
              <div className="relative">
                <motion.div 
                  className="w-14 h-14 bg-gradient-to-br from-amber-400 via-amber-500 to-orange-500 rounded-2xl flex items-center justify-center shadow-2xl"
                  animate={{ 
                    boxShadow: [
                      "0 0 20px rgba(245, 158, 11, 0.4)",
                      "0 0 40px rgba(245, 158, 11, 0.6)",
                      "0 0 20px rgba(245, 158, 11, 0.4)"
                    ]
                  }}
                  transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                >
                  <Scale className="h-7 w-7 text-white" />
                </motion.div>
                <motion.div 
                  className="absolute -top-1 -right-1 w-5 h-5 bg-gradient-to-r from-green-400 to-emerald-500 rounded-full border-2 border-white shadow-lg"
                  animate={{ 
                    scale: [1, 1.3, 1],
                    opacity: [0.8, 1, 0.8]
                  }}
                  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                />
              </div>
              <div>
                <motion.h1 
                  className="text-3xl font-bold bg-gradient-to-r from-white via-slate-100 to-amber-200 bg-clip-text text-transparent"
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.3, duration: 0.6 }}
                >
                  Український Юрист
                </motion.h1>
                <motion.p 
                  className="text-sm text-slate-300 flex items-center mt-1"
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.4, duration: 0.6 }}
                >
                  <Database className="h-3 w-3 mr-1 text-green-400" />
                  Powered by Supabase
                  <Sparkles className="h-3 w-3 ml-2 text-amber-400" />
                  AI Правовий Консультант
                  <Crown className="h-3 w-3 ml-2 text-yellow-400" />
                </motion.p>
              </div>
            </motion.div>
            
            <motion.div 
              className="text-right"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.5, duration: 0.6 }}
            >
              <div className="flex items-center space-x-2 mb-1">
                <motion.div
                  animate={{ rotate: [0, 360] }}
                  transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
                >
                  <Zap className="h-4 w-4 text-amber-400" />
                </motion.div>
                <span className="text-sm font-semibold bg-gradient-to-r from-amber-400 to-orange-500 bg-clip-text text-transparent">
                  by ANDRII SEREDIUK
                </span>
                <motion.span 
                  className="px-2 py-1 text-xs font-bold bg-gradient-to-r from-red-500 to-pink-500 text-white rounded-full shadow-lg"
                  animate={{ 
                    scale: [1, 1.05, 1],
                    boxShadow: [
                      "0 0 10px rgba(239, 68, 68, 0.5)",
                      "0 0 20px rgba(239, 68, 68, 0.8)",
                      "0 0 10px rgba(239, 68, 68, 0.5)"
                    ]
                  }}
                  transition={{ duration: 2, repeat: Infinity }}
                >
                  LIVE
                </motion.span>
              </div>
              <p className="text-xs text-slate-400">Supabase + OpenAI GPT-4</p>
            </motion.div>
          </div>
        </div>
      </motion.header>

      {/* Main Content */}
      <main className="container mx-auto px-6 py-6 h-[calc(100vh-88px)] relative z-10">
        <div className="grid grid-cols-12 gap-6 h-full" style={{ height: '100%', maxHeight: 'calc(100vh - 100px)' }}>
          {/* Sidebar - Chat History */}
          <motion.div 
            initial={{ opacity: 0, x: -30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2, duration: 0.8, ease: "easeOut" }}
            className="col-span-4 h-full"
          >
            <ChatHistory 
              onSelectChat={handleSelectChat}
              onNewChat={handleNewChat}
            />
          </motion.div>

          {/* Main Content Area */}
          <motion.div 
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.3, duration: 0.8, ease: "easeOut" }}
            className="col-span-8 h-full"
          >
            <AnimatePresence mode="wait">
              {viewMode === 'chat' ? (
                <motion.div
                  key="chat"
                  initial={{ opacity: 0, scale: 0.95, y: 20 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: -20 }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                >
                  <ChatInterface onOpenContractGenerator={handleOpenContractGenerator} />
                </motion.div>
              ) : (
                <motion.div
                  key="contracts"
                  initial={{ opacity: 0, scale: 0.95, y: 20 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: -20 }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                >
                  <ContractGenerator onBack={handleBackToChat} />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </div>
      </main>
    </div>
  );
}