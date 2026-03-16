export function isExplicitUserDocumentQuery(query: string): boolean {
  const q = query.toLowerCase();
  return /мо[їє][\p{L}\p{N}_-]*\s+документ[\p{L}\p{N}_-]*|ць(ому|ом)\s+документ[\p{L}\p{N}_-]*|моєму\s+документ[\p{L}\p{N}_-]*|завантажен[\p{L}\p{N}_-]*\s+документ[\p{L}\p{N}_-]*|з\s+мого\s+документ[\p{L}\p{N}_-]*|із\s+мого\s+документ[\p{L}\p{N}_-]*|мо[їє][\p{L}\p{N}_-]*\s+файл[\p{L}\p{N}_-]*|ць(ому|ом)\s+файл[\p{L}\p{N}_-]*|моєму\s+файл[\p{L}\p{N}_-]*|завантажен[\p{L}\p{N}_-]*\s+файл[\p{L}\p{N}_-]*|з\s+мого\s+файл[\p{L}\p{N}_-]*|із\s+мого\s+файл[\p{L}\p{N}_-]*|цього\s+проєкту|цього\s+проекту|мо[їє][\p{L}\p{N}_-]*\s+проєктн[\p{L}\p{N}_-]*\s+таблиц[\p{L}\p{N}_-]*|мо[їє][\p{L}\p{N}_-]*\s+проектн[\p{L}\p{N}_-]*\s+таблиц[\p{L}\p{N}_-]*|у\s+мо[їє][\p{L}\p{N}_-]*\s+таблиц[\p{L}\p{N}_-]*|у\s+мо[їє][\p{L}\p{N}_-]*\s+xlsx|у\s+мо[їє][\p{L}\p{N}_-]*\s+spreadsheet[\p{L}\p{N}_-]*|у\s+завантаженому\s+договор[\p{L}\p{N}_-]*|у\s+цьому\s+договор[\p{L}\p{N}_-]*|у\s+моєму\s+договор[\p{L}\p{N}_-]*|в\s+моєму\s+договор[\p{L}\p{N}_-]*|з\s+мого\s+договор[\p{L}\p{N}_-]*|із\s+мого\s+договор[\p{L}\p{N}_-]*/u.test(q);
}

export function isDocumentUploadIntentQuery(query: string): boolean {
  const q = query.toLowerCase();
  return /завантаж[уюено]|дода[юно]\s+(файл|документ|договір|додаток)|прикріп(ив|лю|лено)|надсилаю\s+(файл|документ|договір)|ось\s+(файл|документ|договір)/u.test(q);
}

export function hasExplicitMemoryRecallRequest(query: string): boolean {
  const q = query.toLowerCase();
  return /(нагадай|згадай|пригадай|що\s+ти\s+пам['’`ʼ]?ятаєш|що\s+пам['’`ʼ]?ятаєш|пам['’`ʼ]?ятаєш\s+про\s+мене|мо[їє]\s+попередн[\p{L}\p{N}_-]*\s+запит[\p{L}\p{N}_-]*|з\s+урахуванням\s+того,\s+що\s+ми\s+обговорювали|з\s+урахуванням\s+нашої\s+розмови|врахуй\s+те,\s+що\s+ми\s+обговорювали)/u.test(q);
}

export function hasExplicitLegalReferenceRequest(query: string): boolean {
  const q = query.toLowerCase();
  return /ст\.|статт|закон|кодекс|норм|кк\b|цк\b|купап|кпк\b|гк\b|цпк\b|гпк\b/.test(q);
}

export type ExplicitMmDocScopeHint = 'conversation' | 'project' | 'user_global' | null;

export function inferExplicitMmDocScope(query: string): ExplicitMmDocScopeHint {
  const q = query.toLowerCase();
  if (
    /цього\s+проєкту|цього\s+проекту|мо[їє][\p{L}\p{N}_-]*\s+проєктн[\p{L}\p{N}_-]*\s+таблиц[\p{L}\p{N}_-]*|мо[їє][\p{L}\p{N}_-]*\s+проектн[\p{L}\p{N}_-]*\s+таблиц[\p{L}\p{N}_-]*|мо[їє][\p{L}\p{N}_-]*\s+документ[\p{L}\p{N}_-]*\s+цього\s+проєкту|мо[їє][\p{L}\p{N}_-]*\s+документ[\p{L}\p{N}_-]*\s+цього\s+проекту/u.test(q)
  ) {
    return 'project';
  }
  if (
    /ць(ому|ом)\s+документ[\p{L}\p{N}_-]*|ць(ому|ом)\s+файл[\p{L}\p{N}_-]*|у\s+цьому\s+договор[\p{L}\p{N}_-]*|у\s+моєму\s+договор[\p{L}\p{N}_-]*|в\s+моєму\s+договор[\p{L}\p{N}_-]*|з\s+мого\s+договор[\p{L}\p{N}_-]*|із\s+мого\s+договор[\p{L}\p{N}_-]*/u.test(q)
  ) {
    return 'conversation';
  }
  if (
    /мо[їє][\p{L}\p{N}_-]*\s+документ[\p{L}\p{N}_-]*|мо[їє][\p{L}\p{N}_-]*\s+файл[\p{L}\p{N}_-]*|завантажен[\p{L}\p{N}_-]*\s+документ[\p{L}\p{N}_-]*|завантажен[\p{L}\p{N}_-]*\s+файл[\p{L}\p{N}_-]*/u.test(q)
  ) {
    return 'user_global';
  }
  return null;
}

export function shouldUseDocsOnlyFastPath(query: string): boolean {
  return isExplicitUserDocumentQuery(query) && !hasExplicitLegalReferenceRequest(query);
}
