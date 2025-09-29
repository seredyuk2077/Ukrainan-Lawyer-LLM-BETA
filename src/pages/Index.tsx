import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import ChatInterface from '@/components/ChatInterface';
import ChatHistory from '@/components/ChatHistory';
import ContractGenerator from '@/components/ContractGenerator';
import { useChatStore } from '@/store/chatStore';
import { Scale, Sparkles, Crown, Zap, Database, Menu, X } from 'lucide-react';

type ViewMode = 'chat' | 'contracts';

export default function Index() {
  const { createNewChat, selectChat, currentChatId, loadChats } = useChatStore();
  const [viewMode, setViewMode] = useState<ViewMode>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [hoverSidebar, setHoverSidebar] = useState(false);

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
    <div className="h-screen overflow-hidden bg-gradient-to-br from-slate-50 to-white relative">

      {/* Header */}
    <header className="bg-white border-b border-slate-200/50 shadow-lg">
      <div className="container mx-auto px-6 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <div className="w-12 h-12 bg-gradient-to-br from-blue-500 via-blue-600 to-blue-700 rounded-xl flex items-center justify-center shadow-lg">
                <Scale className="h-6 w-6 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-slate-800">
                  Український Юрист
                </h1>
              </div>
            </div>
            
            <div className="text-right">
              <div className="flex items-center space-x-3">
                <span className="text-sm text-slate-500">Powered by</span>
                <span className="text-sm font-semibold text-blue-600">Supabase</span>
                <span className="px-3 py-1.5 text-sm font-medium bg-blue-100 text-blue-700 rounded-full">
                  v2.0
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="h-[calc(100vh-80px)] relative z-10 flex">
        <div className="flex h-full w-full">
          {/* Hover Zone for Sidebar */}
          <div 
            className="fixed left-0 top-0 w-8 h-full z-40"
            onMouseEnter={() => setHoverSidebar(true)}
            onMouseLeave={() => setHoverSidebar(false)}
          />


          {/* Sidebar - Chat History */}
          <AnimatePresence>
            {(sidebarOpen || hoverSidebar) && (
              <motion.div 
                initial={{ opacity: 0, x: -320, width: 0 }}
                animate={{ opacity: 1, x: 0, width: 320 }}
                exit={{ opacity: 0, x: -320, width: 0 }}
                transition={{ 
                  duration: 0.5, 
                  ease: [0.4, 0, 0.2, 1],
                  width: { duration: 0.5, ease: [0.4, 0, 0.2, 1] }
                }}
                className="h-full flex-shrink-0 relative border-r border-slate-200 shadow-lg"
                onMouseEnter={() => setHoverSidebar(true)}
                onMouseLeave={() => setHoverSidebar(false)}
              >
                <ChatHistory 
                  onSelectChat={handleSelectChat}
                  onNewChat={handleNewChat}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Main Content Area - Full Screen */}
          <motion.div 
            initial={{ opacity: 0, scale: 0.99 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.1, duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
            className="flex-1 h-full"
          >
            <AnimatePresence mode="wait">
              {viewMode === 'chat' ? (
                <motion.div
                  key="chat"
                  initial={{ opacity: 0, scale: 0.99 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.99 }}
                  transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
                  className="h-full"
                >
                  <ChatInterface onOpenContractGenerator={handleOpenContractGenerator} />
                </motion.div>
              ) : (
                <motion.div
                  key="contracts"
                  initial={{ opacity: 0, scale: 0.99 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.99 }}
                  transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
                  className="h-full"
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