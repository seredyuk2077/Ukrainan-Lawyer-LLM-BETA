export interface ChatMessage {
  id: string;
  type: 'user' | 'agent';
  content: string;
  timestamp: Date;
}

export interface LegalTemplate {
  id: string;
  title: string;
  description: string;
  category: string;
  content: string;
}

export class LegalAgent {
  private static responses: Record<string, string[]> = {
    contract: [
      "Договір - це правочин двох або більше сторін, спрямований на встановлення, зміну або припинення цивільних прав та обов'язків.",
      "Основні елементи договору: сторони, предмет, ціна (якщо передбачена), строк виконання.",
      "Договір вважається укладеним з моменту досягнення сторонами згоди з усіх істотних умов."
    ],
    property: [
      "Право власності включає право володіння, користування та розпорядження майном.",
      "В Україні існують приватна, державна та комунальна форми власності.",
      "Право власності може бути обмежене законом або договором."
    ],
    inheritance: [
      "Спадкування відбувається за заповітом або за законом.",
      "Строк для прийняття спадщини - 6 місяців з дня відкриття спадщини.",
      "Спадкоємці за законом поділяються на черги в залежності від ступеня споріднення."
    ],
    labor: [
      "Трудовий договір - це угода між працівником і роботодавцем.",
      "Мінімальна заробітна плата встановлюється державою.",
      "Робочий час не може перевищувати 40 годин на тиждень."
    ],
    family: [
      "Шлюб - це сімейний союз жінки та чоловіка.",
      "Майно подружжя може бути спільним або роздільним.",
      "Батьки мають рівні права та обов'язки щодо дітей."
    ]
  };

  static generateResponse(userMessage: string): string {
    const message = userMessage.toLowerCase();
    
    if (message.includes('договір') || message.includes('контракт')) {
      return this.getRandomResponse('contract');
    }
    if (message.includes('власність') || message.includes('майно')) {
      return this.getRandomResponse('property');
    }
    if (message.includes('спадщина') || message.includes('заповіт')) {
      return this.getRandomResponse('inheritance');
    }
    if (message.includes('робота') || message.includes('трудов')) {
      return this.getRandomResponse('labor');
    }
    if (message.includes("сім'я") || message.includes('шлюб') || message.includes('діти')) {
      return this.getRandomResponse('family');
    }
    
    return "Дякую за ваше питання. Як юридичний агент, я можу допомогти вам з питаннями цивільного, трудового, сімейного права та іншими правовими питаннями. Будь ласка, уточніть вашу ситуацію, і я надам більш детальну відповідь.";
  }

  private static getRandomResponse(category: string): string {
    const responses = this.responses[category];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  static getLegalTemplates(): LegalTemplate[] {
    return [
      {
        id: '1',
        title: 'Договір купівлі-продажу',
        description: 'Шаблон договору для купівлі-продажу нерухомості',
        category: 'Цивільне право',
        content: `ДОГОВІР КУПІВЛІ-ПРОДАЖУ

Продавець: _________________
Покупець: _________________
Предмет договору: _________________
Ціна: _________________
Строк передачі: _________________

Підписи сторін:
Продавець: _________________
Покупець: _________________`
      },
      {
        id: '2',
        title: 'Трудовий договір',
        description: 'Базовий шаблон трудового договору',
        category: 'Трудове право',
        content: `ТРУДОВИЙ ДОГОВІР

Роботодавець: _________________
Працівник: _________________
Посада: _________________
Оклад: _________________
Дата початку роботи: _________________

Підписи сторін:
Роботодавець: _________________
Працівник: _________________`
      },
      {
        id: '3',
        title: 'Заповіт',
        description: 'Шаблон заповіту',
        category: 'Спадкове право',
        content: `ЗАПОВІТ

Я, _________________
заповідаю своє майно:
_________________

Спадкоємець: _________________

Дата: _________________
Підпис: _________________`
      }
    ];
  }
}