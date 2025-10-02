// @ts-ignore - Deno edge function imports
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// @ts-ignore - Deno edge function imports
import OpenAI from "https://esm.sh/openai@4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// Types
interface Document {
  id: string;
  title: string;
  url?: string;
  content?: string;
  law_number?: string;
  document_type?: string;
  source_url?: string;
  articles?: Article[];
  snippet?: string;
  score?: number;
  rank?: number;
}

interface Article {
  number: string;
  title: string;
  content: string;
  section?: number;
}

interface QuestionAnalysis {
  originalMessage: string;
  categories: string[];
  primaryCategory: string;
  keywords: string[];
  complexity: string;
}

interface ScoredDocument extends Document {
  score: number;
}

// Rada API Parser для edge функції
class RadaApiParser {
  private baseUrl = 'https://data.rada.gov.ua';
  private tokenUrl = 'https://data.rada.gov.ua/api/token';
  private userAgent = 'OpenData';
  private token: string | null = null;
  private tokenExpiry: number | null = null;

  async getToken(): Promise<string | null> {
    try {
      if (this.token && this.tokenExpiry && Date.now() < this.tokenExpiry) {
        console.log('🔑 Using cached Rada API token');
        return this.token;
      }

      console.log('🔑 Getting new Rada API token...');
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch(this.tokenUrl, {
        headers: { 'User-Agent': this.userAgent },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`❌ Token request failed: HTTP ${response.status}`);
        return null;
      }

      const tokenData = await response.json();
      this.token = tokenData.token;
      this.tokenExpiry = Date.now() + (tokenData.expire * 1000);
      
      console.log('✅ Rada API token obtained successfully');
      return this.token;

    } catch (error) {
      console.warn('❌ Failed to get Rada API token:', error);
      return null;
    }
  }

  async searchLaws(keywords: string[], limit: number = 3): Promise<Document[]> {
    try {
      console.log('🔍 Searching laws via Rada API', { keywords, limit });

      const token = await this.getToken();
      
      // Розширюємо пошукові терміни для кращого пошуку
      const expandedKeywords = this.expandSearchTerms(keywords);
      console.log('🔍 Expanded search terms:', expandedKeywords);
      
      // Використовуємо найкращі ендпоінти для пошуку (обмежено для швидкості)
      const searchUrls = [
        `${this.baseUrl}/laws/main/a`,      // Всі документи сторінка 1 (найкращий для КУАП)
        `${this.baseUrl}/laws/main/r`       // Оновлені документи
      ];
      
      const allDocuments: Document[] = [];
      
      // Пошук в різних списках документів
      for (const url of searchUrls) {
        try {
          console.log(`📖 Пошук в: ${url}`);
          
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15000);
          
          const response = await fetch(url, {
            headers: {
              'User-Agent': token || this.userAgent,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8'
            },
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);

          if (response.ok) {
            const html = await response.text();
            const documents = this.parseDocumentsFromHtml(html, 50); // Обмежуємо для швидкості
            allDocuments.push(...documents);
            console.log(`✅ Знайдено ${documents.length} документів`);
          }
          
          // Пауза між запитами (зменшено для тестування)
          await new Promise(resolve => setTimeout(resolve, 2000));
          
        } catch (error) {
          console.warn(`Помилка пошуку в ${url}:`, error);
        }
      }
      
      // Видаляємо дублікати
      const uniqueDocuments = allDocuments.filter((doc, index, self) => 
        index === self.findIndex(d => d.id === doc.id)
      );
      
      console.log(`📊 Всього унікальних документів: ${uniqueDocuments.length}`);
      
      // Розширена фільтрація за ключовими словами
      const filtered = this.advancedFilterDocuments(uniqueDocuments, expandedKeywords, limit);
      
      // Завантажуємо повний текст законів
      const lawsWithContent = await this.getLawsContent(filtered, token);
      
      console.log('📊 Rada API search results', { 
        found: lawsWithContent.length, 
        keywords: expandedKeywords 
      });
      
      return lawsWithContent;

    } catch (error) {
      console.warn('Rada API search failed:', error);
      return [];
    }
  }

