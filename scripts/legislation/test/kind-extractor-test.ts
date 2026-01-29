/**
 * Тест для kindExtractor
 */

import { extractKindFromPrefix, extractIssuerFromPrefix, DocumentKind, DocumentIssuer } from '../lib/kindExtractor.js';

// Тест для z0572-09
const rawTxt = `ДЕРЖАВНИЙ КОМІТЕТ УКРАЇНИ З ПИТАНЬ РЕГУЛЯТОРНОЇ ПОЛІТИКИ ТА ПІДПРИЄМНИЦТВА МІНІСТЕРСТВО ОХОРОНИ ЗДОРОВ'Я УКРАЇНИ
НАКАЗ
10.06.2009 N 97/415
Зареєстровано в Міністерстві юстиції України 26 червня 2009 р. за N 572/16588
Про визнання таким, що втратив чинність, наказу Державного комітету України з питань регуляторної політики та підприємництва, Міністерства охорони здоров'я України від 27.01.2004 N 03/41
Відповідно до пункту 7 Положення про Державний комітет України з питань регуляторної політики та підприємництва, затвердженого постановою Кабінету Міністрів України від 26.04.2007 N 667 ( 667-2007-п ), та пункту 7 Положення про Міністерство охорони здоров'я України, затвердженого постановою Кабінету Міністрів України від 02.11.2006 N 1542 ( 1542-2006-п ), НАКАЗУЄМО:`;

console.log('=== Тест для z0572-09 ===');
const kind = extractKindFromPrefix(rawTxt, null, null);
console.log('Kind:', kind);
console.log('Expected: NAKAZ');
console.log('Match:', kind === DocumentKind.NAKAZ ? '✅' : '❌');

if (kind === DocumentKind.NAKAZ) {
  const issuer = extractIssuerFromPrefix(rawTxt, null, null, kind);
  console.log('Issuer:', issuer);
  console.log('Expected: COMMITTEE or MINISTRY');
  console.log('Match:', (issuer === DocumentIssuer.COMMITTEE || issuer === DocumentIssuer.MINISTRY) ? '✅' : '❌');
  console.log('Is CMU:', issuer === DocumentIssuer.CMU ? '❌ (WRONG!)' : '✅ (correct)');
}
