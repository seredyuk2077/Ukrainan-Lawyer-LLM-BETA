export interface ContractField {
  id: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select';
  required: boolean;
  placeholder?: string;
  options?: string[];
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
  };
}

export interface ContractTemplate {
  id: string;
  name: string;
  description: string;
  fields: ContractField[];
  template: string;
  category: string;
}

export const contractTemplates: ContractTemplate[] = [
  {
    id: 'rental_agreement',
    name: 'Договір оренди житла',
    description: 'Професійний договір оренди квартири або будинку згідно з ЦКУ',
    category: 'Житлове право',
    fields: [
      {
        id: 'landlord_name',
        label: 'ПІБ орендодавця',
        type: 'text',
        required: true,
        placeholder: 'Іваненко Іван Іванович'
      },
      {
        id: 'landlord_passport',
        label: 'Паспортні дані орендодавця',
        type: 'text',
        required: true,
        placeholder: 'паспорт серія АА №123456, виданий 01.01.2010 р.'
      },
      {
        id: 'landlord_address',
        label: 'Адреса реєстрації орендодавця',
        type: 'text',
        required: true,
        placeholder: 'м. Київ, вул. Хрещатик, 1, кв. 5'
      },
      {
        id: 'tenant_name',
        label: 'ПІБ орендаря',
        type: 'text',
        required: true,
        placeholder: 'Петренко Петро Петрович'
      },
      {
        id: 'tenant_passport',
        label: 'Паспортні дані орендаря',
        type: 'text',
        required: true,
        placeholder: 'паспорт серія ВВ №654321, виданий 15.05.2015 р.'
      },
      {
        id: 'tenant_address',
        label: 'Адреса реєстрації орендаря',
        type: 'text',
        required: true,
        placeholder: 'м. Київ, вул. Шевченка, 10, кв. 15'
      },
      {
        id: 'property_address',
        label: 'Адреса об\'єкта оренди',
        type: 'text',
        required: true,
        placeholder: 'м. Київ, вул. Хрещатик, 1, кв. 10'
      },
      {
        id: 'property_area',
        label: 'Загальна площа (кв.м)',
        type: 'number',
        required: true,
        placeholder: '65',
        validation: { min: 10, max: 500 }
      },
      {
        id: 'rental_price',
        label: 'Орендна плата (грн/міс)',
        type: 'number',
        required: true,
        placeholder: '15000',
        validation: { min: 1000, max: 100000 }
      },
      {
        id: 'deposit',
        label: 'Застава (грн)',
        type: 'number',
        required: true,
        placeholder: '15000',
        validation: { min: 0, max: 200000 }
      },
      {
        id: 'utilities_included',
        label: 'Комунальні послуги',
        type: 'select',
        required: true,
        options: ['включені в орендну плату', 'сплачуються окремо орендарем', 'розподіляються порівну']
      },
      {
        id: 'start_date',
        label: 'Дата початку оренди',
        type: 'date',
        required: true
      },
      {
        id: 'end_date',
        label: 'Дата закінчення оренди',
        type: 'date',
        required: true
      },
      {
        id: 'payment_day',
        label: 'День сплати (число місяця)',
        type: 'number',
        required: true,
        placeholder: '5',
        validation: { min: 1, max: 28 }
      }
    ],
    template: `ДОГОВІР ОРЕНДИ ЖИТЛА № ___

м. Київ                                                           {{start_date}}

{{landlord_name}}, {{landlord_passport}}, зареєстрований за адресою: {{landlord_address}} (надалі - "Орендодавець"), з однієї сторони, та {{tenant_name}}, {{tenant_passport}}, зареєстрований за адресою: {{tenant_address}} (надалі - "Орендар"), з іншої сторони, уклали цей договір про наступне:

1. ПРЕДМЕТ ДОГОВОРУ

1.1. Орендодавець передає, а Орендар приймає в тимчасове платне користування житлове приміщення - квартиру, розташовану за адресою: {{property_address}}.

1.2. Загальна площа житлового приміщення становить {{property_area}} кв.м.

1.3. Житлове приміщення передається в належному для проживання стані, з наявним обладнанням та меблями згідно з актом приймання-передачі.

2. СТРОК ДІЇ ДОГОВОРУ

2.1. Договір укладається на строк з {{start_date}} по {{end_date}}.

2.2. Договір може бути продовжений за взаємною згодою сторін.

3. РОЗМІР ТА ПОРЯДОК ВНЕСЕННЯ ОРЕНДНОЇ ПЛАТИ

3.1. Орендна плата становить {{rental_price}} ({{rental_price_words}}) гривень на місяць.

3.2. Орендна плата вноситься щомісяця до {{payment_day}} числа поточного місяця шляхом перерахування на банківський рахунок Орендодавця або готівкою.

3.3. Комунальні послуги (електроенергія, газ, водопостачання, опалення) {{utilities_included}}.

3.4. Орендар сплачує заставу в розмірі {{deposit}} гривень, яка повертається при розірванні договору за умови відсутності заборгованості та збереження майна в належному стані.

4. ПРАВА ТА ОБОВ'ЯЗКИ ОРЕНДОДАВЦЯ

4.1. Орендодавець має право:
- вимагати своєчасного внесення орендної плати;
- контролювати використання житла за призначенням;
- розірвати договір у випадках, передбачених законом.

4.2. Орендодавець зобов'язується:
- передати житло в належному стані;
- не втручатися в користування житлом Орендарем;
- своєчасно проводити капітальний ремонт за власний рахунок;
- забезпечити Орендарю мирне володіння житлом.

5. ПРАВА ТА ОБОВ'ЯЗКИ ОРЕНДАРЯ

5.1. Орендар має право:
- користуватися житлом за призначенням;
- вимагати усунення недоліків житла Орендодавцем;
- розірвати договір з повідомленням за 1 місяць.

5.2. Орендар зобов'язується:
- своєчасно вносити орендну плату;
- підтримувати житло в належному стані;
- не здавати житло в суборенду без письмової згоди Орендодавця;
- не проводити перепланування без згоди Орендодавця;
- повернути житло в тому стані, в якому отримав.

6. ВІДПОВІДАЛЬНІСТЬ СТОРІН

6.1. За несвоєчасну сплату орендної плати Орендар сплачує пеню 0,1% за кожен день прострочення.

6.2. За пошкодження майна Орендар відшкодовує збитки в повному обсязі.

6.3. Сторони несуть відповідальність згідно з чинним законодавством України.

7. РОЗІРВАННЯ ДОГОВОРУ

7.1. Договір може бути розірваний:
- за взаємною згодою сторін;
- в односторонньому порядку з повідомленням за 1 місяць;
- в судовому порядку при істотному порушенні умов.

8. ОСОБЛИВІ УМОВИ

8.1. Усі зміни та доповнення до договору оформлюються письмово.

8.2. Спори вирішуються шляхом переговорів, а при недосягненні згоди - в судовому порядку.

9. ЗАКЛЮЧНІ ПОЛОЖЕННЯ

9.1. Договір складено у двох примірниках, які мають однакову юридичну силу, по одному для кожної сторони.

9.2. Договір набирає чинності з моменту підписання.

РЕКВІЗИТИ ТА ПІДПИСИ СТОРІН:

Орендодавець:                              Орендар:
{{landlord_name}}                          {{tenant_name}}

_____________________                      _____________________
      (підпис)                                (підпис)

Дата: _______________                      Дата: _______________`
  },
  {
    id: 'employment_contract',
    name: 'Трудовий договір',
    description: 'Трудовий договір згідно з КЗпП України',
    category: 'Трудове право',
    fields: [
      {
        id: 'employer_name',
        label: 'Найменування роботодавця',
        type: 'text',
        required: true,
        placeholder: 'ТОВ "Компанія"'
      },
      {
        id: 'employer_director',
        label: 'ПІБ директора',
        type: 'text',
        required: true,
        placeholder: 'Іваненко Іван Іванович'
      },
      {
        id: 'employee_name',
        label: 'ПІБ працівника',
        type: 'text',
        required: true,
        placeholder: 'Петренко Петро Петрович'
      },
      {
        id: 'position',
        label: 'Посада',
        type: 'text',
        required: true,
        placeholder: 'Менеджер з продажу'
      },
      {
        id: 'salary',
        label: 'Заробітна плата (грн)',
        type: 'number',
        required: true,
        placeholder: '25000',
        validation: { min: 6700, max: 500000 }
      },
      {
        id: 'start_work_date',
        label: 'Дата початку роботи',
        type: 'date',
        required: true
      }
    ],
    template: `ТРУДОВИЙ ДОГОВІР № ___

м. Київ                                                           {{start_work_date}}

{{employer_name}} в особі директора {{employer_director}} (надалі - "Роботодавець"), з однієї сторони, та {{employee_name}} (надалі - "Працівник"), з іншої сторони, уклали цей трудовий договір про наступне:

1. ПРЕДМЕТ ДОГОВОРУ

1.1. Працівник зобов'язується виконувати роботу за посадою "{{position}}" згідно з посадовою інструкцією.

1.2. Працівник підпорядковується правилам внутрішнього трудового розпорядку.

2. СТРОК ДОГОВОРУ

2.1. Договір укладається на невизначений строк з {{start_work_date}}.

3. ОПЛАТА ПРАЦІ

3.1. Заробітна плата становить {{salary}} гривень на місяць.

3.2. Заробітна плата виплачується двічі на місяць.

РОБОТОДАВЕЦЬ: {{employer_director}}    _____________

ПРАЦІВНИК: {{employee_name}}           _____________`
  }
];

