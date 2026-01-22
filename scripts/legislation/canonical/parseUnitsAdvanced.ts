/**
 * Розширені парсери для chapter-based та annex-based стратегій
 */

import { ContentUnit, UnitType, sanitizeHtmlToText, mapTypToUnitType } from './contentUnits.js';

/**
 * Парсить Content Units з chapter-based стратегією
 * Витягує leaf структурні елементи (параграфи, підрозділи) з розділів/глав
 */
export function parseChapterBasedUnits(stru: any[]): ContentUnit[] {
  const units: ContentUnit[] = [];
  const hierarchy: Record<string, any> = {}; // id → hierarchy object
  
  // Будуємо ієрархію
  for (const item of stru) {
    if (!item || typeof item !== 'object') continue;
    
    const itemId = item.id;
    const parentId = item.parent;
    const parentHierarchy = parentId ? hierarchy[parentId] || {} : {};
    
    const unitType = mapTypToUnitType(item);
    
    // Зберігаємо ієрархію для дочірніх елементів
    const currentHierarchy: any = { ...parentHierarchy };
    
    if (unitType === 'book' && item.stru) {
      currentHierarchy.book = item.stru;
    } else if (unitType === 'part' && item.stru) {
      currentHierarchy.part = item.stru;
    } else if (unitType === 'section' && item.stru) {
      currentHierarchy.section = item.stru;
    } else if (unitType === 'chapter' && item.stru) {
      currentHierarchy.chapter = item.stru;
    }
    
    if (itemId) {
      hierarchy[itemId] = currentHierarchy;
    }
    
    // Витягуємо leaf units (параграфи, підрозділи без дочірніх)
    // Або елементи з текстом, які можуть бути units
    const text = sanitizeHtmlToText(item.text || item.content || '');
    if (text.length > 50) { // Мінімальний розмір
      const struNumber = item.stru || item.number || '';
      const line = item.line || '';
      const title = extractTitleFromLine(line, struNumber);
      
      // Включаємо лише leaf units або структурні елементи з текстом
      if (unitType && ['paragraph', 'article', 'point', 'subpoint'].includes(unitType)) {
        units.push({
          unit_type: unitType,
          number: struNumber || String(units.length + 1),
          title: title || `${getUnitTypeLabel(unitType)} ${struNumber || units.length + 1}`,
          text,
          hierarchy: currentHierarchy,
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
 * Парсить Content Units з annex-based стратегією
 * Витягує додатки/форми/таблиці як окремі units
 */
export function parseAnnexBasedUnits(stru: any[]): ContentUnit[] {
  const units: ContentUnit[] = [];
  
  for (const item of stru) {
    if (!item || typeof item !== 'object') continue;
    
    const unitType = mapTypToUnitType(item);
    
    // Включаємо додатки/форми/таблиці
    if (unitType === 'annex' || unitType === 'form' || unitType === 'table') {
      const text = sanitizeHtmlToText(item.text || item.content || '');
      if (text.length > 50) {
        const struNumber = item.stru || item.number || '';
        const line = item.line || '';
        const title = extractTitleFromLine(line, struNumber) || 
                     extractAnnexTitle(line, item.typn || '');
        
        units.push({
          unit_type: unitType,
          number: struNumber || extractAnnexNumber(line) || String(units.length + 1),
          title: title || `${getUnitTypeLabel(unitType)} ${struNumber || units.length + 1}`,
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
  
  // Якщо не знайдено, шукаємо в тексті
  if (units.length === 0) {
    // Fallback: шукаємо "Додаток" в line
    for (const item of stru) {
      if (!item || typeof item !== 'object') continue;
      const line = (item.line || '').toLowerCase();
      const text = sanitizeHtmlToText(item.text || item.content || '');
      
      if ((line.includes('додаток') || line.includes('форма') || line.includes('таблиця')) && 
          text.length > 50) {
        const struNumber = extractAnnexNumber(item.line || '') || String(units.length + 1);
        units.push({
          unit_type: 'annex',
          number: struNumber,
          title: item.line || `Додаток ${struNumber}`,
          text,
          hierarchy: {},
          source: {
            tree_id: item.tree_id,
            id: item.id,
            typ: item.typ,
            typn: item.typn,
            line: item.line,
          },
        });
      }
    }
  }
  
  return units;
}

/**
 * Витягує заголовок з line рядка
 */
function extractTitleFromLine(line: string, number: string): string | null {
  if (!line) return null;
  
  const match = line.match(/Стаття\s+\d+[а-яіїє]?(?:-\d+)?\.?\s*(.+)/i) ||
                line.match(/Пункт\s+\d+\.?\s*(.+)/i) ||
                line.match(/Розділ\s+[IVX\d]+\.?\s*(.+)/i) ||
                line.match(/Глава\s+[IVX\d]+\.?\s*(.+)/i) ||
                line.match(/^\d+\.\s*(.+)/);
  
  if (match && match[1]) {
    return match[1].trim();
  }
  
  return null;
}

/**
 * Витягує назву додатку з line
 */
function extractAnnexTitle(line: string, typn: string): string | null {
  const match = line.match(/Додаток\s+[№\d]*\.?\s*(.+)/i) ||
                line.match(/Форма\s+[№\d]*\.?\s*(.+)/i);
  
  if (match && match[1]) {
    return match[1].trim();
  }
  
  return null;
}

/**
 * Витягує номер додатку з line
 */
function extractAnnexNumber(line: string): string | null {
  const match = line.match(/Додаток\s+[№]?\s*(\d+|[IVX]+)/i) ||
                line.match(/Форма\s+[№]?\s*(\d+)/i);
  
  if (match && match[1]) {
    return match[1].trim();
  }
  
  return null;
}

/**
 * Повертає label для типу unit
 */
function getUnitTypeLabel(unitType: string): string {
  switch (unitType) {
    case 'article': return 'Стаття';
    case 'point': return 'Пункт';
    case 'subpoint': return 'Підпункт';
    case 'paragraph': return 'Параграф';
    case 'chapter': return 'Глава';
    case 'section': return 'Розділ';
    case 'book': return 'Книга';
    case 'part': return 'Частина';
    case 'annex': return 'Додаток';
    case 'form': return 'Форма';
    case 'table': return 'Таблиця';
    default: return 'Елемент';
  }
}
