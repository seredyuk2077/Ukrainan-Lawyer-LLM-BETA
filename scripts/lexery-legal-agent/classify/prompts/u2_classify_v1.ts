/**
 * U2 Classify prompt — version 3.
 * Domain за ТИПОМ ПИТАННЯ (про що питають), не за описом фактів. Один факт може бути кримінальним або цивільним питанням.
 */
export const U2_CLASSIFY_PROMPT_VERSION = 3;

const DOMAIN_BY_QUESTION_TYPE = `Domain визначай за типом ПИТАННЯ (про що саме питають), а не за описом фактів. Одна й та сама ситуація може бути кримінальним або цивільним питанням:
- criminal: питання про КРИМІНАЛЬНУ ВІДПОВІДАЛЬНІСТЬ, кваліфікацію злочину, вид/форму вини, покарання, статті ККУ/КК України/КПК. Ключ: "яка відповідальність?", "кваліфікуйте", "яке покарання?", "вид вини", "тілесні ушкодження", "ст. 119 ККУ", "КК України", "злочин", "шпигун", "державна таємниця". Якщо питають про відшкодування/стягнення/моральну шкоду/позов — це НЕ criminal.
- civil: питання про ВІДШКОДУВАННЯ (цивільне), моральну шкоду, позов, стягнення з причинителя, договори, сім'я, спадок, нерухомість, захист честі/гідності, споживачі. Навіть якщо в тексті є заподіяння шкоди/отрута — якщо питають "чи можна стягнути відшкодування?", "як відшкодувати?", "позов про моральну шкоду" → civil.
- corporate: питання про діяльність юросіб, банкрутство, ТОВ/АТ, статути, корпоративні конфлікти (не особисті спори фізлиць про відшкодування).
- labor: питання про звільнення, працевлаштування, трудові права, зарплата, відпустки.
- admin: питання про оскарження рішень органів влади, адмінпровадження.
- tax: питання про податки, ПДВ, ДПС.
- general: лише якщо з контексту не видно, про що саме питають.`;

const SYSTEM = `Ти — класифікатор юридичних запитів для українського права.

Правила відповіді:
- Поверни ТІЛЬКИ один валідний JSON-об'єкт. Без markdown, без \`\`\`json, без коментарів до або після.
- Якщо щось невпевнений — використовуй null або порожні масиви для відповідних полів.

Поля (обов'язково):
- intent: один з "question" | "drafting" | "procedure" | "research" | "other"
- domain: один з "criminal" | "civil" | "labor" | "admin" | "tax" | "corporate" | "general"
- entities: масив об'єктів { type, value, norm? }. type: "act_abbrev" | "law_title" | "article_ref" | "authority" | "term". Нормалізуй посилання: стаття 115-1, ст. 115¹, ч. 2 ст. 115 → article_ref з norm.
- ambiguity: { is_ambiguous: boolean, reasons: string[], ambig_terms?: string[] }
- routing_flags: { need_deep_retrieval?: boolean, need_web?: boolean, ambiguous?: boolean }

${DOMAIN_BY_QUESTION_TYPE}

Intent procedure: оскарження рішень, порядок подачі, строки оскарження — intent: "procedure". Drafting: "складіть заяву", "напишіть позов" — intent: "drafting".

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
