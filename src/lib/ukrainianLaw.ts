export interface LegalCode {
  code: string;
  name: string;
  description: string;
  keywords: string[];
}

export const ukrainianLegalCodes: LegalCode[] = [
  {
    code: 'ККУ',
    name: 'Кримінальний кодекс України',
    description: 'Регулює кримінальні правопорушення та покарання',
    keywords: ['злочин', 'кримінал', 'покарання', 'вбивство', 'крадіжка', 'шахрайство', 'хабар']
  },
  {
    code: 'КПКУ',
    name: 'Кримінальний процесуальний кодекс України',
    description: 'Регулює процедуру розслідування кримінальних справ',
    keywords: ['розслідування', 'слідство', 'суд', 'прокурор', 'адвокат', 'обшук', 'арешт']
  },
  {
    code: 'ЦКУ',
    name: 'Цивільний кодекс України',
    description: 'Регулює цивільні правовідносини між особами',
    keywords: ['договір', 'власність', 'спадщина', 'позов', 'відшкодування', 'купівля', 'продаж']
  },
  {
    code: 'ЦПКУ',
    name: 'Цивільний процесуальний кодекс України',
    description: 'Регулює порядок розгляду цивільних справ у судах',
    keywords: ['позов', 'суд', 'рішення', 'апеляція', 'касація', 'виконання']
  },
  {
    code: 'ГКУ',
    name: 'Господарський кодекс України',
    description: 'Регулює господарські відносини між суб\'єктами підприємництва',
    keywords: ['бізнес', 'підприємство', 'господарство', 'комерція', 'торгівля', 'ФОП']
  },
  {
    code: 'ГПКУ',
    name: 'Господарський процесуальний кодекс України',
    description: 'Регулює порядок розгляду господарських спорів',
    keywords: ['господарський спір', 'комерційний суд', 'банкрутство']
  },
  {
    code: 'КУпАП',
    name: 'Кодекс України про адміністративні правопорушення',
    description: 'Регулює адміністративні правопорушення та відповідальність',
    keywords: ['штраф', 'порушення', 'адміністративне', 'ДАІ', 'поліція', 'протокол']
  },
  {
    code: 'КАСУ',
    name: 'Кодекс адміністративного судочинства України',
    description: 'Регулює порядок розгляду адміністративних справ',
    keywords: ['адміністративний суд', 'оскарження', 'державний орган', 'службовець']
  }
];

export function classifyLegalQuestion(question: string): LegalCode[] {
  const lowerQuestion = question.toLowerCase();
  const matchedCodes: LegalCode[] = [];

  ukrainianLegalCodes.forEach(code => {
    const hasMatch = code.keywords.some(keyword => 
      lowerQuestion.includes(keyword.toLowerCase())
    );
    
    if (hasMatch) {
      matchedCodes.push(code);
    }
  });

  return matchedCodes.length > 0 ? matchedCodes : [ukrainianLegalCodes[2]]; // Default to ЦКУ
}

export function generateLegalContext(question: string): string {
  const relevantCodes = classifyLegalQuestion(question);
  
  let context = `Як досвідчений український юрист Mike Ross, я аналізую ваше питання в контексті:\n\n`;
  
  relevantCodes.forEach(code => {
    context += `**${code.code}** - ${code.name}\n`;
  });
  
  context += `\nНадаю професійну консультацію згідно з українським законодавством:\n\n`;
  
  return context;
}