/**
 * [U2b] LegalDomainTagger — rule-based baseline (LEX-84)
 */
import type { LegalDomain } from './types.js';

// Act abbreviations and terms → domain. Order matters: tax before admin so "рішення податкової" → tax.
const DOMAIN_RULES: { pattern: RegExp; domain: LegalDomain }[] = [
  { pattern: /(?:^|[\s\W])(ККУ|кримінальний кодекс|кримінал|злочин|вбивство|крадіжка)(?:[\s\W]|$)/i, domain: 'criminal' },
  { pattern: /(?:^|[\s\W])(ЦКУ|цивільний кодекс|цивільний|позов|договір|спадок|право власності|власник|нерухомість|спадщина)(?:[\s\W]|$)/i, domain: 'civil' },
  { pattern: /(?:^|[\s\W])(КЗпП|трудовий|звільнення|прогул|відпустка|працівник)(?:[\s\W]|$)/i, domain: 'labor' },
  { pattern: /(?:^|[\s\W])(ПКУ|податок|податковий|ДПС|ПДВ|податкова|податкової|рішення податкової)(?:[\s\W]|$)/i, domain: 'tax' },
  { pattern: /(?:^|[\s\W])(КАС|адмін|адміністративний|оскаржити рішення)(?:[\s\W]|$)/i, domain: 'admin' },
  { pattern: /(?:^|[\s\W])(корпоративний|ТОВ|АТ|засновник|статут)(?:[\s\W]|$)/i, domain: 'corporate' },
];

export function tagLegalDomain(query: string): LegalDomain {
  const q = query.trim();
  if (!q) return 'general';

  for (const { pattern, domain } of DOMAIN_RULES) {
    if (pattern.test(q)) return domain;
  }

  return 'general';
}
