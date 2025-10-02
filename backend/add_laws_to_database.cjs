require('dotenv').config();
const fs = require('fs');
const radaOfficialApiParser = require('./src/services/radaOfficialApiParser');
const { query } = require('./src/config/supabase');
const logger = require('./src/utils/logger');

/**
 * Універсальний скрипт для додавання законів до бази даних
 * Використання: node add_laws_to_database.cjs "ЗУ про Захист Прав Споживачів" "ЗУ про Оперативно Розшукову Діяльність"
 */

// Функція для пошуку закону в файлах doc.txt та ist.txt
async function findLawInDocFile(lawName) {
  try {
    const { execSync } = require('child_process');
    const path = require('path');
    
          const docPath = path.join(__dirname, '../docs/api-data/doc.txt');
          const istPath = path.join(__dirname, '../docs/api-data/ist.txt');
    
    // Спочатку шукаємо в doc.txt
    // Якщо це номер закону (формат XXXX-XX), шукаємо в другій колонці
    const isLawNumber = /^\d+-\d+$/.test(lawName);
    const docSearchCommand = isLawNumber 
      ? `iconv -f cp1251 -t utf-8 "${docPath}" | awk -F'\t' '$2 == "${lawName}"' | head -5`
      : `iconv -f cp1251 -t utf-8 "${docPath}" | grep -i "${lawName}" | head -5`;
    let result = '';
    
    try {
      result = execSync(docSearchCommand, { encoding: 'utf8' });
    } catch (error) {
      logger.warn(`Пошук в doc.txt не дав результатів для "${lawName}"`);
    }
    
    // ist.txt містить тільки ID та події, без назв документів
    // Тому використовуємо його тільки для додаткової інформації про знайдені документи
    
    if (result && result.trim()) {
      const lines = result.trim().split('\n');
      const laws = [];
      
      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          laws.push({
            id: parts[0],
            number: parts[1],
            title: parts[2],
            fullLine: line,
            source: fs.existsSync(istPath) && result.includes('ist.txt') ? 'ist.txt' : 'doc.txt'
          });
        }
      }
      
      return laws;
    }
    
    return [];
  } catch (error) {
    logger.error(`Критична помилка при пошуку закону "${lawName}":`, error);
    return [];
  }
}

// Функція для отримання додаткової інформації з ist.txt
async function getAdditionalInfoFromIst(docId) {
  try {
    const { execSync } = require('child_process');
    const path = require('path');
    
          const istPath = path.join(__dirname, '../docs/api-data/ist.txt');
    
    if (!fs.existsSync(istPath)) {
      return null;
    }
    
    const searchCommand = `iconv -f cp1251 -t utf-8 "${istPath}" | grep "^${docId}\\t" | head -1`;
    const result = execSync(searchCommand, { encoding: 'utf8' });
    
    if (result.trim()) {
      const parts = result.trim().split('\t');
      return {
        events: parts[1] || '',
        classification: parts[2] || '',
        publications: parts[3] || '',
        relations: parts[4] || ''
      };
    }
    
    return null;
  } catch (error) {
    logger.warn(`Не вдалося отримати додаткову інформацію для ID ${docId}:`, error.message);
    return null;
  }
}

