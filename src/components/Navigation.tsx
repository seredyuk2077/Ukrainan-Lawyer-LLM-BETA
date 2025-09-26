import { Button } from '@/components/ui/button';
import { Scale, MessageSquare, FileText, BookOpen, Upload } from 'lucide-react';

interface NavigationProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
}

export default function Navigation({ activeTab, onTabChange }: NavigationProps) {
  const tabs = [
    { id: 'chat', label: 'Чат з Mike', icon: MessageSquare },
    { id: 'documents', label: 'Аналіз документів', icon: Upload },
    { id: 'templates', label: 'Шаблони', icon: FileText },
    { id: 'knowledge', label: 'База знань', icon: BookOpen },
  ];

  return (
    <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 shadow-xl border-b border-slate-700">
      <div className="max-w-6xl mx-auto px-4">
        <div className="flex items-center justify-between py-6">
          <div className="flex items-center space-x-3">
            <div className="relative">
              <Scale className="h-8 w-8 text-amber-400" />
              <div className="absolute -top-1 -right-1 w-3 h-3 bg-blue-500 rounded-full animate-pulse"></div>
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">Юридичний агент</h1>
              <p className="text-sm text-slate-400">LLM для юристів</p>
            </div>
          </div>
          
          <nav className="flex space-x-2">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <Button
                  key={tab.id}
                  variant={activeTab === tab.id ? 'default' : 'ghost'}
                  onClick={() => onTabChange(tab.id)}
                  className={`flex items-center space-x-2 transition-all duration-300 ${
                    activeTab === tab.id 
                      ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-black shadow-lg transform scale-105' 
                      : 'text-slate-300 hover:text-white hover:bg-slate-700/50'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="font-medium">{tab.label}</span>
                </Button>
              );
            })}
          </nav>
        </div>
      </div>
    </div>
  );
}