  // Розширення пошукових термінів
  private expandSearchTerms(keywords: string[]): string[] {
    const expanded = [...keywords];
    
    // Додаємо синоніми та варіанти (включаючи адміністративні)
    const synonyms: { [key: string]: string[] } = {
      'трудовий': ['праця', 'робота', 'працівник', 'роботодавець'],
      'договір': ['угода', 'контракт', 'згода'],
      'права': ['право', 'повноваження', 'можливість'],
      'обов\'язки': ['обов\'язок', 'зобов\'язання', 'відповідальність'],
      'звільнення': ['розірвання', 'припинення', 'завершення'],
      'відпустка': ['відпочинок', 'канікули'],
      'заробітна': ['зарплата', 'оплата', 'виплата'],
      'нерухомість': ['майно', 'будинок', 'квартира', 'земля'],
      'купівля': ['придбання', 'покупка'],
      'продаж': ['реалізація', 'відчуження'],
      // АДМІНІСТРАТИВНІ ТЕРМІНИ
      'штраф': ['адміністративний штраф', 'грошове стягнення', 'адміністративна відповідальність', 'покарання'],
      'порушення': ['правопорушення', 'адміністративне правопорушення', 'порушення правил', 'порушення закону'],
      'дорожні': ['дорожній рух', 'правила дорожнього руху', 'ПДР', 'дорожні правила'],
      'карантин': ['карантинні заходи', 'епідеміологічні заходи', 'санітарні норми'],
      'торговель': ['правила торгівлі', 'торговельна діяльність', 'торговельні правила'],
      'будівництво': ['правила будівництва', 'будівельні норми', 'будівельні правила'],
      'адміністратив': ['адміністративні правопорушення', 'адміністративна відповідальність', 'адміністративне законодавство']
    };

    keywords.forEach(keyword => {
      const lowerKeyword = keyword.toLowerCase();
      if (synonyms[lowerKeyword]) {
        expanded.push(...synonyms[lowerKeyword]);
      }
      
      // Додаємо варіанти для складних термінів
      if (lowerKeyword.includes('адміністратив')) {
        expanded.push('штраф', 'порушення', 'покарання', 'кодекс');
      }
      if (lowerKeyword.includes('дорожні') || lowerKeyword.includes('правила')) {
        expanded.push('ПДР', 'дорожній рух', 'транспорт');
      }
      if (lowerKeyword.includes('штраф') || lowerKeyword.includes('покарання')) {
        expanded.push('адміністративні правопорушення', 'кодекс');
      }
    });

    // Додаємо юридичні терміни
    const legalTerms = ['закон', 'кодекс', 'постанова', 'розпорядження', 'указ', 'стаття', 'пункт'];
    expanded.push(...legalTerms);

    return [...new Set(expanded)]; // Видаляємо дублікати
  }