// Функція для додавання закону до бази даних
async function addLawToDatabase(lawName) {
  try {
    logger.info(`🔍 Шукаємо закон: "${lawName}"`);
    
    // Перевіряємо чи вже існує
    const existingLaw = await query('legal_laws', 'select', {
      select: 'id, title',
      eq: { column: 'title', value: lawName }
    });
    
    if (existingLaw.rows && existingLaw.rows.length > 0) {
      logger.info(`⏭️  Закон "${lawName}" вже існує в базі даних. Пропускаємо.`);
      return { success: true, skipped: true, message: 'Закон вже існує' };
    }
    
    // Шукаємо в doc.txt
    const foundLaws = await findLawInDocFile(lawName);
    
    if (foundLaws.length === 0) {
      logger.warn(`❌ Закон "${lawName}" не знайдено в doc.txt`);
      return { success: false, message: 'Закон не знайдено' };
    }
    
    
    // Фільтруємо закони про внесення змін та рішення судів
    const filteredLaws = foundLaws.filter(law => {
      const title = law.title.toLowerCase();
      return !title.includes('внесення змін') && 
             !title.includes('зміни до') && 
             !title.includes('зміни в') &&
             !title.includes('зміни та доповнення') &&
             !title.includes('зміни та доповнення до') &&
             !title.includes('рішення') &&
             !title.includes('ухвала') &&
             !title.includes('постанова') &&
             !title.includes('конституційний суд') &&
             !title.includes('верховний суд') &&
             !title.includes('сенат');
    });
    
    if (filteredLaws.length === 0) {
      logger.warn(`❌ Всі знайдені закони є законами про внесення змін або рішеннями судів. Пропускаємо "${lawName}"`);
      return { success: false, message: 'Тільки закони про внесення змін або рішення судів' };
    }
    
    // Вибираємо найкращий варіант (найкоротший заголовок, щоб уникнути рішень судів)
    const bestLaw = filteredLaws.reduce((best, current) => {
      // Пріоритет: основні закони та кодекси
      if (current.title.includes('Закон України') && !current.title.includes('рішення') && !current.title.includes('ухвала')) {
        return current;
      }
      if (best.title.includes('рішення') || best.title.includes('ухвала')) {
        return current;
      }
      return current.title.length < best.title.length ? current : best;
    });
    
    logger.info(`📄 Знайдено: "${bestLaw.title}" (ID: ${bestLaw.id}, Номер: ${bestLaw.number})`);
    
    // Отримуємо додаткову інформацію з ist.txt
    const additionalInfo = await getAdditionalInfoFromIst(bestLaw.id);
    if (additionalInfo) {
      logger.info(`📋 Додаткова інформація: події=${additionalInfo.events ? 'так' : 'ні'}, публікації=${additionalInfo.publications ? 'так' : 'ні'}`);
    }
    
    // Отримуємо токен
    const token = await radaOfficialApiParser.getToken();
    
    // Отримуємо деталі документа
    let docDetails = null;
    try {
      docDetails = await radaOfficialApiParser.getDocumentDetails(
        { id: bestLaw.id, title: bestLaw.title }, 
        token
      );
    } catch (apiError) {
      logger.warn(`⚠️ API помилка для "${bestLaw.title}": ${apiError.message}`);
      docDetails = null;
    }
    
    if (docDetails && docDetails.content && docDetails.content.length > 1000) {
      // Зберігаємо в базу
      await radaOfficialApiParser.saveLawsToDatabase([docDetails]);
      
      logger.info(`✅ Успішно додано: "${bestLaw.title}"`);
      return { success: true, message: 'Закон успішно додано', law: bestLaw };
    } else {
      // Якщо не вдалося отримати контент через API, створюємо базову запис
      logger.warn(`⚠️ Не вдалося отримати контент через API для: "${bestLaw.title}"`);
      logger.info(`📝 Створюємо базову запис з метаданими...`);
      
      const basicLawData = {
        title: bestLaw.title,
        content: `Закон "${bestLaw.title}" (номер ${bestLaw.number}). Контент недоступний через Rada API.`,
        source_url: `https://data.rada.gov.ua/laws/show/${bestLaw.id}`,
        law_number: bestLaw.number,
        keywords: extractKeywords(bestLaw.title, ''),
        articles: [],
        category: determineCategory(bestLaw.title, bestLaw.number),
        date_created: new Date().toISOString().split('T')[0]
      };
      
      // Зберігаємо базову запис
      await radaOfficialApiParser.saveLawsToDatabase([basicLawData]);
      
      logger.info(`✅ Створено базову запис для: "${bestLaw.title}"`);
      return { success: true, message: 'Створено базову запис (контент недоступний)', law: bestLaw };
    }
    
  } catch (error) {
    logger.error(`❌ Помилка при обробці "${lawName}":`, error.message);
    return { success: false, message: error.message };
  }
}

