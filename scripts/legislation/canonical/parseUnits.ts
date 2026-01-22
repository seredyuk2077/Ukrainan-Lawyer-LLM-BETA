/**
 * Парсери Content Units з різних джерел
 * 
 * Підтримує різні стратегії парсингу:
 * - article-based: з stru (typ='ST')
 * - point-based: з stru (typ='PU', 'PP')
 * - fallback: з TXT або альтернативні методи
 */

import { ContentUnit, UnitType, sanitizeHtmlToText, StruTypeDistribution, analyzeStruTypes, determineParsingStrategy, ParsingStrategy } from './contentUnits.js';
import { parseChapterBasedUnits, parseAnnexBasedUnits } from './parseUnitsAdvanced.js';

/**
 * Парсить Content Units з stru масиву (статті)
 */
export function parseArticleUnitsFromStru(stru: any[]): ContentUnit[] {
  const units: ContentUnit[] = [];

  for (const item of stru) {
    if (!item || typeof item !== 'object') continue;
    
    const typ = item.typ || item.type || '';
    
    // Шукаємо статті (typ='ST')
    if (typ === 'ST') {
      const struNumber = item.stru || item.number || '';
      const text = sanitizeHtmlToText(item.text || item.content || '');
      
      if (text.length > 0) {
        // Витягуємо заголовок з line або text
        const line = item.line || '';
        const title = extractTitleFromLine(line, struNumber) || `Стаття ${struNumber}`;
        
        units.push({
          unit_type: 'article',
          number: struNumber,
          title,
          text,
          hierarchy: {},
          source: {
            tree_id: item.tree_id,
            id: item.id,
            typ: item.typ,
            typn: item.typn,
            pos: item.pos,
            len: item.len,
            parent: item.parent,
            level: item.level,
            line: item.line,
          },
        });
      }
    }
  }

  return units;
}

/**
 * Парсить Content Units з stru масиву (пункти/підпункти)
 */
export function parsePointUnitsFromStru(stru: any[]): ContentUnit[] {
  const units: ContentUnit[] = [];
  
  // Будуємо ієрархію для вкладення
  const hierarchy: Record<string, { point?: string; article?: string }> = {};
  
  for (const item of stru) {
    if (!item || typeof item !== 'object') continue;
    
    const typ = item.typ || item.type || '';
    const parentId = item.parent;
    
    // Отримуємо ієрархію з батьківського елемента
    const parentHierarchy = parentId ? hierarchy[parentId] || {} : {};
    
    if (typ === 'PU') {
      // Пункт
      const pointNumber = item.stru || item.number || '';
      const text = sanitizeHtmlToText(item.text || item.content || '');
      
      if (text.length > 0) {
        const line = item.line || '';
        const title = extractTitleFromLine(line, pointNumber) || `Пункт ${pointNumber}`;
        
        const unit: ContentUnit = {
          unit_type: 'point',
          number: pointNumber,
          title,
          text,
          hierarchy: { ...parentHierarchy },
          source: {
            tree_id: item.tree_id,
            id: item.id,
            typ: item.typ,
            typn: item.typn,
            pos: item.pos,
            len: item.len,
            parent: item.parent,
            level: item.level,
            line: item.line,
          },
        };
        
        units.push(unit);
        
        // Зберігаємо ієрархію для дочірніх елементів
        if (item.id) {
          hierarchy[item.id] = { ...parentHierarchy, point: pointNumber };
        }
      }
    } else if (typ === 'PP') {
      // Підпункт
      const subpointNumber = item.stru || item.number || '';
      const text = sanitizeHtmlToText(item.text || item.content || '');
      
      if (text.length > 0) {
        // Об'єднуємо з пунктом, якщо пункт короткий
        const parentPoint = units.find(u => 
          u.unit_type === 'point' && 
          u.source.id === parentId &&
          u.text.length < 2000 // Якщо пункт короткий
        );
        
        if (parentPoint && parentPoint.text.length < 2000) {
          // Додаємо підпункт до тексту пункту
          const line = item.line || '';
          const subpointTitle = extractTitleFromLine(line, subpointNumber) || `Підпункт ${subpointNumber}`;
          parentPoint.text += `\n\n${subpointTitle}\n${text}`;
        } else {
          // Створюємо окремий unit для підпункту
          const line = item.line || '';
          const title = extractTitleFromLine(line, subpointNumber) || `Підпункт ${subpointNumber}`;
          
          units.push({
            unit_type: 'subpoint',
            number: `${parentHierarchy.point || ''}.${subpointNumber}`.replace(/^\./, ''),
            title,
            text,
            hierarchy: { ...parentHierarchy },
            source: {
              tree_id: item.tree_id,
              id: item.id,
              typ: item.typ,
              typn: item.typn,
              pos: item.pos,
              len: item.len,
              parent: item.parent,
              level: item.level,
              line: item.line,
            },
          });
        }
      }
    }
  }

  return units;
}

