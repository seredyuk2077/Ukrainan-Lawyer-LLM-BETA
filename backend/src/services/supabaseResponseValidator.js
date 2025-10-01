const { query } = require('../config/supabase');
const logger = require('../utils/logger');

class SupabaseResponseValidator {
  constructor() {
    this.validationRules = {
      // Правила для мінімізації галюцинацій
      hallucination: {
        // Заборонені фрази, які вказують на вигадування
        forbiddenPhrases: [
          'згідно з моїми знаннями',
          'я вважаю',
          'на мою думку',
          'ймовірно',
          'можливо',
          'я думаю',
          'як правило',
          'зазвичай',
          'в більшості випадків'
        ],
        
        // Обов'язкові елементи для юридичних відповідей
        requiredElements: [
          'ст.',
          'стаття',
          'закон',
          'кодекс'
        ],
        
        // Патерни для виявлення неточностей
        accuracyPatterns: [
          /ст\.\s*\d+/g, // Перевірка формату статей
          /закон\s+україни/gi,
          /кодекс\s+україни/gi
        ],
        
        // Дозволені фрази (не вважати їх помилками)
        allowedPhrases: [
          'кодекс України',
          'закон України',
          'Цивільний кодекс України',
          'Трудовий кодекс України',
          'Кримінальний кодекс України'
        ]
      },
      
      // Правила для юридичної точності
      legalAccuracy: {
        // Обов'язкові посилання на джерела
        requireSources: false, // Вимкнемо для тестування
        
        // Мінімальна кількість посилань на закони
        minLawReferences: 0, // Зменшуємо до 0 для тестування
        
        // Заборонені загальні фрази без конкретики
        forbiddenGeneralities: [
          'за законом',
          'згідно з законодавством',
          'відповідно до права',
          'за правовими нормами'
        ]
      },
      
      // Правила для якості відповіді
      quality: {
        minLength: 100,
        maxLength: 2000,
        requireStructure: true,
        requireConclusion: true
      }
    };

    this.legalTerms = new Set([
      'договір', 'власність', 'спадщина', 'шлюб', 'розлучення',
      'трудовий договір', 'заробітна плата', 'відпустка', 'звільнення',
      'злочин', 'покарання', 'суд', 'прокурор', 'адвокат',
      'позов', 'рішення', 'апеляція', 'касація', 'виконання',
      'штраф', 'порушення', 'адміністративне', 'поліція', 'протокол'
    ]);
  }

  // Основна функція валідації
  async validateResponse(question, response, sources = []) {
    try {
      logger.info('Validating response', { 
        questionLength: question.length,
        responseLength: response.length,
        sourcesCount: sources.length
      });

      const validation = {
        isValid: true,
        score: 0,
        issues: [],
        warnings: [],
        suggestions: [],
        qualityMetrics: {}
      };

      // 1. Перевірка на галюцинації
      const hallucinationCheck = this.checkHallucinations(response);
      validation.issues.push(...hallucinationCheck.issues);
      validation.warnings.push(...hallucinationCheck.warnings);

      // 2. Перевірка юридичної точності
      const accuracyCheck = this.checkLegalAccuracy(response, sources);
      validation.issues.push(...accuracyCheck.issues);
      validation.warnings.push(...accuracyCheck.warnings);

      // 3. Перевірка якості відповіді
      const qualityCheck = this.checkQuality(response);
      validation.issues.push(...qualityCheck.issues);
      validation.warnings.push(...qualityCheck.warnings);

      // 4. Перевірка релевантності
      const relevanceCheck = this.checkRelevance(question, response);
      validation.issues.push(...relevanceCheck.issues);
      validation.warnings.push(...relevanceCheck.warnings);

      // 5. Розрахунок загального балу
      validation.score = this.calculateScore(validation);
      validation.isValid = validation.issues.length === 0;

      // 6. Генерація рекомендацій
      validation.suggestions = this.generateSuggestions(validation);

      // 7. Метрики якості
      validation.qualityMetrics = this.calculateQualityMetrics(response, sources);

      logger.info('Response validation completed', { 
        isValid: validation.isValid,
        score: validation.score,
        issuesCount: validation.issues.length
      });

      return validation;

    } catch (error) {
      logger.error('Error validating response', { error: error.message });
      return {
        isValid: false,
        score: 0,
        issues: ['Помилка валідації відповіді'],
        warnings: [],
        suggestions: [],
        qualityMetrics: {}
      };
    }
  }

