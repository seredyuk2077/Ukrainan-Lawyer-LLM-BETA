const axios = require('axios');
const { query } = require('../config/supabase');
const logger = require('../utils/logger');

class RadaOfficialApiParser {
  constructor() {
    this.baseUrl = 'https://data.rada.gov.ua';
    this.apiUrl = 'https://data.rada.gov.ua/laws';
    this.tokenUrl = 'https://data.rada.gov.ua/api/token';
    this.userAgent = 'OpenData'; // Використовуємо OpenData для TXT форматів
    this.token = null;
    this.tokenExpiry = null;
    this.requestCount = 0;
    this.lastRequestTime = 0;
  }

  /**
   * Отримуємо токен для JSON запитів
   */
  async getToken() {
    try {
      if (this.token && this.tokenExpiry && Date.now() < this.tokenExpiry) {
        return this.token;
      }

      logger.info('🔑 Getting API token...');
      
      const response = await axios.get(this.tokenUrl, {
        headers: {
          'User-Agent': this.userAgent
        },
        timeout: 10000
      });

      // Парсимо JSON відповідь
      const tokenData = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      this.token = tokenData.token;
      this.tokenExpiry = Date.now() + (tokenData.expire * 1000); // Використовуємо expire з відповіді
      
      logger.info('✅ API token obtained', { 
        token: this.token.substring(0, 8) + '...',
        expiresIn: tokenData.expire + ' seconds'
      });
      return this.token;

    } catch (error) {
      logger.warn('Failed to get API token, using OpenData mode:', error.message);
      return null;
    }
  }

  /**
   * Дотримуємося лімітів API згідно з документацією (60 запитів/хвилину, пауза 5-7 секунд)
   */
  async respectRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    // Рандомна пауза від 5 до 7 секунд згідно з документацією
    const minPause = 5000; // 5 секунд
    const maxPause = 7000; // 7 секунд
    const randomPause = Math.floor(Math.random() * (maxPause - minPause + 1)) + minPause;
    
    if (timeSinceLastRequest < randomPause) {
      const remainingPause = randomPause - timeSinceLastRequest;
      logger.info('⏳ Respecting rate limit', { 
        pauseMs: remainingPause,
        requestCount: this.requestCount 
      });
      await new Promise(resolve => setTimeout(resolve, remainingPause));
    }
    