/**
 * Парсить Units з TXT (fallback стратегія)
 */
export function parseUnitsFromTxt(
  txt: string,
  strategy: ParsingStrategy
): ContentUnit[] {
  const units: ContentUnit[] = [];
  
  if (strategy === 'article-based') {
    // Шукаємо статті в тексті
    const articlePattern = /Стаття\s+(\d+[а-яіїє]?(?:-\d+)?)\s*\.?\s*([^]*?)(?=Стаття\s+\d+[а-яіїє]?(?:-\d+)?|Розділ\s+[IVX]+|$)/gi;
    let match;
    
    while ((match = articlePattern.exec(txt)) !== null) {
      const articleNumber = match[1].trim();
      let articleText = match[2].trim();
      articleText = articleText.replace(/\n{3,}/g, '\n\n').trim();
      
      if (articleText.length < 50) continue;
      
      const title = extractTitleFromText(articleText, articleNumber) || `Стаття ${articleNumber}`;
      
      units.push({
        unit_type: 'article',
        number: articleNumber,
        title,
        text: articleText,
        hierarchy: {},
        source: {},
      });
    }
  } else if (strategy === 'point-based') {
    // Шукаємо пункти в тексті
    const pointPattern = /(\d+)\.\s+([^]*?)(?=\d+\.\s+|$)/g;
    let match;
    
    while ((match = pointPattern.exec(txt)) !== null) {
      const pointNumber = match[1].trim();
      let pointText = match[2].trim();
      pointText = pointText.replace(/\n{3,}/g, '\n\n').trim();
      
      if (pointText.length < 50) continue;
      
      const title = extractTitleFromText(pointText, pointNumber) || `Пункт ${pointNumber}`;
      
      units.push({
        unit_type: 'point',
        number: pointNumber,
        title,
        text: pointText,
        hierarchy: {},
        source: {},
      });
    }
  }
  
  return units;
}

/**
 * Витягує заголовок з line рядка
 */
function extractTitleFromLine(line: string, number: string): string | null {
  if (!line) return null;
  
  // Line часто містить структуровану інформацію типу "Стаття 1. Назва статті"
  const match = line.match(/Стаття\s+\d+[а-яіїє]?(?:-\d+)?\.?\s*(.+)/i) ||
                line.match(/Пункт\s+\d+\.?\s*(.+)/i) ||
                line.match(/^\d+\.\s*(.+)/);
  
  if (match && match[1]) {
    return match[1].trim();
  }
  
  return null;
}

/**
 * Витягує заголовок з тексту
 */
function extractTitleFromText(text: string, number: string): string | null {
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  
  if (lines.length === 0) return null;
  
  const firstLine = lines[0].trim();
  
  // Якщо перший рядок короткий (менше 200 символів), вважаємо його назвою
  if (firstLine.length < 200 && !firstLine.match(/^\d+\./)) {
    return firstLine;
  }
  
  return null;
}

/**
 * Головна функція парсингу Units з підтримкою різних стратегій
 * Підтримує AI-assisted parsing для "weird docs" (PHASE 11)
 */
