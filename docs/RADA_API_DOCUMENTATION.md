# 📚 ДОКУМЕНТАЦІЯ RADA API - data.rada.gov.ua

## 🎯 **ОСНОВНА ІНФОРМАЦІЯ**

**Базовий URL:** `https://data.rada.gov.ua`
**API для законів:** `https://data.rada.gov.ua/laws/`

## 🔑 **АВТОРИЗАЦІЯ ТА ТОКЕНИ**

### Отримання токену:
```
GET https://data.rada.gov.ua/api/token
Headers: User-Agent: OpenData
```

**Токен діє:** 86400 секунд (24 години) з 0:00 по 23:59 кожного дня

### Використання токену:
- **JSON запити:** `User-Agent: [отриманий_токен]`
- **Інші формати:** `User-Agent: OpenData`

## 📊 **ЛІМІТИ API**

- **Запитів на хвилину:** до 60 (рекомендовано пауза 5-7 секунд)
- **Запитів на день:** до 100,000
- **Байтів на день:** до 200MB
- **Сторінок на день:** до 800,000 (1 сторінка ≈ 40-50KB)

**Перевірка лімітів:** `https://data.rada.gov.ua/api/limits`

## 📄 **ФОРМАТИ ДОКУМЕНТІВ**

| Тип | Формат | URL |
|-----|--------|-----|
| **Документи** | | |
| Текст документа | HTML | `https://data.rada.gov.ua/laws/show/nreg` |
| Картка документа | HTML | `https://data.rada.gov.ua/laws/card/nreg` |
| Документ повністю | JSON | `https://data.rada.gov.ua/laws/show/nreg.json` |
| Картка документа | JSON | `https://data.rada.gov.ua/laws/card/nreg.json` |
| Чистий текст | TXT | `https://data.rada.gov.ua/laws/show/nreg.txt` |
| **Списки документів** | | |
| Поновлені документи | HTML | `https://data.rada.gov.ua/laws/main/r` |
| Найновіші (за день) | HTML | `https://data.rada.gov.ua/laws/main/nn` |
| Нові (30 днів) | HTML | `https://data.rada.gov.ua/laws/main/n` |
| Всі документи | HTML | `https://data.rada.gov.ua/laws/main/a[/page1]` |
| NREG номери | TXT | `https://data.rada.gov.ua/laws/main/r.txt` |
| DOKID номери | JSON | `https://data.rada.gov.ua/laws/main/r/docs.json` |
| Поновлені з реквізитами | JSON | `https://data.rada.gov.ua/laws/main/r[/page1].json` |
| RSS поновлені | XML | `https://data.rada.gov.ua/laws/main/r.xml` |
| Картки та посилання | TSV | `https://data.rada.gov.ua/laws/main/r.tsv` |

## 🏗️ **СТРУКТУРА ДАНИХ**

### Основні поля документа:

#### **Картка документа (doc):**
- `dokid` - Ідентифікатор документа (integer)
- `nreg` - Системний номер документа (string, pattern: `^[0-9nprvz][0-9\/\_\-a-zа-яїіёєґ]{3,11}$`)
- `nazva` - Назва документа (string)
- `status` - Стан документа (object)
- `types` - Види документа (array)
- `organs` - Видавники документа (object)
- `minjust` - Реєстрація документа (object)
- `datred` - Дата поточної редакції (date)

#### **Структура документа (stru):**
- `id` - Ідентифікатор структури (string, pattern: `^[on](\d+)$`)
- `tree_id` - Ідентифікатор структурного елемента (string)
- `pos` - Позиція в тексті (integer)
- `len` - Розмір в символах (integer)
- `page` - Номер сторінки (integer)
- `parent` - Ідентифікатор "батьківського" елементу (string)
- `level` - Рівень структури в дереві (integer)
- `line` - Рядок для відображення структури (string)
- `stru` - Номер статті/пункту/підпункту (string)
- `text` - Оригінал тексту абзацу в HTML (string)
- `typ` - Ідентифікатор типу (2 символи)
- `typn` - Ідентифікатор типу (3 символи)