  // Розширена фільтрація документів
  private advancedFilterDocuments(documents: Document[], keywords: string[], limit: number): Document[] {
    const scoredDocuments = documents.map(doc => {
      let score = 0;
      const title = doc.title.toLowerCase();
      
      // Базовий рахунок за збіг в назві
      keywords.forEach(keyword => {
        const lowerKeyword = keyword.toLowerCase();
        if (title.includes(lowerKeyword)) {
          score += 2; // Високий рахунок за збіг в назві
        }
      });

      // Бонус за точний збіг категорій
      if (title.includes('трудовий') && keywords.some(k => k.toLowerCase().includes('трудовий'))) {
        score += 5;
      }
      if (title.includes('цивільний') && keywords.some(k => k.toLowerCase().includes('цивільний'))) {
        score += 5;
      }
      if (title.includes('кримінальний') && keywords.some(k => k.toLowerCase().includes('кримінальний'))) {
        score += 5;
      }
      
      // АДМІНІСТРАТИВНІ БОНУСИ
      if (title.includes('адміністратив') && keywords.some(k => k.toLowerCase().includes('адміністратив'))) {
        score += 5;
      }
      if (title.includes('штраф') && keywords.some(k => k.toLowerCase().includes('штраф'))) {
        score += 4;
      }
      if (title.includes('порушення') && keywords.some(k => k.toLowerCase().includes('порушення'))) {
        score += 4;
      }
      if (title.includes('дорожні') && keywords.some(k => k.toLowerCase().includes('дорожні'))) {
        score += 4;
      }
      if (title.includes('карантин') && keywords.some(k => k.toLowerCase().includes('карантин'))) {
        score += 4;
      }
      if (title.includes('торговель') && keywords.some(k => k.toLowerCase().includes('торговель'))) {
        score += 4;
      }

      // Бонус за кодекси (вищий для адміністративних)
      if (title.includes('кодекс')) {
        if (title.includes('адміністратив')) {
          score += 5; // Вищий бонус для КУАП
        } else {
          score += 3;
        }
      }

      // Бонус за закони
      if (title.includes('закон')) {
        score += 2;
      }
      
      // Бонус за постанови та розпорядження
      if (title.includes('постанова') || title.includes('розпорядження')) {
        score += 1;
      }

      return { ...doc, score };
    });

    // Сортуємо за рахунком та обмежуємо
    return scoredDocuments
      .filter(doc => doc.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // Новий метод для завантаження повного тексту законів
  async getLawsContent(documents: Document[], token: string | null): Promise<Document[]> {
    const lawsWithContent: Document[] = [];

    for (const doc of documents) {
      try {
        console.log(`📄 Downloading content for: ${doc.title}`);
        
        // ВИКОРИСТОВУЄМО ТІЛЬКИ TXT ФОРМАТ для отримання тексту законів
        let content = '';
        let lawNumber = doc.id;
        let documentType = 'НПА';
        let articles: Article[] = [];

        try {
          console.log(`📄 Завантажуємо TXT для: ${doc.title}`);
          const txtUrl = `${this.baseUrl}/laws/show/${doc.id}.txt`;
          
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000);
          
          const txtResponse = await fetch(txtUrl, {
            headers: {
              'User-Agent': this.userAgent, // Для TXT використовуємо OpenData
              'Accept': 'text/plain'
            },
            signal: controller.signal
          });
          
          clearTimeout(timeoutId);

          if (txtResponse.ok) {
            content = await txtResponse.text();
            lawNumber = this.extractLawNumberFromText(content, doc.id);
            documentType = this.detectDocumentTypeFromText(content);
            articles = this.extractArticlesFromText(content);
            
            console.log(`✅ TXT завантажено: ${doc.title} (${content.length} chars, ${articles.length} articles)`);
          } else {
            console.warn(`TXT не доступний для ${doc.id}: ${txtResponse.status}`);
          }
        } catch (txtError) {
          console.warn('TXT format failed:', txtError);
        }

        if (content && content.length > 100) {
          lawsWithContent.push({
            id: doc.id,
            title: doc.title,
            content: content.substring(0, 10000), // Обмежуємо розмір
            law_number: lawNumber,
            document_type: documentType,
            source_url: doc.url,
            articles: articles,
            snippet: content.substring(0, 300) + '...'
          });
          
          console.log(`✅ Content downloaded: ${doc.title} (${content.length} chars, ${articles.length} articles)`);
        } else {
          console.warn(`⚠️ No content found for: ${doc.title}`);
        }

        // Пауза між запитами (зменшено для тестування)
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        console.warn(`Failed to get content for ${doc.title}:`, error);
      }
    }

    return lawsWithContent;
  }


  // Витягування статей з тексту (покращена версія)
  private extractArticlesFromText(content: string): Article[] {
    const articles: Article[] = [];
    
    // Різні варіанти пошуку статей (покращені паттерни)
    const articlePatterns = [
      /Стаття\s+(\d+)[\s\S]*?(?=Стаття\s+\d+|Розділ|Глава|Частина|$)/gi,
      /ст\.\s*(\d+)[\s\S]*?(?=ст\.\s*\d+|$)/gi,
      /(\d+)\.\s*[А-ЯІЇЄҐ][\s\S]*?(?=\d+\.\s*[А-ЯІЇЄҐ]|$)/gi,
      // Для адміністративних кодексів
      /Стаття\s+(\d+)[\s\S]*?(?=Стаття\s+\d+|Пункт|Підпункт|$)/gi,
      // Для законів з нумерацією
      /(\d+)\.[\s]*[А-ЯІЇЄҐ][\s\S]*?(?=\d+\.[\s]*[А-ЯІЇЄҐ]|$)/gi
    ];
    
    for (const pattern of articlePatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const articleNumber = match[1];
        const articleContent = match[0].trim();
        
        // Перевіряємо чи не дублікат та чи достатньо довгий контент
        const exists = articles.some(art => art.number === articleNumber);
        if (!exists && articleContent.length > 30) {
          articles.push({
            number: articleNumber,
            title: `Стаття ${articleNumber}`,
            content: articleContent,
            section: articles.length + 1
          });
        }
      }
    }
    
    // Сортуємо за номером статті
    articles.sort((a, b) => {
      const numA = parseInt(a.number) || 0;
      const numB = parseInt(b.number) || 0;
      return numA - numB;
    });
    
    return articles;
  }