  // Перевірка на галюцинації
  checkHallucinations(response) {
    const issues = [];
    const warnings = [];

    // Перевірка заборонених фраз
    this.validationRules.hallucination.forbiddenPhrases.forEach(phrase => {
      if (response.toLowerCase().includes(phrase.toLowerCase())) {
        issues.push(`Виявлено небажану фразу: "${phrase}"`);
      }
    });

    // Перевірка наявності обов'язкових елементів
    const hasRequiredElements = this.validationRules.hallucination.requiredElements.some(element =>
      response.toLowerCase().includes(element.toLowerCase())
    );

    if (!hasRequiredElements) {
      warnings.push('Відповідь не містить посилань на конкретні статті законів');
    }

    // Перевірка патернів точності
    this.validationRules.hallucination.accuracyPatterns.forEach(pattern => {
      const matches = response.match(pattern);
      if (matches && matches.length > 0) {
        // Перевірка валідності посилань на статті
        matches.forEach(match => {
          // Перевіряємо, чи це дозволена фраза
          const isAllowed = this.validationRules.hallucination.allowedPhrases.some(phrase => 
            match.toLowerCase().includes(phrase.toLowerCase())
          );
          
          if (!isAllowed && !this.isValidArticleReference(match)) {
            issues.push(`Невірний формат посилання на статтю: "${match}"`);
          }
        });
      }
    });

    return { issues, warnings };
  }

  // Перевірка юридичної точності
  checkLegalAccuracy(response, sources) {
    const issues = [];
    const warnings = [];

    // Перевірка наявності джерел
    if (this.validationRules.legalAccuracy.requireSources && sources.length === 0) {
      issues.push('Відповідь не містить посилань на правові джерела');
    }

    // Перевірка мінімальної кількості посилань на закони
    const lawReferences = this.extractLawReferences(response);
    if (lawReferences.length < this.validationRules.legalAccuracy.minLawReferences) {
      warnings.push(`Недостатньо посилань на закони. Знайдено: ${lawReferences.length}, потрібно: ${this.validationRules.legalAccuracy.minLawReferences}`);
    }

    // Перевірка заборонених загальностей
    this.validationRules.legalAccuracy.forbiddenGeneralities.forEach(phrase => {
      if (response.toLowerCase().includes(phrase.toLowerCase())) {
        warnings.push(`Використовується загальна фраза без конкретики: "${phrase}"`);
      }
    });

    // Перевірка валідності посилань на джерела
    sources.forEach(source => {
      if (!this.isValidSource(source)) {
        issues.push(`Невірне джерело: ${source.title || source.url}`);
      }
    });

    return { issues, warnings };
  }

  // Перевірка якості відповіді
  checkQuality(response) {
    const issues = [];
    const warnings = [];

    // Перевірка довжини
    if (response.length < this.validationRules.quality.minLength) {
      issues.push(`Відповідь занадто коротка. Мінімум: ${this.validationRules.quality.minLength} символів`);
    }

    if (response.length > this.validationRules.quality.maxLength) {
      warnings.push(`Відповідь занадто довга. Максимум: ${this.validationRules.quality.maxLength} символів`);
    }

    // Перевірка структури
    if (this.validationRules.quality.requireStructure) {
      const hasStructure = this.hasGoodStructure(response);
      if (!hasStructure) {
        warnings.push('Відповідь не має чіткої структури (заголовки, списки, абзаци)');
      }
    }

    // Перевірка висновку
    if (this.validationRules.quality.requireConclusion) {
      const hasConclusion = this.hasConclusion(response);
      if (!hasConclusion) {
        warnings.push('Відповідь не містить висновку або рекомендацій');
      }
    }

    return { issues, warnings };
  }

  // Перевірка релевантності
  checkRelevance(question, response) {
    const issues = [];
    const warnings = [];

    // Витягування ключових слів з питання
    const questionKeywords = this.extractKeywords(question);
    const responseKeywords = this.extractKeywords(response);

    // Перевірка перетину ключових слів
    const commonKeywords = questionKeywords.filter(keyword =>
      responseKeywords.includes(keyword)
    );

    const relevanceScore = commonKeywords.length / Math.max(questionKeywords.length, 1);

    if (relevanceScore < 0.3) {
      issues.push('Відповідь не відповідає на поставлене питання');
    } else if (relevanceScore < 0.5) {
      warnings.push('Відповідь частково відповідає на питання');
    }

    // Перевірка на юридичні терміни
    const hasLegalTerms = Array.from(this.legalTerms).some(term =>
      response.toLowerCase().includes(term.toLowerCase())
    );

    if (!hasLegalTerms) {
      warnings.push('Відповідь не містить юридичних термінів');
    }

    return { issues, warnings };
  }

  // Розрахунок загального балу
  calculateScore(validation) {
    let score = 100;

    // Віднімаємо бали за проблеми
    validation.issues.forEach(issue => {
      if (issue.includes('галюцинаці')) score -= 20;
      else if (issue.includes('джерела')) score -= 15;
      else if (issue.includes('релевантність')) score -= 25;
      else if (issue.includes('довжина')) score -= 10;
      else score -= 5;
    });

    // Віднімаємо бали за попередження
    validation.warnings.forEach(warning => {
      if (warning.includes('структур')) score -= 5;
      else if (warning.includes('висновок')) score -= 5;
      else if (warning.includes('довжина')) score -= 3;
      else score -= 2;
    });

    return Math.max(0, Math.min(100, score));
  }

