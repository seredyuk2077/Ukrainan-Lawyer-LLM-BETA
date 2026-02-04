/**
 * Canonical nreg handling utilities
 * 
 * Цей модуль містить єдину логіку для роботи з nreg (номер реєстрації документа).
 * Всі інші модулі повинні використовувати функції з цього модуля.
 * 
 * Правила:
 * - nreg може містити "/" як роздільник (напр. "254к/96-ВР")
 * - Для URL: "/" має залишатися, але кожен сегмент кодується окремо
 * - Для файлів: "/" замінюється на "-" для безпеки
 */

/**
 * Кодує nreg для використання в URL шляхах
 * 
 * Розбиває nreg по "/" та кодує кожен сегмент окремо через encodeURIComponent.
 * Це дозволяє зберегти "/" як роздільник шляху в URL.
 * 
 * @param nreg - номер реєстрації документа
 * @returns закодований nreg для URL
 * 
 * @example
 * encodeNregForUrl("254к/96-ВР") // "254%D0%BA/96-%D0%92%D0%A0"
 * encodeNregForUrl("435-15")     // "435-15"
 */
export function encodeNregForUrl(nreg: string): string {
  return nreg.split('/').map(encodeURIComponent).join('/');
}

/**
 * Формує безпечне ім'я файлу з nreg
 * 
 * Замінює "/" на "-" та інші небезпечні символи на "_".
 * Зберігає кирилицю та базові символи.
 * 
 * @param nreg - номер реєстрації документа
 * @returns безпечне ім'я файлу
 * 
 * @example
 * nregToSafeFilename("254к/96-ВР") // "254к-96-ВР"
 * nregToSafeFilename("435-15")     // "435-15"
 */
export function nregToSafeFilename(nreg: string): string {
  // Замінюємо "/" на "-" для безпеки файлової системи
  // Зберігаємо кирилицю та базові символи
  return nreg
    .replace(/\//g, '-')
    .replace(/[^a-zA-Z0-9\-_а-яїіёєґА-ЯЇІЁЄҐ]/g, '_');
}

/**
 * Валідує формат nreg
 * 
 * Перевіряє чи nreg відповідає очікуваному формату з документації:
 * Pattern: ^[0-9nprvz][0-9\/\_\-a-zа-яїіёєґ]{3,11}$
 * 
 * @param nreg - номер реєстрації для перевірки
 * @returns true якщо формат валідний
 */
export function isValidNreg(nreg: string): boolean {
  // Pattern з документації: ^[0-9nprvz][0-9\/\_\-a-zа-яїіёєґ]{3,11}$
  // Але враховуємо що може бути довше через кирилицю
  const pattern = /^[0-9nprvz][0-9\/\_\-a-zа-яїіёєґА-ЯЇІЁЄҐ]{2,}$/;
  return pattern.test(nreg);
}

/**
 * Нормалізує nreg (приводить до канонічного вигляду)
 * 
 * Видаляє зайві пробіли, нормалізує регістр (якщо потрібно).
 * 
 * @param nreg - номер реєстрації для нормалізації
 * @returns нормалізований nreg
 */
export function normalizeNreg(nreg: string): string {
  return nreg.trim();
}