  // Визначення типу документа з тексту (покращена версія)
  private detectDocumentTypeFromText(content: string): string {
    const text = content.toLowerCase();

    if (text.includes('кодекс україни про адміністративні правопорушення')) {
      return 'Кодекс України про адміністративні правопорушення';
    } else if (text.includes('кодекс україни')) {
      return 'Кодекс України';
    } else if (text.includes('закон україни')) {
      return 'Закон України';
    } else if (text.includes('постанова')) {
      return 'Постанова';
    } else if (text.includes('розпорядження')) {
      return 'Розпорядження';
    } else if (text.includes('указ')) {
      return 'Указ';
    } else if (text.includes('наказ')) {
      return 'Наказ';
    } else if (text.includes('інструкція')) {
      return 'Інструкція';
    } else {
      return 'НПА';
    }
  }

  // Витягування номера закону з тексту (покращена версія)
  private extractLawNumberFromText(content: string, fallbackId: string): string {
    // Різні варіанти пошуку номера закону
    const lawPatterns = [
      /(?:Закон|Постанова|Кодекс|Указ|Наказ|Розпорядження|Інструкція)\s+(?:України\s+)?№?\s*(\d+[-\w]*)/i,
      /№\s*(\d+[-\w]*)/i,
      /(\d{4,}-\d{2,}-\d{2,})/i, // Формат n0388500-25
      /(\d{4}\/\d{2}\/\d{2})/i,  // Формат 2020/12/25
      /(\d{4}\.\d{2}\.\d{2})/i   // Формат 2020.12.25
    ];
    
    for (const pattern of lawPatterns) {
      const match = content.match(pattern);
      if (match) {
        return match[1];
      }
    }
    
    return fallbackId;
  }

