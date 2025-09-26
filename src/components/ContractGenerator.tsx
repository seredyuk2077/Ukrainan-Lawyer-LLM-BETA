import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Download, FileText, Sparkles, Zap, Copy, Plus, Trash2, CheckCircle } from 'lucide-react';
import { contractTemplates, generateContract, validateContractData, type ContractTemplate } from '@/lib/contractTemplates';
import { generateWordDocument } from '@/lib/documentGenerator';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

interface ContractGeneratorProps {
  onBack: () => void;
}

interface ContractData {
  templateId: string;
  data: Record<string, string>;
}

export default function ContractGenerator({ onBack }: ContractGeneratorProps) {
  const [selectedTemplate, setSelectedTemplate] = useState<ContractTemplate | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [generatedContract, setGeneratedContract] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [savedContracts, setSavedContracts] = useState<ContractData[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  const handleTemplateSelect = (template: ContractTemplate) => {
    setSelectedTemplate(template);
    setFormData({});
    setGeneratedContract('');
    setErrors([]);
  };

  const handleInputChange = (fieldId: string, value: string) => {
    setFormData(prev => ({
      ...prev,
      [fieldId]: value
    }));
    
    // Clear errors when user starts typing
    if (errors.length > 0) {
      setErrors([]);
    }
  };

  const handleGenerateContract = async () => {
    if (!selectedTemplate) return;

    setIsGenerating(true);
    
    try {
      // Validate form data
      const validationErrors = validateContractData(selectedTemplate.id, formData);
      if (validationErrors.length > 0) {
        setErrors(validationErrors);
        setIsGenerating(false);
        return;
      }

      // Generate contract
      const contract = generateContract(selectedTemplate.id, formData);
      setGeneratedContract(contract);
      
      // Save to local storage
      const contractData: ContractData = {
        templateId: selectedTemplate.id,
        data: { ...formData }
      };
      
      const updated = [...savedContracts, contractData];
      setSavedContracts(updated);
      localStorage.setItem('saved-contracts', JSON.stringify(updated));
      
      toast.success('Договір успішно згенеровано!');
    } catch (error) {
      console.error('Error generating contract:', error);
      toast.error('Помилка при генерації договору');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownloadWord = async () => {
    if (!generatedContract || !selectedTemplate) return;

    try {
      await generateWordDocument(generatedContract, `${selectedTemplate.name}.docx`);
      toast.success('Word документ завантажено!');
    } catch (error) {
      console.error('Error downloading Word document:', error);
      toast.error('Помилка при завантаженні документу');
    }
  };

  const handleCopyContract = () => {
    if (generatedContract) {
      navigator.clipboard.writeText(generatedContract);
      toast.success('Договір скопійовано в буфер обміну!');
    }
  };

  const handleGenerateMultiple = () => {
    // Generate multiple contracts with slight variations
    if (!selectedTemplate) return;
    
    const variations = [
      { ...formData, rental_price: (parseInt(formData.rental_price || '0') + 1000).toString() },
      { ...formData, rental_price: (parseInt(formData.rental_price || '0') + 2000).toString() },
      { ...formData, rental_price: (parseInt(formData.rental_price || '0') + 3000).toString() }
    ];

    variations.forEach((variation, index) => {
      const contract = generateContract(selectedTemplate.id, variation);
      const contractData: ContractData = {
        templateId: selectedTemplate.id,
        data: variation
      };
      
      setTimeout(() => {
        generateWordDocument(contract, `${selectedTemplate.name}_варіант_${index + 1}.docx`);
      }, index * 500);
    });

    toast.success('Генерується 3 варіанти договорів...');
  };

  const clearSavedContracts = () => {
    setSavedContracts([]);
    localStorage.removeItem('saved-contracts');
    toast.success('Збережені договори очищено');
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <motion.div 
        className="p-6 border-b border-white/20 bg-gradient-to-r from-slate-900/95 via-slate-800/95 to-slate-900/95 backdrop-blur-xl rounded-t-2xl"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <motion.div
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <Button
                onClick={onBack}
                variant="ghost"
                size="sm"
                className="text-white hover:bg-white/10 border border-white/20"
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                Назад до чату
              </Button>
            </motion.div>
            
            <div>
              <h2 className="text-2xl font-bold text-white flex items-center">
                <FileText className="h-6 w-6 mr-3 text-amber-400" />
                Генератор договорів
                <Sparkles className="h-5 w-5 ml-2 text-amber-400" />
              </h2>
              <p className="text-slate-300 mt-1">Створення професійних правових документів</p>
            </div>
          </div>

          {savedContracts.length > 0 && (
            <motion.div 
              className="flex items-center space-x-3"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <Badge variant="secondary" className="bg-amber-100 text-amber-800">
                {savedContracts.length} збережено
              </Badge>
              <Button
                onClick={clearSavedContracts}
                variant="ghost"
                size="sm"
                className="text-slate-300 hover:text-red-400"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </motion.div>
          )}
        </div>
      </motion.div>

      <div className="flex-1 grid grid-cols-12 gap-6 p-6 bg-gradient-to-br from-slate-50 to-white overflow-hidden">
        {/* Template Selection */}
        <motion.div 
          className="col-span-4 space-y-4"
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.1 }}
        >
          <Card className="shadow-xl border-slate-200 bg-gradient-to-br from-white to-slate-50">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg flex items-center text-slate-800">
                <Zap className="h-5 w-5 mr-2 text-amber-500" />
                Оберіть тип договору
              </CardTitle>
              <CardDescription>
                Професійні шаблони згідно з українським законодавством
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <AnimatePresence>
                {contractTemplates.map((template, index) => (
                  <motion.div
                    key={template.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: index * 0.1 }}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    <Card
                      className={`cursor-pointer transition-all duration-300 border-2 ${
                        selectedTemplate?.id === template.id
                          ? 'border-amber-400 bg-gradient-to-r from-amber-50 to-orange-50 shadow-lg'
                          : 'border-slate-200 hover:border-amber-300 hover:shadow-md bg-white'
                      }`}
                      onClick={() => handleTemplateSelect(template)}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <h4 className={`font-semibold ${
                              selectedTemplate?.id === template.id ? 'text-amber-800' : 'text-slate-800'
                            }`}>
                              {template.name}
                            </h4>
                            <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                              {template.description}
                            </p>
                            <Badge 
                              variant="outline" 
                              className={`mt-2 text-xs ${
                                selectedTemplate?.id === template.id 
                                  ? 'border-amber-400 text-amber-700' 
                                  : 'border-slate-300 text-slate-600'
                              }`}
                            >
                              {template.category}
                            </Badge>
                          </div>
                          {selectedTemplate?.id === template.id && (
                            <motion.div
                              initial={{ scale: 0 }}
                              animate={{ scale: 1 }}
                              transition={{ type: "spring", stiffness: 500, damping: 30 }}
                            >
                              <CheckCircle className="h-5 w-5 text-amber-500" />
                            </motion.div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </motion.div>
                ))}
              </AnimatePresence>
            </CardContent>
          </Card>
        </motion.div>

        {/* Form */}
        <motion.div 
          className="col-span-8 space-y-6"
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.2 }}
        >
          {selectedTemplate ? (
            <Card className="shadow-xl border-slate-200 bg-gradient-to-br from-white to-slate-50">
              <CardHeader className="pb-4">
                <CardTitle className="text-xl flex items-center text-slate-800">
                  <FileText className="h-5 w-5 mr-2 text-blue-500" />
                  {selectedTemplate.name}
                </CardTitle>
                <CardDescription>
                  Заповніть всі необхідні поля для генерації договору
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Error Display */}
                <AnimatePresence>
                  {errors.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="p-4 bg-red-50 border border-red-200 rounded-lg"
                    >
                      <h4 className="font-medium text-red-800 mb-2">Помилки валідації:</h4>
                      <ul className="text-sm text-red-700 space-y-1">
                        {errors.map((error, index) => (
                          <li key={index}>• {error}</li>
                        ))}
                      </ul>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Form Fields */}
                <div className="grid grid-cols-2 gap-6">
                  <AnimatePresence>
                    {selectedTemplate.fields.map((field, index) => (
                      <motion.div
                        key={field.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.05 }}
                        className={field.type === 'text' && field.id.includes('address') ? 'col-span-2' : 'col-span-1'}
                      >
                        <Label htmlFor={field.id} className="text-sm font-medium text-slate-700">
                          {field.label}
                          {field.required && <span className="text-red-500 ml-1">*</span>}
                        </Label>
                        
                        {field.type === 'select' ? (
                          <Select
                            value={formData[field.id] || ''}
                            onValueChange={(value) => handleInputChange(field.id, value)}
                          >
                            <SelectTrigger className="mt-2 border-slate-300 focus:border-blue-400 focus:ring-blue-400/20">
                              <SelectValue placeholder={`Оберіть ${field.label.toLowerCase()}`} />
                            </SelectTrigger>
                            <SelectContent>
                              {field.options?.map((option) => (
                                <SelectItem key={option} value={option}>
                                  {option}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : field.type === 'date' ? (
                          <Input
                            id={field.id}
                            type="date"
                            value={formData[field.id] || ''}
                            onChange={(e) => handleInputChange(field.id, e.target.value)}
                            className="mt-2 border-slate-300 focus:border-blue-400 focus:ring-blue-400/20"
                          />
                        ) : field.id.includes('address') ? (
                          <Textarea
                            id={field.id}
                            value={formData[field.id] || ''}
                            onChange={(e) => handleInputChange(field.id, e.target.value)}
                            placeholder={field.placeholder}
                            className="mt-2 border-slate-300 focus:border-blue-400 focus:ring-blue-400/20 min-h-[80px]"
                          />
                        ) : (
                          <Input
                            id={field.id}
                            type={field.type}
                            value={formData[field.id] || ''}
                            onChange={(e) => handleInputChange(field.id, e.target.value)}
                            placeholder={field.placeholder}
                            className="mt-2 border-slate-300 focus:border-blue-400 focus:ring-blue-400/20"
                            min={field.validation?.min}
                            max={field.validation?.max}
                          />
                        )}
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>

                {/* Action Buttons */}
                <div className="flex flex-wrap gap-3 pt-6 border-t border-slate-200">
                  <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                    <Button
                      onClick={handleGenerateContract}
                      disabled={isGenerating}
                      className="bg-gradient-to-r from-blue-600 via-blue-700 to-blue-800 hover:from-blue-700 hover:via-blue-800 hover:to-blue-900 shadow-lg"
                    >
                      {isGenerating ? (
                        <motion.div
                          animate={{ rotate: 360 }}
                          transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                        >
                          <Sparkles className="h-4 w-4 mr-2" />
                        </motion.div>
                      ) : (
                        <FileText className="h-4 w-4 mr-2" />
                      )}
                      {isGenerating ? 'Генерую...' : 'Згенерувати договір'}
                    </Button>
                  </motion.div>

                  {generatedContract && (
                    <>
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        whileHover={{ scale: 1.02 }} 
                        whileTap={{ scale: 0.98 }}
                      >
                        <Button
                          onClick={handleDownloadWord}
                          variant="outline"
                          className="border-green-300 text-green-700 hover:bg-green-50"
                        >
                          <Download className="h-4 w-4 mr-2" />
                          Завантажити Word
                        </Button>
                      </motion.div>

                      <motion.div 
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        whileHover={{ scale: 1.02 }} 
                        whileTap={{ scale: 0.98 }}
                      >
                        <Button
                          onClick={handleCopyContract}
                          variant="outline"
                          className="border-amber-300 text-amber-700 hover:bg-amber-50"
                        >
                          <Copy className="h-4 w-4 mr-2" />
                          Копіювати
                        </Button>
                      </motion.div>

                      <motion.div 
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        whileHover={{ scale: 1.02 }} 
                        whileTap={{ scale: 0.98 }}
                      >
                        <Button
                          onClick={handleGenerateMultiple}
                          variant="outline"
                          className="border-purple-300 text-purple-700 hover:bg-purple-50"
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          Генерувати варіанти
                        </Button>
                      </motion.div>
                    </>
                  )}
                </div>

                {/* Generated Contract Preview */}
                <AnimatePresence>
                  {generatedContract && (
                    <motion.div
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -20 }}
                      className="mt-8"
                    >
                      <Card className="border-green-200 bg-gradient-to-br from-green-50 to-emerald-50">
                        <CardHeader>
                          <CardTitle className="text-lg text-green-800 flex items-center">
                            <CheckCircle className="h-5 w-5 mr-2" />
                            Згенерований договір
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="bg-white rounded-lg p-6 border border-green-200 max-h-96 overflow-y-auto">
                            <pre className="whitespace-pre-wrap text-sm text-slate-800 leading-relaxed font-mono">
                              {generatedContract}
                            </pre>
                          </div>
                        </CardContent>
                      </Card>
                    </motion.div>
                  )}
                </AnimatePresence>
              </CardContent>
            </Card>
          ) : (
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex items-center justify-center h-96 bg-gradient-to-br from-slate-100 to-slate-200 rounded-2xl border-2 border-dashed border-slate-300"
            >
              <div className="text-center">
                <motion.div
                  animate={{ rotate: [0, 10, -10, 0] }}
                  transition={{ duration: 2, repeat: Infinity }}
                >
                  <FileText className="h-16 w-16 mx-auto mb-4 text-slate-400" />
                </motion.div>
                <h3 className="text-xl font-semibold text-slate-600 mb-2">
                  Оберіть шаблон договору
                </h3>
                <p className="text-slate-500">
                  Виберіть тип договору зліва для початку роботи
                </p>
              </div>
            </motion.div>
          )}
        </motion.div>
      </div>
    </div>
  );
}