// Функція для збагачення законів статтями
async function enrichLawsWithArticles() {
  try {
    logger.info('🚀 Збагачуємо закони статтями та ключовими словами...');
    
    const laws = await query('legal_laws', 'select', { 
      select: 'id, title, content, law_number' 
    });
    
    if (!laws.rows || laws.rows.length === 0) {
      logger.info('📋 Немає законів для обробки');
      return;
    }
    
    logger.info(`📋 Знайдено ${laws.rows.length} законів для обробки`);
    
    for (const law of laws.rows) {
      try {
        // Пропускаємо закони без контенту або з базовим контентом
        if (!law.content || law.content.includes('Контент недоступний через Rada API') || law.content.length < 100) {
          logger.info(`⏭️ Пропускаємо "${law.title}" - немає контенту для обробки`);
          continue;
        }
        
        logger.info(`📄 Обробляємо: ${law.title}`);
        
        // Парсимо статті з тексту
        const articles = parseArticlesFromText(law.content, law.law_number);
        
        // Витягуємо ключові слова
        const keywords = extractKeywords(law.title, law.content);
        
        // Визначаємо категорію
        const category = determineCategory(law.title, law.law_number);
        
        // Оновлюємо в базі даних
        await query('legal_laws', 'update', {
          data: {
            articles: articles,
            keywords: keywords,
            category: category,
            updated_at: new Date().toISOString()
          },
          eq: { column: 'id', value: law.id }
        });
        
        logger.info(`✅ Збагачено: ${law.title} (${articles.length} статей, ${keywords.length} ключових слів)`);
        
      } catch (error) {
        logger.error(`❌ Помилка при обробці "${law.title}":`, error.message);
      }
    }
    
    logger.info('✅ Збагачення завершено!');
    
  } catch (error) {
    logger.error('❌ Критична помилка при збагаченні:', error);
  }
}

// Функція для парсингу статей
function parseArticlesFromText(content, lawNumber) {
  const articles = [];
  
  // Покращений регулярний вираз для статтей
  const articlePattern = /Стаття\s+(\d+[а-я]?)\s*\.?\s*([^]*?)(?=Стаття\s+\d+[а-я]?|$)/gi;
  
  let match;
  while ((match = articlePattern.exec(content)) !== null) {
    const articleNumber = match[1];
    const articleText = match[2].trim();
    
    if (articleText.length > 100) { // Мінімальна довжина статті
      articles.push({
        number: articleNumber,
        title: extractArticleTitle(articleText),
        content: articleText.substring(0, 3000), // Обмежуємо розмір
        law_number: lawNumber
      });
    }
  }
  
  return articles;
}

// Функція для витягування заголовка статті
function extractArticleTitle(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 10 && trimmed.length < 200) {
      return trimmed;
    }
  }
  return text.substring(0, 100) + '...';
}