    this.lastRequestTime = Date.now();
    this.requestCount++;
  }

  /**
   * Пошук законів через офіційний API
   */
  async searchLaws(keywords, limit = 5) {
    try {
      logger.info('🔍 Searching laws via official Rada API', { keywords, limit });

      // Отримуємо токен
      const token = await this.getToken();
      
      // Формуємо пошуковий запит
      const searchQuery = this.buildSearchQuery(keywords);
      
      // Отримуємо список документів
      const documents = await this.getDocumentsList(searchQuery, limit, token);
      
      if (documents.length === 0) {
        logger.warn('No documents found via official API');
        return [];
      }

      // Отримуємо детальну інформацію про документи
      const laws = await this.getDocumentsDetails(documents, token);
      
      logger.info('✅ Laws found and parsed via official API', { 
        found: laws.length, 
        searched: documents.length 
      });

      return laws;

    } catch (error) {
      logger.error('Error searching laws via official API:', error);
      return [];
    }
  }

  /**
   * Формуємо пошуковий запит
   */
  buildSearchQuery(keywords) {
    const keywordString = Array.isArray(keywords) ? keywords.join(' ') : keywords;
    
    // Додаємо юридичні терміни для кращого пошуку
    const legalTerms = ['закон', 'кодекс', 'постанова', 'розпорядження', 'указ'];
    const allTerms = [...keywords, ...legalTerms];
    
    return allTerms.join(' ');
  }

  /**
   * Отримуємо список документів згідно з документацією API
   */
  async getDocumentsList(searchQuery, limit, token) {
    try {
      await this.respectRateLimit();

      // Використовуємо список нових документів (30 днів) згідно з документацією
      const documentsUrl = `${this.baseUrl}/laws/main/n`;
      
      logger.info('🔍 Getting documents list from API', { 
        url: documentsUrl,
        searchQuery,
        token: token ? 'present' : 'none'
      });

      const response = await axios.get(documentsUrl, {
        headers: {
          'User-Agent': token || this.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8'
        },
        timeout: 15000
      });

      logger.info('📄 Documents list response received', { 
        status: response.status,
        contentType: response.headers['content-type'],
        dataLength: response.data.length,
        lastModified: response.headers['last-modified']
      });

      // Парсимо HTML для отримання посилань на документи
      const documents = await this.parseDocumentsFromHtml(response.data, 200); // Беремо більше для фільтрації
      
      logger.info('📋 Documents parsed from HTML', { 
        found: documents.length,
        searchQuery 
      });
      
      // Фільтруємо за ключовими словами
      const filtered = this.filterDocumentsByKeywords(documents, searchQuery, limit);
      
      logger.info('✅ Filtered documents', { 
        original: documents.length,
        filtered: filtered.length 
      });
      
      return filtered;

    } catch (error) {
      logger.warn('Failed to get documents list:', error.message);
      return [];
    }
  }

  /**
   * Парсимо документи з HTML згідно з документацією API
   */
  async parseDocumentsFromHtml(html, limit) {
    try {
      const cheerio = await import('cheerio');
      const $ = cheerio.load(html);
      const documents = [];

      logger.info('🔍 Parsing HTML for law documents', { 
        htmlLength: html.length,
        limit 
      });

      // Шукаємо посилання на закони згідно з документацією API
      const selectors = [
        'a[href*="/laws/show/"]',  // Основні посилання на документи
        'a[href*="/laws/card/"]',  // Картки документів
        'a[href*="/go/"]',  // Скорочені посилання
        'a[href*="/laws/meta/"]',  // Мета-посилання
        'tr a[href*="/laws/"]',  // Посилання в таблицях
        'li a[href*="/laws/"]',  // Посилання в списках
        'td a[href*="/laws/"]',  // Посилання в комірках таблиць
        'a[href*="nreg"]'  // Посилання з nreg
      ];

      selectors.forEach(selector => {
        const elements = $(selector);
        logger.info(`🔍 Checking selector: ${selector}`, { found: elements.length });
        
        elements.each((index, element) => {
          if (documents.length >= 100) return false; // Збільшуємо ліміт

          const $element = $(element);
          const href = $element.attr('href');
          const title = $element.text().trim();

          if (href && title && title.length > 10) {
            logger.info(`📄 Found link: ${href} - ${title.substring(0, 50)}...`);
            
            // Витягуємо ID документа з різних форматів URL згідно з документацією
            let id = null;
            let fullUrl = href.startsWith('http') ? href : `${this.baseUrl}${href}`;
            
            if (href.includes('/laws/show/')) {
              // Формат /laws/show/n0388500-25 -> n0388500-25
              id = href.match(/\/laws\/show\/([^\/\?]+)/)?.[1];
            } else if (href.includes('/laws/card/')) {
              // Формат /laws/card/n0388500-25 -> n0388500-25
              id = href.match(/\/laws\/card\/([^\/\?]+)/)?.[1];
              // Конвертуємо в формат для laws/show
              if (id) {
                fullUrl = `${this.baseUrl}/laws/show/${id}`;
                logger.info(`✅ Converted /laws/card/ to laws/show: ${id}`);
              }
            } else if (href.includes('/go/')) {
              // Формат /go/n0388500-25 -> n0388500-25
              id = href.match(/\/go\/([^\/\?]+)/)?.[1];
              // Конвертуємо в формат для laws/show
              if (id) {
                fullUrl = `${this.baseUrl}/laws/show/${id}`;
                logger.info(`✅ Converted /go/ to laws/show: ${id}`);
              }
            } else if (href.includes('/laws/meta/')) {
              // Формат /laws/meta/n0388500-25 -> n0388500-25
              id = href.match(/\/laws\/meta\/([^\/\?]+)/)?.[1];
              // Конвертуємо в формат для laws/show
              if (id) {
                fullUrl = `${this.baseUrl}/laws/show/${id}`;
                logger.info(`✅ Converted /laws/meta/ to laws/show: ${id}`);
              }
            } else if (href.includes('nreg')) {
              // Шукаємо nreg в URL
              const nregMatch = href.match(/([0-9nprvz][0-9\/\_\-a-zа-яїіёєґ]{3,11})/);
              if (nregMatch) {
                id = nregMatch[1];
                fullUrl = `${this.baseUrl}/laws/show/${id}`;
                logger.info(`✅ Found nreg in URL: ${id}`);
              }
            }

            if (id) {
              // Перевіряємо, чи це не дублікат
              const exists = documents.some(doc => doc.id === id);
              if (!exists) {
                documents.push({
                  id: id,
                  title: title,
                  url: fullUrl
                });
                logger.info(`✅ Added document: ${id} - ${title.substring(0, 30)}...`);
              } else {
                logger.info(`⚠️ Duplicate document skipped: ${id}`);
              }
            } else {
              logger.info(`❌ No ID extracted from: ${href}`);
            }
          } else {
            if (href) {
              logger.info(`⚠️ Link too short or no title: ${href} - "${title}"`);
            }
          }
        });
      });

      logger.info('📋 Documents found in HTML', { 
        total: documents.length,
        unique: [...new Set(documents.map(d => d.id))].length
      });

      return documents;

    } catch (error) {
      logger.warn('Failed to parse documents from HTML:', error.message);
      return [];
    }
  }

  /**
   * Фільтруємо документи за ключовими словами
   */
  filterDocumentsByKeywords(documents, searchQuery, limit) {
    const keywords = searchQuery.toLowerCase().split(' ');
    
    logger.info('🔍 Filtering documents by keywords', { 
      totalDocuments: documents.length,
      keywords: keywords,
      limit 
    });
    
    const filtered = documents.filter(doc => {
      const title = doc.title.toLowerCase();
      const hasMatch = keywords.some(keyword => title.includes(keyword));
      
      if (hasMatch) {
        logger.info(`✅ Document matches keywords: ${doc.title.substring(0, 50)}...`);
      }
      
      return hasMatch;
    });

    logger.info('📊 Filtering results', { 
      original: documents.length,
      filtered: filtered.length,
      keywords 
    });

    return filtered.slice(0, limit);
  }

  /**
   * Отримуємо детальну інформацію про документи
   */
  async getDocumentsDetails(documents, token) {
    const laws = [];

    for (const doc of documents) {
      try {
        await this.respectRateLimit();
        
        const law = await this.getDocumentDetails(doc, token);
        if (law) {
          laws.push(law);
        }
      } catch (error) {
        logger.warn('Failed to get document details:', { 
          id: doc.id, 
          error: error.message 
        });
      }
    }

    return laws;
  }

  /**
   * Отримуємо деталі окремого документа згідно з документацією API
   */
  async getDocumentDetails(doc, token) {
    try {
      await this.respectRateLimit();

      logger.info('📄 Getting document details', { 
        id: doc.id,
        url: doc.url,
        token: token ? 'present' : 'none'
      });

      // Спробуємо отримати JSON версію документа згідно з документацією
      let response;
      let contentType = 'unknown';
      
      if (token) {
        try {
          // Використовуємо TXT формат як основний (містить повний контент)
          const txtUrl = `${this.baseUrl}/laws/show/${doc.id}.txt`;
          response = await axios.get(txtUrl, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'User-Agent': this.userAgent,
              'Accept': 'text/plain'
            },
            timeout: 15000
          });
          contentType = 'txt';
          logger.info('✅ TXT format successful', { id: doc.id });
        } catch (txtError) {
          logger.warn('TXT format failed, trying JSON', { 
            id: doc.id,
            error: txtError.message,
            status: txtError.response?.status 
          });
          // Якщо TXT не працює, використовуємо JSON для метаданих
          const jsonUrl = `${this.baseUrl}/laws/show/${doc.id}.json`;
          response = await axios.get(jsonUrl, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'User-Agent': this.userAgent,
              'Accept': 'application/json'
            },
            timeout: 15000
          });
          contentType = 'json';
          logger.info('✅ JSON format successful (fallback)', { id: doc.id });
        }
      } else {
        // Використовуємо TXT формат
        const txtUrl = `${this.baseUrl}/laws/show/${doc.id}.txt`;
        response = await axios.get(txtUrl, {
          headers: {
            'User-Agent': this.userAgent,
            'Accept': 'text/plain'
          },
          timeout: 15000
        });
        contentType = 'txt';
        logger.info('✅ TXT format successful (no token)', { id: doc.id });
      }

      logger.info('📄 Document details received', { 
        id: doc.id,
        contentType,
        status: response.status,
        dataLength: response.data?.length || 0
      });

      // Обробляємо відповідь
      let content, lawNumber, documentType, date;

      if (contentType === 'json') {
        // JSON формат - витягуємо метадані
        const data = response.data;
        
        // JSON містить лише метадані, контент порожній
        content = data.nazva || ''; // Використовуємо назву як контент
        
        // Витягуємо реквізити документа з нової структури
        lawNumber = data.nreg || doc.id;
        documentType = this.detectDocumentTypeFromJson(data);
        
        // Конвертуємо дату з формату 20250925 в ISO
        if (data.datred) {
          const dateStr = data.datred.toString();
          if (dateStr.length === 8) {
            const year = dateStr.substring(0, 4);
            const month = dateStr.substring(4, 6);
            const day = dateStr.substring(6, 8);
            date = `${year}-${month}-${day}`;
          } else {
            date = new Date().toISOString().split('T')[0];
          }
        } else {
          date = new Date().toISOString().split('T')[0];
        }
        
        logger.info('📄 JSON content extracted', { 
          id: doc.id,
          contentLength: content.length,
          lawNumber,
          documentType
        });
      } else {
        // TXT формат
        content = response.data;
        lawNumber = this.extractLawNumberFromText(content, doc.id);
        documentType = this.detectDocumentTypeFromText(content);
        date = this.extractDateFromText(content);
        
        logger.info('📄 TXT content extracted', { 
          id: doc.id,
          contentLength: content.length,
          lawNumber,
          documentType
        });
      }

      if (!content || content.length < 100) {
        logger.warn('Document content too short or empty', { 
          id: doc.id,
          contentLength: content?.length || 0
        });
        return null;
      }

      const result = {
        title: doc.title,
        content: content, // Повний контент без обмежень
        law_number: lawNumber,
        document_type: documentType,
        source_url: doc.url || `https://data.rada.gov.ua/laws/show/${doc.id}`,
        keywords: this.extractKeywords(doc.title, content),
        category: this.determineCategory(doc.title, lawNumber),
        date_created: date,
        snippet: content.substring(0, 200) + '...'
      };

      logger.info('✅ Document details processed', { 
        id: doc.id,
        title: doc.title,
        contentLength: result.content.length,
        documentType: result.document_type
      });

      return result;

    } catch (error) {
      logger.warn('Failed to parse document:', { 
        id: doc.id,
        url: doc.url, 
        error: error.message 
      });
      return null;
    }
  }

  /**
   * Визначаємо тип документа з JSON
   */
  detectDocumentTypeFromJson(data) {
    const title = (data.nazva || '').toLowerCase();
    const nreg = (data.nreg || '').toLowerCase();

    if (title.includes('закон') || nreg.includes('закон')) {
      return 'Закон України';
    } else if (title.includes('постанова') || nreg.includes('постанова') || nreg.includes('-п')) {
      return 'Постанова';
    } else if (title.includes('кодекс') || nreg.includes('кодекс')) {
      return 'Кодекс';
    } else if (title.includes('указ') || nreg.includes('указ')) {
      return 'Указ';
    } else if (title.includes('розпорядження') || nreg.includes('розпорядження') || nreg.includes('-р')) {
      return 'Розпорядження';
    } else {
      return 'НПА';
    }
  }

  /**
   * Визначаємо категорію документа
   */
  determineCategory(title, lawNumber) {
    const titleLower = title.toLowerCase();
    
    if (titleLower.includes('цивільний') || titleLower.includes('цивільно')) {
      return 'Цивільне право';
    } else if (titleLower.includes('трудовий') || titleLower.includes('трудове')) {
      return 'Трудове право';
    } else if (titleLower.includes('кримінальний') || titleLower.includes('кримінальне')) {
      return 'Кримінальне право';
    } else if (titleLower.includes('податковий') || titleLower.includes('податкове')) {
      return 'Податкове право';
    } else if (titleLower.includes('земельний') || titleLower.includes('земельне')) {
      return 'Земельне право';
    } else if (titleLower.includes('сімейний') || titleLower.includes('сімейне')) {
      return 'Сімейне право';
    } else if (titleLower.includes('господарський') || titleLower.includes('господарське')) {
      return 'Господарське право';
    } else if (titleLower.includes('адміністративний') || titleLower.includes('адміністративне')) {
      return 'Адміністративне право';
    } else if (titleLower.includes('процесуальний') || titleLower.includes('процесуальне')) {
      return 'Процесуальне право';
    }
    
    return 'Інше';
  }

  /**
   * Визначаємо тип документа з тексту
   */
  detectDocumentTypeFromText(content) {
    const text = content.toLowerCase();

    if (text.includes('закон україни')) {
      return 'Закон України';
    } else if (text.includes('постанова') || text.includes('розпорядження')) {
      return 'Постанова';
    } else if (text.includes('кодекс')) {
      return 'Кодекс';
    } else if (text.includes('указ')) {
      return 'Указ';
    } else {
      return 'НПА';
    }
  }

  /**
   * Витягуємо номер закону з тексту
   */
  extractLawNumberFromText(content, fallbackId) {
    const lawMatch = content.match(/(?:Закон|Постанова|Кодекс)\s+(?:України\s+)?№?\s*(\d+[-\w]*)/i);
    if (lawMatch) {
      return lawMatch[1];
    }
    return fallbackId;
  }

  /**
   * Витягуємо дату з тексту
   */
  extractDateFromText(content) {
    const dateMatch = content.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
    if (dateMatch) {
      const dateStr = dateMatch[1];
      // Конвертуємо з dd.mm.yyyy в yyyy-mm-dd
      const parts = dateStr.split('.');
      if (parts.length === 3) {
        const day = parts[0].padStart(2, '0');
        const month = parts[1].padStart(2, '0');
        const year = parts[2];
        return `${year}-${month}-${day}`;
      }
    }
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Витягуємо ключові слова
   */
  extractKeywords(title, content) {
    const text = `${title} ${content}`.toLowerCase();
    const keywords = [];

    const legalTerms = [
      'договір', 'право', 'обов\'язок', 'відповідальність', 'порушення',
      'штраф', 'покарання', 'суд', 'прокуратура', 'поліція',
      'працівник', 'роботодавець', 'заробітна плата', 'відпустка',
      'нерухомість', 'купівля', 'продаж', 'оренда', 'спадок',
      'шлюб', 'розлучення', 'аліменти', 'опіка', 'піклування'
    ];

    legalTerms.forEach(term => {
      if (text.includes(term)) {
        keywords.push(term);
      }
    });

    return keywords.slice(0, 10);
  }

  /**
   * Зберігаємо закони в базу даних
   */
  async saveLawsToDatabase(laws) {
    if (laws.length === 0) return;

    try {
      for (const law of laws) {
        await query('legal_laws', 'upsert', {
          data: {
            title: law.title,
            content: law.content,
            source_url: law.source_url,
            law_number: law.law_number,
            keywords: law.keywords || [],
            articles: law.articles || [],
            category: law.category || 'Інше',
            date_created: law.date_created || new Date().toISOString().split('T')[0]
          },
          onConflict: 'source_url'
        });
      }

      logger.info('✅ Laws saved to database via official API', { count: laws.length });
    } catch (error) {
      logger.error('Failed to save laws to database:', error);
    }
  }

  /**
   * Оновлюємо базу знань
   */
  async updateDatabase() {
    try {
      logger.info('🔄 Updating legal knowledge base via official Rada API...');

      const searchQueries = [
        ['цивільне право', 'договір', 'зобов\'язання'],
        ['трудове право', 'працівник', 'роботодавець'],
        ['сімейне право', 'шлюб', 'розлучення', 'аліменти'],
        ['кримінальне право', 'злочин', 'покарання'],
        ['адміністративне право', 'порушення', 'штраф'],
        ['конституційне право', 'права людини', 'громадянин'],
        ['податкове право', 'податок', 'збір'],
        ['земельне право', 'земля', 'нерухомість']
      ];

      let totalLaws = 0;

      for (const query of searchQueries) {
        try {
          const laws = await this.searchLaws(query, 2);
          if (laws.length > 0) {
            await this.saveLawsToDatabase(laws);
            totalLaws += laws.length;
          }
          
          // Пауза між запитами (5-7 секунд як рекомендовано)
          await new Promise(resolve => setTimeout(resolve, 6000));
        } catch (error) {
          logger.warn('Failed to process search query:', { query, error: error.message });
        }
      }

      logger.info('✅ Knowledge base update completed via official API', { totalLaws });
      return totalLaws;

    } catch (error) {
      logger.error('Failed to update knowledge base:', error);
      throw error;
    }
  }
}

const radaOfficialApiParserInstance = new RadaOfficialApiParser();

module.exports = radaOfficialApiParserInstance;
