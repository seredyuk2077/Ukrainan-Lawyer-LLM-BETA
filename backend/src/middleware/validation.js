const Joi = require('joi');
const logger = require('../utils/logger');

// Validation schemas
const schemas = {
  sendMessage: Joi.object({
    message: Joi.string()
      .min(1)
      .max(2000)
      .pattern(/^[\u0400-\u04FF\u0500-\u052F\s\d\p{P}\p{S}a-zA-Z]+$/u)
      .required()
      .messages({
        'string.empty': 'Повідомлення не може бути порожнім',
        'string.min': 'Повідомлення занадто коротке',
        'string.max': 'Повідомлення занадто довге (максимум 2000 символів)',
        'string.pattern.base': 'Повідомлення містить недопустимі символи'
      }),
    sessionId: Joi.string()
      .uuid()
      .required()
      .messages({
        'string.uuid': 'Невірний формат ID сесії'
      })
  }),

  createSession: Joi.object({
    userId: Joi.string()
      .max(255)
      .optional(),
    title: Joi.string()
      .max(500)
      .optional()
      .default('Нова консультація')
  }),

  getHistory: Joi.object({
    sessionId: Joi.string()
      .uuid()
      .required()
      .messages({
        'string.uuid': 'Невірний формат ID сесії'
      }),
    limit: Joi.number()
      .integer()
      .min(1)
      .max(100)
      .optional()
      .default(50),
    offset: Joi.number()
      .integer()
      .min(0)
      .optional()
      .default(0)
  })
};

// Validation middleware factory
const validate = (schema, source = 'body') => {
  return (req, res, next) => {
    const data = source === 'params' ? req.params : 
                  source === 'query' ? req.query : req.body;

    const { error, value } = schema.validate(data, {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      const errorMessage = error.details.map(detail => detail.message).join(', ');
      
      logger.logSecurity('Validation failed', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        error: errorMessage,
        data: JSON.stringify(data)
      });

      return res.status(400).json({
        error: 'Помилка валідації',
        details: errorMessage
      });
    }

    // Replace request data with validated data
    if (source === 'params') {
      req.params = value;
    } else if (source === 'query') {
      req.query = value;
    } else {
      req.body = value;
    }

    next();
  };
};

// Content type validation
const validateContentType = (req, res, next) => {
  if (req.method === 'POST' || req.method === 'PUT') {
    if (!req.is('application/json')) {
      return res.status(400).json({
        error: 'Content-Type повинен бути application/json'
      });
    }
  }
  next();
};

// Request size validation
const validateRequestSize = (req, res, next) => {
  const contentLength = parseInt(req.get('Content-Length') || '0');
  const maxSize = 10 * 1024; // 10KB

  if (contentLength > maxSize) {
    logger.logSecurity('Request too large', {
      ip: req.ip,
      contentLength,
      maxSize
    });

    return res.status(413).json({
      error: 'Запит занадто великий'
    });
  }

  next();
};

// Sanitization helpers
const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  
  return input
    .trim()
    .replace(/\s+/g, ' ') // Replace multiple spaces with single space
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // Remove control characters
};

const sanitizeMessage = (req, res, next) => {
  if (req.body.message) {
    req.body.message = sanitizeInput(req.body.message);
  }
  next();
};

module.exports = {
  schemas,
  validate,
  validateContentType,
  validateRequestSize,
  sanitizeMessage,
  sanitizeInput
};