export async function parseContentUnits(
  stru: any[] | null | undefined,
  txt: string | null | undefined,
  documentType: string,
  metadata?: {
    title?: string;
    nreg?: string;
    lawNumber?: string | null;
  }
): Promise<{ 
  units: ContentUnit[]; 
  strategy: ParsingStrategy; 
  strategyReason: string;
  distribution: StruTypeDistribution;
  requiresFallback: boolean;
}> {
  let units: ContentUnit[] = [];
  let distribution: StruTypeDistribution = { 
    articles: 0, points: 0, subpoints: 0, sections: 0, chapters: 0, 
    books: 0, parts: 0, paragraphs: 0, annexes: 0, tables: 0, other: 0, total: 0 
  };
  let strategyResult = { strategy: 'fallback' as ParsingStrategy, reason: 'no stru' };
  let requiresFallback = false;
  
  // Аналізуємо stru якщо є
  if (stru && Array.isArray(stru) && stru.length > 0) {
    distribution = analyzeStruTypes(stru);
    strategyResult = determineParsingStrategy(distribution, documentType);
    const strategy = strategyResult.strategy;
    
    if (strategy === 'article-based') {
      units = parseArticleUnitsFromStru(stru);
    } else if (strategy === 'point-based') {
      units = parsePointUnitsFromStru(stru);
    } else if (strategy === 'chapter-based') {
      units = parseChapterBasedUnits(stru);
    } else if (strategy === 'annex-based') {
      units = parseAnnexBasedUnits(stru);
    }
  }
  
  // NO-EMPTY-INDEX POLICY: якщо документ важливий і units=0 → обов'язковий fallback
  const importantDocumentTypes = [
    'Постанова', 'Постанова КМУ', 'Постанова ВР', 
    'Наказ', 'Указ', 'Розпорядження', 'Рішення', 
    'Положення', 'Правила', 'Інструкція'
  ];
  
  // AI Parsing Assist trigger conditions (PHASE 11)
  const shouldTryAIAssist = 
    (strategyResult.strategy === 'fallback' && units.length === 0) ||
    (units.length === 0 && importantDocumentTypes.some(type => documentType.includes(type))) ||
    (distribution.total > 0 && distribution.other / distribution.total > 0.5); // Багато unknown типив
  
  if (shouldTryAIAssist && metadata && txt) {
    try {
      const { generateAIParsePlan } = await import('./aiParsingAssist.js');
      
      // Підготовка samples
      const textSamples = [
        { content: txt.slice(0, 2000), offset: 0 },
        { content: txt.slice(Math.floor(txt.length / 2), Math.floor(txt.length / 2) + 1000), offset: Math.floor(txt.length / 2) },
        { content: txt.slice(-1000), offset: Math.max(0, txt.length - 1000) },
      ];
      
      const plan = await generateAIParsePlan({
        title: metadata.title || '',
        documentType,
        nreg: metadata.nreg || '',
        lawNumber: metadata.lawNumber,
        struDistribution: {
          articles: distribution.articles,
          points: distribution.points,
          chapters: distribution.chapters,
          sections: distribution.sections,
          total: distribution.total,
        },
        struSamples: stru?.slice(0, 20).map(item => ({
          typ: item.typ,
          typn: item.typn,
          tree_id: item.tree_id,
          line: item.line,
        })),
        textSamples,
      });
      
      if (plan && plan.indexable && plan.strategy !== 'fallback') {
        // Використовуємо AI plan
        console.log(`🤖 AI parsing assist: strategy=${plan.strategy}, confidence=${plan.confidence.toFixed(2)}`);
        
        // Застосовуємо стратегію з плану
        if (plan.strategy === 'article-based' || plan.strategy === 'point-based') {
          units = parseUnitsFromTxt(txt, plan.strategy);
          if (units.length > 0) {
            strategyResult = {
              strategy: plan.strategy,
              reason: `AI-assisted: ${plan.strategy} (confidence=${plan.confidence.toFixed(2)}, ${plan.notes})`,
            };
            requiresFallback = true;
          }
        }
        // chapter-based, annex-based можна додати пізніше
      }
    } catch (e: any) {
      console.warn(`⚠️  AI parsing assist error: ${e.message}, continuing with standard fallback`);
    }
  }
  
  // Deterministic fallback (якщо AI не допоміг або не викликався)
  // Для важливих документів або документів з достатньо тексту
  if (units.length === 0 && txt && txt.length > 100) {
    const isImportant = importantDocumentTypes.some(type => documentType.includes(type));
    const hasSubstantialText = txt.length > 500; // Мінімум 500 символів
    
    if (isImportant || hasSubstantialText) {
    requiresFallback = true;
    const txtStrategy = documentType.includes('Постанова') ? 'point-based' : 
                       documentType.includes('Наказ') || documentType.includes('Інструкція') ? 'point-based' :
                       'point-based';
    
    units = parseUnitsFromTxt(txt, txtStrategy);
    if (units.length > 0) {
      strategyResult = { 
        strategy: txtStrategy, 
        reason: `Fallback TXT parsing (stru не дав units, document_type=${documentType})` 
      };
    } else {
      // Last resort: простий text splitting для всіх документів з текстом
      if (txt && txt.length > 100) {
          // Розбиваємо на chunks по параграфах або по реченнях якщо параграфів мало
          let paragraphs = txt.split(/\n\s*\n/).filter(p => p.trim().length > 50);
          
          // Якщо параграфів мало або вони дуже довгі — розбиваємо по реченнях
          if (paragraphs.length < 3 && txt.length > 2000) {
            const sentences = txt.match(/[^.!?]+[.!?]+/g) || [];
            paragraphs = [];
            let currentPara = '';
            for (const sentence of sentences) {
              currentPara += sentence.trim() + ' ';
              if (currentPara.length > 500) {
                paragraphs.push(currentPara.trim());
                currentPara = '';
              }
            }
            if (currentPara.trim().length > 50) {
              paragraphs.push(currentPara.trim());
            }
          }
          
          // Якщо все ще порожньо — робимо один великий unit
          if (paragraphs.length === 0 && txt.length > 100) {
            paragraphs = [txt];
          }
          
          units = paragraphs.map((text, i) => ({
            unit_type: 'paragraph' as UnitType,
            number: String(i + 1),
            title: null,
            text: text.trim(),
            hierarchy: {},
            source: {},
          }));
          
          if (units.length > 0) {
            strategyResult = {
              strategy: 'fallback',
              reason: `Last resort: paragraph-based splitting (${units.length} units)`,
            };
          } else {
            strategyResult = { 
              strategy: 'fallback', 
              reason: `No units found, document may be non-indexable.` 
            };
          }
        } else {
          strategyResult = { 
            strategy: 'fallback', 
            reason: `No units found, document may be non-indexable.` 
          };
        }
      }
    }
  } else if (units.length === 0 && txt && txt.length > 100) {
    // Звичайний fallback для інших типів (якщо є текст)
    const txtStrategy = documentType.includes('Постанова') ? 'point-based' : 'article-based';
    units = parseUnitsFromTxt(txt, txtStrategy);
    if (units.length > 0) {
      strategyResult = { 
        strategy: txtStrategy, 
        reason: `TXT fallback: ${txtStrategy}` 
      };
    } else if (txt.length > 500) {
      // Last resort для неважливих документів теж
      const paragraphs = txt.split(/\n\s*\n/).filter(p => p.trim().length > 50);
      if (paragraphs.length === 0) {
        const sentences = txt.match(/[^.!?]+[.!?]+/g) || [];
        let currentPara = '';
        for (const sentence of sentences) {
          currentPara += sentence.trim() + ' ';
          if (currentPara.length > 500) {
            paragraphs.push(currentPara.trim());
            currentPara = '';
          }
        }
        if (currentPara.trim().length > 50) {
          paragraphs.push(currentPara.trim());
        }
      }
      if (paragraphs.length === 0 && txt.length > 100) {
        paragraphs.push(txt);
      }
      units = paragraphs.map((text, i) => ({
        unit_type: 'paragraph' as UnitType,
        number: String(i + 1),
        title: null,
        text: text.trim(),
        hierarchy: {},
        source: {},
      }));
      if (units.length > 0) {
        strategyResult = {
          strategy: 'fallback',
          reason: `Last resort: paragraph-based splitting (${units.length} units)`,
        };
      }
    }
  }
  
  return { 
    units, 
    strategy: strategyResult.strategy, 
    strategyReason: strategyResult.reason,
    distribution,
    requiresFallback,
  };
}