// Функція для витягування ключових слів
function extractKeywords(title, content) {
  const keywords = new Set();
  const text = `${title} ${content}`.toLowerCase();
  
  // Додаємо слова з заголовка (крім службових)
  const titleWords = title.toLowerCase()
    .replace(/[^\u0400-\u04FF\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 3 && !['про', 'україни', 'кодекс', 'закон', 'деякі', 'питання'].includes(word));
  
  titleWords.forEach(word => keywords.add(word));
  
  // Розширені юридичні терміни для кращого пошуку
  const legalTerms = [
    // Основні юридичні поняття
    'право', 'закон', 'стаття', 'пункт', 'частина', 'розділ', 'глава',
    'договір', 'угода', 'контракт', 'соглашение',
    
    // Процесуальні терміни
    'порушення', 'відповідальність', 'штраф', 'покарання', 'санкція',
    'суд', 'суддя', 'судочинство', 'прокурор', 'адвокат', 'нотаріус',
    'слідчий', 'експерт', 'свідок', 'позивач', 'відповідач',
    
    // Державні органи
    'держава', 'уряд', 'міністерство', 'відомство', 'департамент',
    'комітет', 'комісія', 'служба', 'агентство', 'управління',
    
    // Суб'єкти права
    'громадянин', 'особа', 'організація', 'підприємство', 'компанія',
    'товариство', 'кооператив', 'фонд', 'обєднання', 'спілка',
    
    // Специфічні терміни
    'майно', 'власність', 'спадщина', 'спадок', 'спадкоємець',
    'шлюб', 'розлучення', 'діти', 'опіка', 'піклування',
    'праця', 'зайнятість', 'заробітна плата', 'відпустка',
    'податок', 'збір', 'мито', 'акциз', 'пдв',
    'земля', 'ділянка', 'будівля', 'житло', 'квартира',
    'автомобіль', 'транспорт', 'дорожній рух', 'дтп',
    'медицина', 'лікування', 'лікар', 'пацієнт', 'лікарня',
    'освіта', 'школа', 'університет', 'студент', 'учень',
    'пенсія', 'соціальне забезпечення', 'інвалідність',
    'військова служба', 'мобілізація', 'призов', 'резервіст'
  ];
  
  // Додаємо терміни з тексту
  legalTerms.forEach(term => {
    if (text.includes(term)) {
      keywords.add(term);
    }
  });
  
  // Додаємо найчастіші слова з контенту
  if (content && content.length > 100) {
    const contentWords = content.toLowerCase()
      .replace(/[^\u0400-\u04FF\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 4 && !['стаття', 'пункт', 'частина', 'розділ'].includes(word));
    
    const wordCount = {};
    contentWords.forEach(word => {
      wordCount[word] = (wordCount[word] || 0) + 1;
    });
    
    const frequentWords = Object.entries(wordCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
    
    frequentWords.forEach(word => keywords.add(word));
  }
  
  return Array.from(keywords).slice(0, 30); // Максимум 30 ключових слів
}

// Функція для визначення категорії
function determineCategory(title, lawNumber) {
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
  } else if (titleLower.includes('конституція')) {
    return 'Конституційне право';
  } else if (titleLower.includes('захист') && titleLower.includes('споживач')) {
    return 'Захист прав споживачів';
  } else if (titleLower.includes('оперативно') && titleLower.includes('розшуков')) {
    return 'Оперативно-розшукова діяльність';
  }
  
  return 'Інше';
}

// Основна функція
async function main() {
  try {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
      console.log('📋 Використання: node add_laws_to_database.cjs "Назва закону 1" "Назва закону 2" ...');
      console.log('📋 Приклад: node add_laws_to_database.cjs "ЗУ про Захист Прав Споживачів" "ЗУ про Оперативно Розшукову Діяльність"');
      return;
    }
    
    logger.info('🚀 Починаємо додавання законів до бази даних');
    logger.info('=' .repeat(60));
    
    let added = 0;
    let skipped = 0;
    let failed = 0;
    
    for (const lawName of args) {
      const result = await addLawToDatabase(lawName);
      
      if (result.success) {
        if (result.skipped) {
          skipped++;
        } else {
          added++;
        }
      } else {
        failed++;
      }
      
      // Пауза між запитами
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    // Збагачуємо всі закони статтями (тільки якщо є контент)
    if (added > 0) {
      logger.info('🔄 Збагачуємо нові закони статтями...');
      await enrichLawsWithArticles();
    }
    
    logger.info('=' .repeat(60));
    logger.info('📊 ПІДСУМОК:');
    logger.info(`✅ Додано: ${added}`);
    logger.info(`⏭️  Пропущено (вже існують): ${skipped}`);
    logger.info(`❌ Помилок: ${failed}`);
    logger.info(`📈 Успішність: ${Math.round((added / (added + failed)) * 100)}%`);
    
  } catch (error) {
    logger.error('❌ Критична помилка:', error);
  }
}

// Запускаємо скрипт
if (require.main === module) {
  main();
}

module.exports = { addLawToDatabase, enrichLawsWithArticles };
