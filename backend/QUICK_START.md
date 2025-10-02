# 🚀 Швидкий старт - Додавання законів до бази даних

## Одна команда для додавання законів

```bash
node add_laws_to_database.cjs "Назва або номер закону"
```

## Приклади

### За назвою:
```bash
node add_laws_to_database.cjs "Про захист прав споживачів"
```

### За номером:
```bash
node add_laws_to_database.cjs "2135-12"
```

### Кілька законів одночасно:
```bash
node add_laws_to_database.cjs "1023-12" "2135-12" "3425-12"
```

## Як знайти номер закону

1. Відкрийте файл `doc.txt` з правильним кодуванням:
```bash
iconv -f cp1251 -t utf-8 ../docs/api-data/doc.txt | grep -i "назва закону" | head -5
```

2. Якщо не знайшли, спробуйте `ist.txt`:
```bash
iconv -f cp1251 -t utf-8 ../docs/api-data/ist.txt | grep -i "назва закону" | head -3
```

3. Скопіюйте номер з другої колонки (формат: `XXXX-XX`)

## Що робить скрипт

✅ Знаходить закон в базі Rada API  
✅ Завантажує повний текст  
✅ Парсить статті  
✅ Витягує ключові слова  
✅ Визначає категорію  
✅ Зберігає все в базу даних  

## Перевірка результату

```bash
node -e "
const { query } = require('./src/config/supabase');
query('legal_laws', 'select', { select: 'title, articles' })
  .then(r => r.rows.forEach(l => console.log(l.title + ': ' + (l.articles?.length || 0) + ' статей')));
"
```

## Статистика

**База даних містить: 25 документів, 7,438 статей**