  private parseDocumentsFromHtml(html: string, limit: number): Document[] {
    const documents: Document[] = [];
    
    try {
      // Парсимо HTML для пошуку документів згідно з документацією
      // Структура: <li><a href="https://data.rada.gov.ua/laws/meta/ID">НАЗВА</a></li>
      const linkMatches = html.match(/href="https:\/\/data\.rada\.gov\.ua\/laws\/meta\/([^"]+)"/g) || [];
      
      console.log(`🔍 HTML парсинг: знайдено ${linkMatches.length} посилань на документи`);
      
      // Обробляємо кожне посилання
      for (let i = 0; i < Math.min(linkMatches.length, limit); i++) {
        const linkMatch = linkMatches[i];
        
        try {
          // Витягуємо ID документа
          const idMatch = linkMatch.match(/\/laws\/meta\/([^"]+)/);
          if (!idMatch) continue;
          
          const docId = idMatch[1];
          
          // Знаходимо текст посилання (назву документа)
          const linkStart = html.indexOf(linkMatch);
          const linkEnd = html.indexOf('</a>', linkStart);
          const linkContent = html.substring(linkStart, linkEnd);
          
          // Витягуємо назву документа
          const titleMatch = linkContent.match(/>([^<]+)</);
          if (!titleMatch) continue;
          
          const title = titleMatch[1].trim();
          
          if (title && title.length > 10) {
            documents.push({
              id: docId,
              title: title,
              url: `${this.baseUrl}/laws/show/${docId}`
            });
          }
          
        } catch (parseError) {
          console.warn('Помилка парсингу посилання:', parseError);
        }
      }
      
      console.log(`✅ HTML парсинг завершено: ${documents.length} документів`);
      
    } catch (error) {
      console.warn('HTML parsing failed:', error);
    }
    
    return documents;
  }

  private filterDocumentsByKeywords(documents: Document[], searchQuery: string, limit: number): Document[] {
    const keywords = searchQuery.toLowerCase().split(' ');
    
    const filtered = documents.filter(doc => {
      const title = doc.title.toLowerCase();
      return keywords.some(keyword => title.includes(keyword));
    });

    return filtered.slice(0, limit);
  }
}

// Legal Agent для edge функції
class LegalAgent {
  private legalCategories = {
    'цивільне': ['договір', 'власність', 'спадщина', 'шкода', 'відшкодування', 'купівля', 'продаж'],
    'трудове': ['робота', 'заробітна плата', 'відпустка', 'звільнення', 'трудовий договір', 'роботодавець', 'працівник'],
    'сімейне': ['шлюб', 'розлучення', 'діти', 'аліменти', 'сім\'я', 'подружжя'],
    'кримінальне': ['злочин', 'кримінал', 'покарання', 'вбивство', 'крадіжка', 'шахрайство'],
    'господарське': ['бізнес', 'підприємство', 'господарство', 'комерція', 'торгівля', 'ФОП'],
    'адміністративне': [
      'штраф', 'порушення', 'адміністративне', 'поліція', 'протокол',
      'дорожні', 'правила дорожнього руху', 'ПДР', 'транспорт',
      'карантин', 'санітарні норми', 'епідеміологічні заходи',
      'торговель', 'правила торгівлі', 'торговельна діяльність',
      'будівництво', 'будівельні норми', 'будівельні правила',
      'кодекс україни про адміністративні правопорушення', 'куап'
    ]
  };

  analyzeQuestion(message: string): QuestionAnalysis {
    const lowerMessage = message.toLowerCase();
    
    // Визначення категорії права
    const categories: { category: string; score: number }[] = [];
    Object.entries(this.legalCategories).forEach(([category, keywords]) => {
      const matchCount = keywords.filter(keyword => 
        lowerMessage.includes(keyword)
      ).length;
      if (matchCount > 0) {
        categories.push({ category, score: matchCount });
      }
    });

    categories.sort((a, b) => b.score - a.score);

    // Витягування ключових слів
    const stopWords = new Set([
      'що', 'як', 'де', 'коли', 'чому', 'хто', 'який', 'яка', 'яке',
      'але', 'або', 'та', 'і', 'в', 'на', 'з', 'до', 'від', 'про',
      'для', 'за', 'під', 'над', 'між', 'серед', 'без', 'через'
    ]);

    const keywords = message
      .toLowerCase()
      .replace(/[^\u0400-\u04FF\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word))
      .slice(0, 10);

    return {
      originalMessage: message,
      categories: categories.map(c => c.category),
      primaryCategory: categories[0]?.category || 'загальне',
      keywords,
      complexity: this.assessComplexity(message)
    };
  }

  private assessComplexity(message: string): string {
    const indicators = {
      simple: ['що', 'як', 'де', 'коли'],
      medium: ['договір', 'права', 'обов\'язки', 'відповідальність'],
      complex: ['суперечка', 'позов', 'суд', 'розгляд', 'апеляція', 'касація']
    };

    let score = 0;
    Object.entries(indicators).forEach(([level, words]) => {
      const matches = words.filter(word => message.toLowerCase().includes(word)).length;
      if (level === 'simple') score += matches * 1;
      if (level === 'medium') score += matches * 2;
      if (level === 'complex') score += matches * 3;
    });

    if (score <= 2) return 'simple';
    if (score <= 5) return 'medium';
    return 'complex';
  }

  async searchInDatabase(supabase: any, keywords: string[], limit: number): Promise<Document[]> {
    try {
      // Спочатку шукаємо за адміністративними термінами
      const adminKeywords = ['адміністратив', 'правопорушення', 'куап', 'штраф', 'поліція'];
      const hasAdminTerms = keywords.some(k => adminKeywords.some(ak => k.toLowerCase().includes(ak)));
      
      let data = [];
      
      if (hasAdminTerms) {
        // Спеціальний пошук для адміністративних термінів
        const { data: adminData, error: adminError } = await supabase
          .from('legal_laws')
          .select('id, title, content, law_number, source_url, articles, category')
          .ilike('title', '%адміністратив%')
          .limit(10);
        
        if (!adminError && adminData) {
          data = adminData;
          console.log(`Found ${data.length} administrative laws`);
        }
      }
      
      // Якщо не знайшли адміністративні або не було адміністративних термінів
      if (data.length === 0) {
        const { data: allLaws, error: allError } = await supabase
          .from('legal_laws')
          .select('id, title, content, law_number, source_url, articles, category')
          .limit(50);
        
        if (allError) {
          console.warn('All laws search error:', allError);
          return [];
        }
        data = allLaws;
      }

      // Filter results using text search
      const filteredResults = data.filter((row: any) => {
        const text = `${row.title} ${row.content}`.toLowerCase();
        return keywords.some(keyword => text.includes(keyword.toLowerCase()));
      });

      return filteredResults
        .map((row: any) => ({
          ...row,
          rank: this.calculateRelevanceScore(row, keywords)
        }))
        .sort((a: any, b: any) => b.rank - a.rank)
        .slice(0, limit) as Document[];

    } catch (error) {
      console.warn('Database search failed:', error);
      return [];
    }
  }

  private calculateRelevanceScore(row: Document, keywords: string[]): number {
    let score = 0;
    const title = row.title ? row.title.toLowerCase() : '';
    const content = row.content ? row.content.toLowerCase() : '';
    
    // Базовий рахунок за збіг в назві
    keywords.forEach(keyword => {
      const lowerKeyword = keyword.toLowerCase();
      if (title.includes(lowerKeyword)) {
        score += 3.0; // Збільшуємо рахунок за збіг в назві
      }
      if (content.includes(lowerKeyword)) {
        score += 1.0; // Збільшуємо рахунок за збіг в контенті
      }
    });

    // Бонус за адміністративні терміни
    if (title.includes('адміністратив') && keywords.some(k => k.toLowerCase().includes('адміністратив'))) {
      score += 10; // Високий бонус для КУАП
    }
    if (title.includes('кодекс') && title.includes('адміністратив')) {
      score += 15; // Максимальний бонус для КУАП
    }
    if (title.includes('правопорушення') && keywords.some(k => k.toLowerCase().includes('правопорушення'))) {
      score += 8;
    }
    if (title.includes('штраф') && keywords.some(k => k.toLowerCase().includes('штраф'))) {
      score += 5;
    }
    
    // Бонус за кількість статей (КУАП має 786 статей)
    if (row.articles && Array.isArray(row.articles)) {
      score += Math.min(row.articles.length * 0.1, 5); // До 5 бонусних балів
    }
    
    return score;
  }

  buildEnhancedContext(questionAnalysis: QuestionAnalysis, relevantContext: { laws: Document[] }, conversationHistory: any[]): string {
    let context = `Український юрист-асистент.

ПРАВИЛА:
1. Відповідай українською
2. Використовуй ТІЛЬКИ наданий контекст
3. Цитуй статті: "ст. X Назва закону"
4. Якщо немає інформації - скажи про це
5. Не вигадуй закони

ФОРМАТ: резюме → пояснення → рекомендації

`;

    // Додавання релевантних законів з статтями
    if (relevantContext.laws && relevantContext.laws.length > 0) {
      context += 'ЗАКОНИ:\n';
      
      relevantContext.laws.slice(0, 2).forEach((law: Document, index: number) => {
        context += `${index + 1}. ${law.title}\n`;
        if (law.law_number) context += `   №: ${law.law_number}\n`;
        if (law.document_type) context += `   Тип: ${law.document_type}\n`;
        
        // Додаємо статті якщо є
        if (law.articles && law.articles.length > 0) {
          context += `   СТАТТІ:\n`;
          law.articles.slice(0, 3).forEach((article: Article) => {
            context += `   - ${article.title}: ${article.content.substring(0, 200)}...\n`;
          });
        } else {
          // Якщо статей немає, додаємо загальний контент
          if (law.content) {
            const shortContent = law.content.substring(0, 300);
            context += `   ${shortContent}${law.content.length > 300 ? '...' : ''}\n`;
          }
        }
        context += '\n';
      });
    }

    // Контекст розмови
    if (conversationHistory.length > 0) {
      const lastMessage = conversationHistory[conversationHistory.length - 1];
      context += `ПОПЕРЕДНЄ: ${lastMessage.role}: ${lastMessage.content}\n\n`;
    }

    context += `PИТАННЯ: ${questionAnalysis.originalMessage}\n\n`;
    context += `ВІДПОВІДЬ:`;

    return context;
  }

  // Новий метод для пошуку конкретних статей
  async searchSpecificArticle(lawId: string, articleNumber: string, supabase: any): Promise<{ law: Document; article: Article } | null> {
    try {
      // Спочатку шукаємо в базі даних
      const { data: laws, error } = await supabase
        .from('legal_laws')
        .select('*')
        .eq('id', lawId)
        .single();

      if (error || !laws) {
        return null;
      }

      // Шукаємо статтю в articles полі
      if (laws.articles && Array.isArray(laws.articles)) {
        const article = laws.articles.find((art: Article) => art.number === articleNumber);
        if (article) {
          return {
            law: laws,
            article: article
          };
        }
      }

      // Якщо не знайшли, парсимо з контенту
      if (laws.content) {
        const articleRegex = new RegExp(`Стаття\\s+${articleNumber}[\\s\\S]*?(?=Стаття\\s+\\d+|$)`, 'gi');
        const match = laws.content.match(articleRegex);
        
        if (match) {
          return {
            law: laws,
            article: {
              number: articleNumber,
              title: `Стаття ${articleNumber}`,
              content: match[0].trim()
            }
          };
        }
      }

      return null;
    } catch (error) {
      console.warn('Error searching specific article:', error);
      return null;
    }
  }

  // Перевірка чи є статті в законах
  hasArticles(laws: Document[]): boolean {
    return laws.some(law => law.articles && Array.isArray(law.articles) && law.articles.length > 0);
  }
}

Deno.serve(async (req) => {
  // Generate unique request ID for logging
  const requestId = crypto.randomUUID();
  
  const headersObj: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headersObj[key] = value;
  });
  
  console.log(`[${requestId}] Request received:`, {
    method: req.method,
    url: req.url,
    headers: headersObj
  });

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || 'https://lhltmmzwvikdgxxakbcl.supabase.co';
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY');
    console.log(`[${requestId}] Supabase URL: ${supabaseUrl}`);
    console.log(`[${requestId}] Supabase key: ${supabaseKey ? '***' + supabaseKey.slice(-4) : 'NOT SET'}`);
    
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase environment variables not set');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Initialize OpenAI client
    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
    
    if (!openaiApiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    const openai = new OpenAI({
      apiKey: openaiApiKey
    });

    // Initialize services
    const radaParser = new RadaApiParser();
    const legalAgent = new LegalAgent();

    let body;
    try {
      body = await req.json();
    } catch (error) {
      console.error(`[${requestId}] Invalid JSON:`, error);
      return new Response(
        JSON.stringify({ error: 'Невірний формат JSON' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { messages, sessionId, userMessage } = body;

    if (!sessionId) {
      return new Response(
        JSON.stringify({ error: 'Session ID обов\'язковий' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[${requestId}] Processing chat request:`, {
      sessionId: sessionId.substring(0, 8),
      messageCount: messages?.length || 0,
      hasUserMessage: !!userMessage
    });

    // Verify session exists
    const { data: session, error: sessionError } = await supabase
      .from('chat_sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('is_active', true)
      .single();

    if (sessionError || !session) {
      console.error(`[${requestId}] Session not found:`, sessionError);
      return new Response(
        JSON.stringify({ error: 'Сесію не знайдено' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Save user message if provided
    if (userMessage) {
      const { error: userMsgError } = await supabase
        .from('chat_messages')
        .insert({
          session_id: sessionId,
          role: 'user',
          content: userMessage,
          tokens_used: 0
        });

      if (userMsgError) {
        console.error(`[${requestId}] Error saving user message:`, userMsgError);
        return new Response(
          JSON.stringify({ error: 'Помилка збереження повідомлення' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Аналіз питання та пошук релевантної інформації
    let enhancedContext = '';
    let sources: { title: string; url?: string; lawNumber?: string; articles: Article[] }[] = [];
    
    if (userMessage) {
      console.log(`[${requestId}] Analyzing question and searching for relevant laws...`);
      
      const questionAnalysis = legalAgent.analyzeQuestion(userMessage);
      console.log(`[${requestId}] Question analysis:`, {
        categories: questionAnalysis.categories,
        primaryCategory: questionAnalysis.primaryCategory,
        keywords: questionAnalysis.keywords,
        complexity: questionAnalysis.complexity
      });

      // Пошук в базі даних
      const dbResults = await legalAgent.searchInDatabase(supabase, questionAnalysis.keywords, 2);
      console.log(`[${requestId}] Database search results:`, { found: dbResults.length });

      // ЗАВЖДИ шукаємо через Rada API для нових законів
      console.log(`[${requestId}] Searching via Rada API for fresh laws...`);
      const apiResults = await radaParser.searchLaws(questionAnalysis.keywords, 3);
      console.log(`[${requestId}] Rada API results:`, { found: apiResults.length });

      // Зберігаємо нові закони в базу даних
      if (apiResults.length > 0) {
        console.log(`[${requestId}] Saving new laws to database...`);
        try {
          for (const law of apiResults) {
            // Перевіряємо чи закон вже існує
            const { data: existingLaw } = await supabase
              .from('legal_laws')
              .select('id, content, articles')
              .eq('id', law.id)
              .single();

            // Якщо закон існує але не має повного контенту або статей, оновлюємо
            if (existingLaw && (!existingLaw.content || existingLaw.content.length < 500 || !existingLaw.articles || existingLaw.articles.length === 0)) {
              console.log(`[${requestId}] Updating existing law with full content: ${law.title}`);
              await supabase
                .from('legal_laws')
                .update({
                  content: law.content,
                  articles: law.articles || [],
                  updated_at: new Date().toISOString()
                })
                .eq('id', law.id);
            } else if (!existingLaw) {
              // Якщо закон не існує, створюємо новий
              console.log(`[${requestId}] Creating new law: ${law.title}`);
              await supabase
                .from('legal_laws')
                .insert({
                  id: law.id,
                  title: law.title,
                  content: law.content,
                  law_number: law.law_number,
                  category: law.document_type,
                  source_url: law.source_url,
                  articles: law.articles || [],
                  keywords: questionAnalysis.keywords,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString()
                });
            }
          }
          console.log(`[${requestId}] Processed ${apiResults.length} laws in database`);
        } catch (saveError) {
          console.warn(`[${requestId}] Failed to save laws to database:`, saveError);
        }
      }

      // Об'єднуємо результати (пріоритет новим законам)
      const allResults = [...apiResults, ...dbResults];
      sources = allResults.map(r => ({
        title: r.title,
        url: r.source_url || r.url,
        lawNumber: r.law_number,
        articles: r.articles || []
      }));

      // Будуємо покращений контекст
      enhancedContext = legalAgent.buildEnhancedContext(
        questionAnalysis, 
        { laws: allResults }, 
        messages || []
      );

      console.log(`[${requestId}] Enhanced context built:`, {
        contextLength: enhancedContext.length,
        sourcesCount: sources.length
      });
    }

    // Prepare messages for OpenAI
    const recentMessages = messages ? messages.slice(-3) : [];
    const openaiMessages = [
      { role: 'system', content: enhancedContext || 'Український юрист-асистент. Відповідай українською мовою.' },
      ...recentMessages
    ];

    console.log(`[${requestId}] Calling OpenAI API with ${openaiMessages.length} messages`);

    // Generate AI response
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: openaiMessages,
      max_tokens: 500,
      temperature: 0.1,
      presence_penalty: 0.0,
      frequency_penalty: 0.0
    });

    const aiResponse = completion.choices[0].message.content;
    const tokensUsed = completion.usage?.total_tokens || 0;

    console.log(`[${requestId}] OpenAI response generated:`, {
      model: 'gpt-3.5-turbo',
      responseLength: aiResponse?.length || 0,
      tokensUsed,
      sourcesCount: sources.length
    });

    if (!aiResponse) {
      throw new Error('Порожня відповідь від OpenAI');
    }

    // Save AI response
    const { error: aiMsgError } = await supabase
      .from('chat_messages')
      .insert({
        session_id: sessionId,
        role: 'assistant',
        content: aiResponse,
        tokens_used: tokensUsed
      });

    if (aiMsgError) {
      console.error(`[${requestId}] Error saving AI message:`, aiMsgError);
      return new Response(
        JSON.stringify({ error: 'Помилка збереження відповіді' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Update session title if it's the first user message
    if (userMessage && messages && messages.filter((m: any) => m.role === 'user').length === 1) {
      const title = userMessage.length > 50 ? userMessage.substring(0, 47) + '...' : userMessage;
      await supabase
        .from('chat_sessions')
        .update({ title })
        .eq('id', sessionId);
    }

    console.log(`[${requestId}] Request completed successfully`);

    return new Response(
      JSON.stringify({
        response: aiResponse,
        tokensUsed,
        sessionId,
        sources: sources
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    const err = error as Error & { status?: number };
    console.error(`[${requestId}] Error in chat function:`, {
      message: err.message,
      stack: err.stack,
      name: err.name
    });

    // Handle specific OpenAI errors
    let errorMessage = 'Внутрішня помилка сервера';
    let statusCode = 500;

    if (err.status === 429) {
      errorMessage = 'Занадто багато запитів. Спробуйте пізніше.';
      statusCode = 429;
    } else if (err.status === 401) {
      errorMessage = 'Помилка автентифікації API.';
      statusCode = 401;
    } else if (err.status && err.status >= 500) {
      errorMessage = 'Сервіс тимчасово недоступний. Спробуйте пізніше.';
      statusCode = 503;
    } else if (err.message.includes('OpenAI')) {
      errorMessage = 'Помилка AI сервісу. Спробуйте пізніше.';
    }

    return new Response(
      JSON.stringify({ 
        error: errorMessage,
        requestId 
      }),
      { 
        status: statusCode, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});