export function generateContract(templateId: string, data: Record<string, string>): string {
  const template = contractTemplates.find(t => t.id === templateId);
  if (!template) return '';

  let result = template.template;
  
  // Replace placeholders with actual data
  Object.entries(data).forEach(([key, value]) => {
    const placeholder = new RegExp(`{{${key}}}`, 'g');
    result = result.replace(placeholder, value);
  });

  // Convert numbers to words for rental price
  if (data.rental_price) {
    const priceInWords = convertNumberToWords(parseInt(data.rental_price));
    result = result.replace(/{{rental_price_words}}/g, priceInWords);
  }

  return result;
}

function convertNumberToWords(num: number): string {
  const ones = ['', 'одна', 'дві', 'три', 'чотири', 'п\'ять', 'шість', 'сім', 'вісім', 'дев\'ять'];
  const tens = ['', '', 'двадцять', 'тридцять', 'сорок', 'п\'ятдесят', 'шістдесят', 'сімдесят', 'вісімдесят', 'дев\'яносто'];
  const hundreds = ['', 'сто', 'двісті', 'триста', 'чотириста', 'п\'ятсот', 'шістсот', 'сімсот', 'вісімсот', 'дев\'ятсот'];
  const thousands = ['', 'одна тисяча', 'дві тисячі', 'три тисячі', 'чотири тисячі', 'п\'ять тисяч'];

  if (num === 0) return 'нуль';
  if (num < 10) return ones[num];
  if (num < 100) {
    const ten = Math.floor(num / 10);
    const one = num % 10;
    if (num >= 10 && num <= 19) {
      const teens = ['десять', 'одинадцять', 'дванадцять', 'тринадцять', 'чотирнадцять', 'п\'ятнадцять', 'шістнадцять', 'сімнадцять', 'вісімнадцять', 'дев\'ятнадцять'];
      return teens[num - 10];
    }
    return tens[ten] + (one > 0 ? ' ' + ones[one] : '');
  }
  if (num < 1000) {
    const hundred = Math.floor(num / 100);
    const remainder = num % 100;
    return hundreds[hundred] + (remainder > 0 ? ' ' + convertNumberToWords(remainder) : '');
  }
  if (num < 100000) {
    const thousand = Math.floor(num / 1000);
    const remainder = num % 1000;
    let result = '';
    
    if (thousand < 5) {
      result = thousands[thousand];
    } else {
      result = convertNumberToWords(thousand) + ' тисяч';
    }
    
    return result + (remainder > 0 ? ' ' + convertNumberToWords(remainder) : '');
  }
  
  return num.toString(); // Fallback for very large numbers
}

export function validateContractData(templateId: string, data: Record<string, string>): string[] {
  const template = contractTemplates.find(t => t.id === templateId);
  if (!template) return ['Шаблон не знайдено'];

  const errors: string[] = [];

  template.fields.forEach(field => {
    const value = data[field.id];
    
    if (field.required && (!value || value.trim() === '')) {
      errors.push(`Поле "${field.label}" є обов'язковим`);
      return;
    }

    if (value && field.validation) {
      if (field.type === 'number') {
        const numValue = parseFloat(value);
        if (field.validation.min && numValue < field.validation.min) {
          errors.push(`${field.label} не може бути менше ${field.validation.min}`);
        }
        if (field.validation.max && numValue > field.validation.max) {
          errors.push(`${field.label} не може бути більше ${field.validation.max}`);
        }
      }
    }
  });

  return errors;
}