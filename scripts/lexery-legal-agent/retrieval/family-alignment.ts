export function toFamilyKey(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .trim() || 'unknown';
}

export function normalizeDomainHintKey(value: string | null | undefined): string {
  const normalized = (value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .trim();
  if (normalized === 'admin') return 'administrative';
  return normalized;
}

export function isSpecificDomainHint(domainHint: string | null | undefined): boolean {
  const normalized = normalizeDomainHintKey(domainHint);
  return normalized.length > 0 && normalized !== 'general' && normalized !== 'unknown';
}

export function getCompatibleDomainCategoryKeys(domainHint: string | null | undefined): string[] {
  const normalized = normalizeDomainHintKey(domainHint);
  if (!isSpecificDomainHint(normalized)) return [];
  switch (normalized) {
    case 'criminal':
      return ['criminal', 'criminal_procedure'];
    case 'civil':
      return ['civil', 'civil_procedure', 'family'];
    case 'family':
      return ['family', 'civil'];
    case 'administrative':
      return ['administrative', 'administrative_offenses', 'civil_procedure_administrative'];
    case 'tax':
    case 'tax_customs':
      return ['tax_customs', 'tax'];
    case 'labor':
    case 'labor_social':
      return ['labor_social', 'labor'];
    default:
      return [normalized];
  }
}

export function isDomainHintAlignedFamily(
  domainHint: string | null | undefined,
  familyKey: string | null | undefined
): boolean {
  const normalizedFamily = toFamilyKey(familyKey);
  if (normalizedFamily === 'unknown') return false;
  return getCompatibleDomainCategoryKeys(domainHint).some(
    (compatibleFamilyKey) =>
      normalizedFamily === compatibleFamilyKey ||
      normalizedFamily.startsWith(`${compatibleFamilyKey}_`)
  );
}

export function isProceduralFamilyKey(value: string | null | undefined): boolean {
  const familyKey = toFamilyKey(value);
  return familyKey.includes('procedure') || familyKey === 'judiciary_justice';
}
