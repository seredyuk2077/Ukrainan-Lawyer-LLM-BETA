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

export function areCompatiblePrimaryFamilies(
  leftFamily: string | null | undefined,
  rightFamily: string | null | undefined
): boolean {
  const normalizedLeft = toFamilyKey(leftFamily);
  const normalizedRight = toFamilyKey(rightFamily);
  if (
    !normalizedLeft ||
    !normalizedRight ||
    normalizedLeft === 'unknown' ||
    normalizedRight === 'unknown'
  ) {
    return false;
  }
  if (normalizedLeft === normalizedRight) return true;
  if (
    normalizedLeft.startsWith(`${normalizedRight}_`) ||
    normalizedRight.startsWith(`${normalizedLeft}_`)
  ) {
    return true;
  }

  const pair = new Set([normalizedLeft, normalizedRight]);
  if (pair.has('criminal') && pair.has('criminal_procedure')) return true;
  if (pair.has('civil') && pair.has('civil_procedure')) return true;
  if (pair.has('civil') && pair.has('family')) return true;
  if (pair.has('administrative') && pair.has('administrative_offenses')) return true;
  return false;
}

export function hasOnlyCompatiblePrimaryFamilies(familyKeys: Array<string | null | undefined>): boolean {
  const distinctFamilies = [
    ...new Set(familyKeys.map((familyKey) => toFamilyKey(familyKey)).filter((familyKey) => familyKey !== 'unknown')),
  ];
  if (distinctFamilies.length <= 1) return true;
  for (let index = 0; index < distinctFamilies.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < distinctFamilies.length; otherIndex += 1) {
      if (!areCompatiblePrimaryFamilies(distinctFamilies[index], distinctFamilies[otherIndex])) {
        return false;
      }
    }
  }
  return true;
}
