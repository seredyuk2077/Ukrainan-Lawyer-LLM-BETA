/**
 * U2 Classify prompt — version 1.
 * Used by LLM to return structured JSON: intent, domain, entities, ambiguity, routing_flags.
 */
export const U2_CLASSIFY_PROMPT_VERSION = 1;

const SYSTEM = `Ти — класифікатор юридичних запитів для українського права.

Правила відповіді:
- Поверни ТІЛЬКИ один валідний JSON-об'єкт. Без markdown, без \`\`\`json, без коментарів до або після.
- Якщо щось невпевнений — використовуй null або порожні масиви для відповідних полів.

Поля (обов'язково):
- intent: один з "question" | "drafting" | "procedure" | "research" | "other"
- domain: один з "criminal" | "civil" | "labor" | "admin" | "tax" | "corporate" | "general"
- entities: масив об'єктів { type, value, norm? }. type: "act_abbrev" | "law_title" | "article_ref" | "authority" | "term". Нормалізуй посилання: стаття 115-1, ст. 115¹, ч. 2 ст. 115, п. 1 ч. 2 ст. 115, "стаття 115 з позначкою один" → article_ref з norm (наприклад article: "115-1" або article: "115", part: "2").
- ambiguity: { is_ambiguous: boolean, reasons: string[], ambig_terms?: string[] }
- routing_flags: { need_deep_retrieval?: boolean, need_web?: boolean, ambiguous?: boolean }

Intent procedure: запити про оскарження рішень, порядок подачі, строки оскарження, "як оскаржити", "рішення податкової" — завжди intent: "procedure". Drafting: "складіть заяву", "напишіть позов", "підготуйте клопотання" — intent: "drafting".

Абревіатури: ККУ, ЦКУ, КЗпП, КПК, КАС, ПКУ, Конституція. Органи: МВС, СБУ, КМУ, ВРУ.`;

export function buildU2ClassifyPrompt(query: string, preEntitiesJson: string, language?: string): string {
  const lang = language ?? 'uk';
  return `Запит (мова: ${lang}):\n${query}\n\nПопередньо витягнуті кандидати (можна доповнити/нормалізувати):\n${preEntitiesJson}\n\nПоверни один JSON об'єкт з полями intent, domain, entities, ambiguity, routing_flags.`;
}

export function getU2ClassifyMessages(
  query: string,
  preEntitiesJson: string,
  language?: string
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: buildU2ClassifyPrompt(query, preEntitiesJson, language) },
  ];
}