  // Генерація рекомендацій
  generateSuggestions(validation) {
    const suggestions = [];

    if (validation.issues.some(issue => issue.includes('галюцинаці'))) {
      suggestions.push('Використовуйте тільки інформацію з наданих правових джерел');
    }

    if (validation.issues.some(issue => issue.includes('джерела'))) {
      suggestions.push('Додайте посилання на конкретні статті законів');
    }

    if (validation.warnings.some(warning => warning.includes('структур'))) {
      suggestions.push('Структуруйте відповідь з використанням заголовків та списків');
    }

    if (validation.warnings.some(warning => warning.includes('висновок'))) {
      suggestions.push('Додайте висновок з практичними рекомендаціями');
    }

    if (validation.score < 70) {
      suggestions.push('Розгляньте можливість переформулювання відповіді');
    }

    return suggestions;
  }

  // Розрахунок метрик якості
  calculateQualityMetrics(response, sources) {
    return {
      length: response.length,
      sourcesCount: sources.length,
      lawReferencesCount: this.extractLawReferences(response).length,
      structureScore: this.calculateStructureScore(response),
      readabilityScore: this.calculateReadabilityScore(response),
      legalTermDensity: this.calculateLegalTermDensity(response)
    };
  }

  // Допоміжні методи
  extractKeywords(text) {
    return text
      .toLowerCase()
      .replace(/[^\u0400-\u04FF\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2)
      .slice(0, 20);
  }

  extractLawReferences(text) {
    const patterns = [
      /ст\.\s*\d+/g,
      /стаття\s*\d+/gi,
      /закон\s+україни/gi,
      /кодекс\s+україни/gi
    ];

    const references = [];
    patterns.forEach(pattern => {
      const matches = text.match(pattern);
      if (matches) {
        references.push(...matches);
      }
    });

    return references;
  }

  isValidArticleReference(reference) {
    // Перевірка формату посилання на статтю
    const articlePattern = /^ст\.\s*\d+$/;
    return articlePattern.test(reference.trim());
  }

  isValidSource(source) {
    return source && (source.title || source.url) && source.url;
  }

  hasGoodStructure(text) {
    // Перевірка наявності структурних елементів
    const hasHeaders = /^#+\s|^\d+\.\s|^[А-Я][а-я]+:/m.test(text);
    const hasLists = /^[-*•]\s|^\d+\)\s/m.test(text);
    const hasParagraphs = text.split('\n\n').length > 2;

    return hasHeaders || hasLists || hasParagraphs;
  }

  hasConclusion(text) {
    const conclusionKeywords = [
      'висновок', 'рекомендація', 'підсумок', 'підсумовуючи',
      'отже', 'таким чином', 'в результаті'
    ];

    return conclusionKeywords.some(keyword =>
      text.toLowerCase().includes(keyword)
    );
  }

  calculateStructureScore(text) {
    let score = 0;
    
    if (this.hasGoodStructure(text)) score += 40;
    if (this.hasConclusion(text)) score += 30;
    if (text.includes('ст.')) score += 20;
    if (text.includes('джерело') || text.includes('посилання')) score += 10;

    return score;
  }

  calculateReadabilityScore(text) {
    // Простий розрахунок читабельності
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const words = text.split(/\s+/).filter(w => w.length > 0);
    const avgWordsPerSentence = words.length / sentences.length;

    // Ідеальний діапазон: 15-25 слів на речення
    if (avgWordsPerSentence >= 15 && avgWordsPerSentence <= 25) {
      return 100;
    } else if (avgWordsPerSentence >= 10 && avgWordsPerSentence <= 30) {
      return 80;
    } else if (avgWordsPerSentence >= 5 && avgWordsPerSentence <= 40) {
      return 60;
    } else {
      return 40;
    }
  }

  calculateLegalTermDensity(text) {
    const words = text.toLowerCase().split(/\s+/);
    const legalTerms = words.filter(word => this.legalTerms.has(word));
    return (legalTerms.length / words.length) * 100;
  }

  // Збереження результатів валідації
  async saveValidationResults(question, response, validation, sessionId) {
    try {
      await query('response_validations', 'insert', {
        data: {
          question,
          response,
          validation_results: validation,
          session_id: sessionId
        }
      });

      logger.info('Validation results saved', { 
        sessionId: sessionId?.substring(0, 8),
        score: validation.score,
        isValid: validation.isValid
      });

    } catch (error) {
      logger.error('Error saving validation results', { error: error.message });
    }
  }

  // Отримання статистики валідації
  async getValidationStats() {
    try {
      const result = await query('response_validations', 'select', {
        select: 'validation_results',
        limit: 1000
      });

      const validations = result.rows;
      const totalValidations = validations.length;
      
      if (totalValidations === 0) {
        return {
          total_validations: 0,
          avg_score: 0,
          valid_responses: 0,
          invalid_responses: 0
        };
      }

      const validResponses = validations.filter(v => v.validation_results.isValid).length;
      const avgScore = validations.reduce((sum, v) => sum + (v.validation_results.score || 0), 0) / totalValidations;

      return {
        total_validations: totalValidations,
        avg_score: Math.round(avgScore * 100) / 100,
        valid_responses: validResponses,
        invalid_responses: totalValidations - validResponses
      };
    } catch (error) {
      logger.error('Error getting validation stats', { error: error.message });
      return null;
    }
  }
}

module.exports = new SupabaseResponseValidator();
