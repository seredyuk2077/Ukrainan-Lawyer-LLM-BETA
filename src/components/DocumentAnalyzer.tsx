import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Upload, FileText, AlertCircle, CheckCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function DocumentAnalyzer() {
  const [documentText, setDocumentText] = useState('');
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const analyzeDocument = () => {
    if (!documentText.trim()) return;

    setIsAnalyzing(true);
    
    // Simulate analysis
    setTimeout(() => {
      const analysisResult = generateAnalysis(documentText);
      setAnalysis(analysisResult);
      setIsAnalyzing(false);
    }, 2000);
  };

  const generateAnalysis = (text: string): string => {
    const lowerText = text.toLowerCase();
    let analysis = "АНАЛІЗ ДОКУМЕНТА:\n\n";

    if (lowerText.includes('договір') || lowerText.includes('контракт')) {
      analysis += "✓ Тип документа: Договір\n";
      analysis += "✓ Рекомендації:\n";
      analysis += "  - Перевірте наявність всіх істотних умов\n";
      analysis += "  - Переконайтеся в правильності реквізитів сторін\n";
      analysis += "  - Уточніть строки виконання зобов'язань\n\n";
    }

    if (lowerText.includes('заповіт')) {
      analysis += "✓ Тип документа: Заповіт\n";
      analysis += "✓ Рекомендації:\n";
      analysis += "  - Перевірте відповідність вимогам закону\n";
      analysis += "  - Переконайтеся в чіткості формулювань\n";
      analysis += "  - Розгляньте можливість нотаріального посвідчення\n\n";
    }

    if (lowerText.includes('позов') || lowerText.includes('заява')) {
      analysis += "✓ Тип документа: Процесуальний документ\n";
      analysis += "✓ Рекомендації:\n";
      analysis += "  - Перевірте правильність найменування суду\n";
      analysis += "  - Переконайтеся в обґрунтованості вимог\n";
      analysis += "  - Додайте необхідні докази\n\n";
    }

    analysis += "⚠️ УВАГА: Цей аналіз має рекомендаційний характер. Для отримання професійної юридичної допомоги зверніться до кваліфікованого юриста.";

    return analysis;
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && file.type === 'text/plain') {
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        setDocumentText(content);
      };
      reader.readAsText(file);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4 flex items-center">
          <FileText className="h-5 w-5 mr-2 text-blue-600" />
          Аналіз документів
        </h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">
              Завантажити документ або вставити текст:
            </label>
            <div className="flex items-center space-x-4 mb-4">
              <input
                type="file"
                accept=".txt"
                onChange={handleFileUpload}
                className="hidden"
                id="file-upload"
              />
              <Button
                variant="outline"
                onClick={() => document.getElementById('file-upload')?.click()}
              >
                <Upload className="h-4 w-4 mr-2" />
                Завантажити файл
              </Button>
              <span className="text-sm text-gray-500">або введіть текст нижче</span>
            </div>
          </div>

          <Textarea
            value={documentText}
            onChange={(e) => setDocumentText(e.target.value)}
            placeholder="Вставте текст документа для аналізу..."
            className="min-h-[200px]"
          />

          <Button 
            onClick={analyzeDocument} 
            disabled={!documentText.trim() || isAnalyzing}
            className="w-full"
          >
            {isAnalyzing ? 'Аналізую...' : 'Проаналізувати документ'}
          </Button>
        </div>
      </Card>

      {analysis && (
        <Card className="p-6">
          <h4 className="text-lg font-semibold mb-4 flex items-center">
            <CheckCircle className="h-5 w-5 mr-2 text-green-600" />
            Результат аналізу
          </h4>
          <div className="bg-gray-50 p-4 rounded-lg">
            <pre className="whitespace-pre-wrap text-sm">{analysis}</pre>
          </div>
          
          <Alert className="mt-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Цей аналіз має інформаційний характер і не замінює професійної юридичної консультації.
            </AlertDescription>
          </Alert>
        </Card>
      )}
    </div>
  );
}