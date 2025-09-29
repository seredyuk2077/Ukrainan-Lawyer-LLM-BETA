import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { BookOpen, Search, Scale, Users, Home, Briefcase, LucideIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

interface KnowledgeItem {
  id: string;
  title: string;
  category: string;
  content: string;
  icon: LucideIcon;
}

export default function KnowledgeBase() {
  const [searchTerm, setSearchTerm] = useState('');
  const [openItems, setOpenItems] = useState<string[]>([]);

  const knowledgeItems: KnowledgeItem[] = [
    {
      id: '1',
      title: 'Цивільне право',
      category: 'Основи права',
      icon: Scale,
      content: `Цивільне право регулює майнові та особисті немайнові відносини між фізичними та юридичними особами.

Основні принципи:
• Рівність учасників
• Неприпустимість свавільного втручання
• Свобода договору
• Недоторканність власності

Основні інститути:
• Право власності
• Зобов'язальне право
• Спадкове право
• Авторське право`
    },
    {
      id: '2',
      title: 'Трудове право',
      category: 'Трудові відносини',
      icon: Briefcase,
      content: `Трудове право регулює відносини між працівниками та роботодавцями.

Основні права працівника:
• Право на працю
• Право на справедливу оплату
• Право на відпочинок
• Право на безпечні умови праці

Трудовий договір:
• Строковий та безстроковий
• Випробувальний строк
• Умови праці
• Розірвання договору`
    },
    {
      id: '3',
      title: 'Сімейне право',
      category: 'Сімейні відносини',
      icon: Users,
      content: `Сімейне право регулює особисті немайнові та майнові відносини між членами сім'ї.

Шлюб:
• Умови укладення шлюбу
• Права та обов'язки подружжя
• Розірвання шлюбу
• Шлюбний договір

Батьківство:
• Права та обов'язки батьків
• Права дитини
• Аліменти
• Усиновлення`
    },
    {
      id: '4',
      title: 'Житлове право',
      category: 'Житлові відносини',
      icon: Home,
      content: `Житлове право регулює відносини щодо користування житловими приміщеннями.

Право на житло:
• Конституційне право
• Соціальне житло
• Приватизація
• Житлові субсидії

Договори найму:
• Комерційний найм
• Соціальний найм
• Права та обов'язки сторін
• Виселення`
    }
  ];

  const filteredItems = knowledgeItems.filter(item =>
    item.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
    item.content.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const toggleItem = (itemId: string) => {
    setOpenItems(prev =>
      prev.includes(itemId)
        ? prev.filter(id => id !== itemId)
        : [...prev, itemId]
    );
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">База знань</h2>
        <p className="text-gray-600">
          Корисна інформація з різних галузей права
        </p>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
        <Input
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Пошук в базі знань..."
          className="pl-10"
        />
      </div>

      <div className="space-y-4">
        {filteredItems.map((item) => {
          const Icon = item.icon;
          const isOpen = openItems.includes(item.id);
          
          return (
            <Card key={item.id} className="overflow-hidden">
              <Collapsible
                open={isOpen}
                onOpenChange={() => toggleItem(item.id)}
              >
                <CollapsibleTrigger className="w-full p-6 text-left hover:bg-gray-50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-4">
                      <Icon className="h-6 w-6 text-blue-600" />
                      <div>
                        <h3 className="text-lg font-semibold">{item.title}</h3>
                        <Badge variant="secondary" className="mt-1">
                          {item.category}
                        </Badge>
                      </div>
                    </div>
                    <BookOpen className={`h-5 w-5 text-gray-400 transition-transform ${
                      isOpen ? 'rotate-180' : ''
                    }`} />
                  </div>
                </CollapsibleTrigger>
                
                <CollapsibleContent>
                  <div className="px-6 pb-6 pt-0">
                    <div className="bg-gray-50 p-4 rounded-lg">
                      <pre className="whitespace-pre-wrap text-sm text-gray-700 font-sans">
                        {item.content}
                      </pre>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          );
        })}
      </div>

      {filteredItems.length === 0 && (
        <Card className="p-8 text-center">
          <BookOpen className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-gray-600 mb-2">
            Нічого не знайдено
          </h3>
          <p className="text-gray-500">
            Спробуйте змінити пошуковий запит
          </p>
        </Card>
      )}
    </div>
  );
}