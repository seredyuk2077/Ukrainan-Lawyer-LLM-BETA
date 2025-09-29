import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { FileText, Download, Eye } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { LegalAgent, LegalTemplate } from '@/lib/legalAgent';

export default function LegalTemplates() {
  const [templates] = useState<LegalTemplate[]>(LegalAgent.getLegalTemplates());
  const [selectedTemplate, setSelectedTemplate] = useState<LegalTemplate | null>(null);

  const downloadTemplate = (template: LegalTemplate) => {
    const element = document.createElement('a');
    const file = new Blob([template.content], { type: 'text/plain' });
    element.href = URL.createObjectURL(file);
    element.download = `${template.title}.txt`;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Юридичні шаблони</h2>
        <p className="text-gray-600">
          Готові шаблони документів для різних правових ситуацій
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {templates.map((template) => (
          <Card key={template.id} className="p-6 hover:shadow-lg transition-shadow">
            <div className="flex items-start justify-between mb-4">
              <FileText className="h-8 w-8 text-blue-600" />
              <Badge variant="secondary">{template.category}</Badge>
            </div>
            
            <h3 className="text-lg font-semibold mb-2">{template.title}</h3>
            <p className="text-gray-600 text-sm mb-4">{template.description}</p>
            
            <div className="flex space-x-2">
              <Dialog>
                <DialogTrigger asChild>
                  <Button 
                    variant="outline" 
                    size="sm"
                    onClick={() => setSelectedTemplate(template)}
                  >
                    <Eye className="h-4 w-4 mr-1" />
                    Переглянути
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>{template.title}</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <Badge>{template.category}</Badge>
                    <p className="text-gray-600">{template.description}</p>
                    <Textarea
                      value={template.content}
                      readOnly
                      className="min-h-[300px] font-mono text-sm"
                    />
                    <Button 
                      onClick={() => downloadTemplate(template)}
                      className="w-full"
                    >
                      <Download className="h-4 w-4 mr-2" />
                      Завантажити шаблон
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
              
              <Button 
                size="sm"
                onClick={() => downloadTemplate(template)}
              >
                <Download className="h-4 w-4 mr-1" />
                Завантажити
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <Card className="p-6 bg-blue-50 border-blue-200">
        <div className="flex items-center space-x-3">
          <FileText className="h-6 w-6 text-blue-600" />
          <div>
            <h4 className="font-semibold text-blue-900">Потрібен індивідуальний шаблон?</h4>
            <p className="text-blue-700 text-sm">
              Зверніться до розділу "Консультація" для отримання персоналізованої допомоги
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}