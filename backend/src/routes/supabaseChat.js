const express = require('express');
const router = express.Router();
const supabaseChatController = require('../controllers/supabaseChatController');
const rateLimit = require('../middleware/rateLimit');
const validation = require('../middleware/validation');

// Middleware для логування запитів
const logRequest = (req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - IP: ${req.ip}`);
  next();
};

// Middleware для обробки помилок
const errorHandler = (err, req, res, next) => {
  console.error('Route error:', err);
  res.status(500).json({
    error: 'Внутрішня помилка сервера',
    code: 'ROUTE_ERROR'
  });
};

// Застосування middleware
router.use(logRequest);
router.use(express.json({ limit: '10mb' }));
router.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Валідація для створення повідомлення
const sendMessageValidation = validation.validate(validation.schemas.sendMessage);

// Валідація для створення сесії
const createSessionValidation = validation.validate(validation.schemas.createSession);

// Валідація для пошуку законів
const searchLawsValidation = validation.validate(validation.schemas.searchLaws, 'query');

// Основні маршрути чату
router.post('/send', 
  rateLimit.chatRateLimit, // 10 запитів на хвилину
  sendMessageValidation,
  supabaseChatController.sendMessage
);

router.get('/history/:sessionId',
  rateLimit.generalRateLimit, // 30 запитів на хвилину
  supabaseChatController.getHistory
);

router.post('/sessions',
  rateLimit.sessionRateLimit, // 5 запитів на хвилину
  createSessionValidation,
  supabaseChatController.createSession
);

router.get('/sessions/user/:userId',
  rateLimit.generalRateLimit, // 20 запитів на хвилину
  supabaseChatController.getUserSessions
);

router.put('/sessions/:sessionId',
  rateLimit.generalRateLimit, // 10 запитів на хвилину
  supabaseChatController.updateSession
);

router.delete('/sessions/:sessionId',
  rateLimit.sessionRateLimit, // 5 запитів на хвилину
  supabaseChatController.deleteSession
);

// Маршрути для пошуку та роботи з базою знань
router.get('/search/laws',
  rateLimit.generalRateLimit, // 20 запитів на хвилину
  searchLawsValidation,
  supabaseChatController.searchLaws
);

// Адміністративні маршрути
router.get('/admin/stats',
  rateLimit.generalRateLimit, // 5 запитів на хвилину
  supabaseChatController.getStats
);

router.post('/admin/knowledge-base/update',
  rateLimit.generalRateLimit, // 1 запит на 5 хвилин
  supabaseChatController.updateKnowledgeBase
);

router.post('/admin/cache/clear',
  rateLimit.generalRateLimit, // 2 запити на хвилину
  supabaseChatController.clearCache
);

// Маршрут для перевірки здоров'я сервісу
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '2.0.0-supabase',
    features: [
      'Enhanced Legal Agent',
      'RAG (Retrieval-Augmented Generation)',
      'Response Validation',
      'Rada.gov.ua Integration',
      'Intelligent Caching',
      'Token Optimization',
      'Supabase Integration'
    ]
  });
});

// Маршрут для отримання інформації про API
router.get('/info', (req, res) => {
  res.json({
    name: 'Enhanced Legal Chat API (Supabase)',
    version: '2.0.0-supabase',
    description: 'Покращений API для юридичного чат-бота з інтеграцією rada.gov.ua та Supabase',
    endpoints: {
      'POST /send': 'Відправка повідомлення в чат',
      'GET /history/:sessionId': 'Отримання історії розмови',
      'POST /sessions': 'Створення нової сесії',
      'GET /sessions/user/:userId': 'Отримання сесій користувача',
      'PUT /sessions/:sessionId': 'Оновлення сесії',
      'DELETE /sessions/:sessionId': 'Видалення сесії',
      'GET /search/laws': 'Пошук законів',
      'GET /admin/stats': 'Статистика системи',
      'POST /admin/knowledge-base/update': 'Оновлення бази знань',
      'POST /admin/cache/clear': 'Очищення кешу',
      'GET /health': 'Перевірка здоров\'я сервісу',
      'GET /info': 'Інформація про API'
    },
    features: {
      'Legal Knowledge Base': 'База знань з українським законодавством',
      'Rada.gov.ua Integration': 'Інтеграція з офіційним сайтом Верховної Ради',
      'Response Validation': 'Валідація відповідей для мінімізації галюцинацій',
      'Intelligent Caching': 'Розумне кешування для оптимізації',
      'Token Optimization': 'Оптимізація використання токенів',
      'RAG Technology': 'Retrieval-Augmented Generation для точних відповідей',
      'Supabase Integration': 'Інтеграція з Supabase для масштабованості'
    },
    rateLimits: {
      'send': '10 запитів/хвилину',
      'history': '30 запитів/хвилину',
      'sessions': '5-20 запитів/хвилину',
      'search': '20 запитів/хвилину',
      'admin': '1-5 запитів/хвилину'
    },
    database: 'Supabase PostgreSQL',
    cache: 'Supabase Storage + In-Memory'
  });
});

// Обробка неіснуючих маршрутів
router.use('*', (req, res) => {
  res.status(404).json({
    error: 'Маршрут не знайдено',
    code: 'ROUTE_NOT_FOUND',
    availableRoutes: [
      'POST /send',
      'GET /history/:sessionId',
      'POST /sessions',
      'GET /sessions/user/:userId',
      'PUT /sessions/:sessionId',
      'DELETE /sessions/:sessionId',
      'GET /search/laws',
      'GET /admin/stats',
      'POST /admin/knowledge-base/update',
      'POST /admin/cache/clear',
      'GET /health',
      'GET /info'
    ]
  });
});

// Застосування обробника помилок
router.use(errorHandler);

module.exports = router;