### Типи структурних елементів:
- `ST` - Стаття
- `GL` - Глава
- `RZ` - Розділ
- `PR` - Пункт
- `FR` - Підпункт
- `CH` - Частина
- `PU` - Пункт
- `PP` - Підпункт

## 🔍 **СТРАТЕГІЯ ПОШУКУ ЗАКОНІВ**

### 1. **Пошук в нових документах (30 днів):**
```
GET https://data.rada.gov.ua/laws/main/n.json
Headers: User-Agent: [токен]
```

### 2. **Пошук в оновлених документах:**
```
GET https://data.rada.gov.ua/laws/main/r.json
Headers: User-Agent: [токен]
```

### 3. **Отримання конкретного закону:**
```
GET https://data.rada.gov.ua/laws/show/nreg.json
Headers: User-Agent: [токен]
```

### 4. **Отримання тексту закону:**
```
GET https://data.rada.gov.ua/laws/show/nreg.txt
Headers: User-Agent: OpenData
```

## 💡 **ПРИКЛАДИ ВИКОРИСТАННЯ**

### JavaScript/Node.js:
```javascript
// Отримання токену
const tokenResponse = await fetch('https://data.rada.gov.ua/api/token', {
  headers: { 'User-Agent': 'OpenData' }
});
const tokenData = await tokenResponse.json();
const token = tokenData.token;

// Пошук нових документів
const newDocsResponse = await fetch('https://data.rada.gov.ua/laws/main/n.json', {
  headers: {
    'User-Agent': token,
    'Accept': 'application/json'
  }
});
const newDocs = await newDocsResponse.json();

// Отримання конкретного закону
const lawResponse = await fetch('https://data.rada.gov.ua/laws/show/435-15.json', {
  headers: {
    'User-Agent': token,
    'Accept': 'application/json'
  }
});
const law = await lawResponse.json();
```

### Python:
```python
import requests

# Отримання токену
token_response = requests.get('https://data.rada.gov.ua/api/token', 
                            headers={'User-Agent': 'OpenData'})
token = token_response.json()['token']

# Пошук нових документів
new_docs_response = requests.get('https://data.rada.gov.ua/laws/main/n.json',
                                headers={'User-Agent': token})
new_docs = new_docs_response.json()
```

## ⚠️ **ВАЖЛИВІ ЗАУВАЖЕННЯ**

1. **Не звертайтесь за токеном перед кожним запитом** - IP буде заблоковано
2. **Використовуйте паузи 5-7 секунд** між запитами
3. **Перевіряйте Last-Modified заголовок** для оптимізації
4. **Не запам'ятовуйте прямі шляхи** - файли можуть змінити місце
5. **Спочатку отримуйте паспорт**, потім завантажуйте дані

## 🎯 **РЕКОМЕНДОВАНА СТРАТЕГІЯ ДЛЯ AI СИСТЕМИ**

1. **Аналіз питання** → визначення ключових слів
2. **Пошук в нових документах** → `/laws/main/n.json`
3. **Пошук в оновлених документах** → `/laws/main/r.json`
4. **Фільтрація по назві** → перевірка `nazva` на ключові слова
5. **Завантаження повного тексту** → `/laws/show/nreg.json`
6. **Парсинг структури** → витягування статей з `stru` масиву
7. **Фільтрація релевантних статей** → пошук ключових слів в `text`
8. **Збереження в базу** → для майбутнього використання

## 📋 **ПОЛЯ ДЛЯ ЗБЕРЕЖЕННЯ В БАЗУ**

- `id` - dokid з API
- `title` - nazva з API
- `law_number` - nreg з API
- `document_type` - визначити по назві
- `source_url` - https://data.rada.gov.ua/laws/show/nreg
- `content` - повний текст з stru
- `articles` - масив статей з stru (typ='ST')
- `keywords` - ключові слова для пошуку
- `created_at` - дата створення
- `updated_at` - дата оновлення
