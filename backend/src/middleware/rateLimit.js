const rateLimit = require('express-rate-limit');
const { cache } = require('../config/supabase');
const logger = require('../utils/logger');

// Custom store using Redis
class RedisStore {
  constructor(options = {}) {
    this.prefix = options.prefix || 'rl:';
    this.resetTime = options.windowMs || 60000;
  }

  async increment(key) {
    const redisKey = this.prefix + key;
    
    try {
      const current = await cache.get(redisKey) || { count: 0, resetTime: Date.now() + this.resetTime };
      
      // Reset if window expired
      if (Date.now() > current.resetTime) {
        current.count = 0;
        current.resetTime = Date.now() + this.resetTime;
      }
      
      current.count++;
      await cache.set(redisKey, current, Math.ceil(this.resetTime / 1000));
      
      return {
        totalHits: current.count,
        resetTime: new Date(current.resetTime)
      };
    } catch (error) {
      logger.error('Rate limit store error:', error);
      // Fallback to allowing request if Redis fails
      return { totalHits: 1, resetTime: new Date(Date.now() + this.resetTime) };
    }
  }

  async decrement(key) {
    const redisKey = this.prefix + key;
    
    try {
      const current = await cache.get(redisKey);
      if (current && current.count > 0) {
        current.count--;
        await cache.set(redisKey, current, Math.ceil(this.resetTime / 1000));
      }
    } catch (error) {
      logger.error('Rate limit decrement error:', error);
    }
  }

  async resetKey(key) {
    const redisKey = this.prefix + key;
    try {
      await cache.del(redisKey);
    } catch (error) {
      logger.error('Rate limit reset error:', error);
    }
  }
}

// Chat rate limiter - stricter for AI interactions
const chatRateLimit = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000, // 1 minute
  max: parseInt(process.env.RATE_LIMIT_REQUESTS) || 10, // 10 requests per minute
  store: new RedisStore({ prefix: 'chat:', windowMs: 60000 }),
  
  keyGenerator: (req) => {
    // Use IP + User-Agent for better uniqueness
    return `${req.ip}:${req.get('User-Agent') || 'unknown'}`;
  },
  
  message: {
    error: 'Занадто багато запитів. Спробуйте пізніше.',
    retryAfter: 'Повторіть спробу через {{resetTime}} секунд'
  },
  
  standardHeaders: true,
  legacyHeaders: false,
  
  // Custom handler for rate limit exceeded
  handler: (req, res) => {
    const resetTime = Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000);
    
    logger.logSecurity('Rate limit exceeded', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path,
      resetTime
    });
    
    res.status(429).json({
      error: 'Занадто багато запитів',
      message: `Спробуйте через ${resetTime} секунд`,
      retryAfter: resetTime
    });
  },
  
  // Skip rate limiting for health checks
  skip: (req) => {
    return req.path === '/api/v1/health';
  }
});

// General API rate limiter - more lenient
const generalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per 15 minutes
  store: new RedisStore({ prefix: 'api:', windowMs: 15 * 60 * 1000 }),
  
  keyGenerator: (req) => req.ip,
  
  message: {
    error: 'Занадто багато запитів до API',
    retryAfter: 'Повторіть спробу пізніше'
  },
  
  standardHeaders: true,
  legacyHeaders: false,
  
  handler: (req, res) => {
    logger.logSecurity('API rate limit exceeded', {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      path: req.path
    });
    
    res.status(429).json({
      error: 'Занадто багато запитів до API',
      message: 'Повторіть спробу через 15 хвилин'
    });
  }
});

// Session creation rate limiter
const sessionRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 new sessions per hour
  store: new RedisStore({ prefix: 'session:', windowMs: 60 * 60 * 1000 }),
  
  keyGenerator: (req) => req.ip,
  
  message: {
    error: 'Занадто багато нових сесій',
    retryAfter: 'Спробуйте створити нову сесію пізніше'
  },
  
  handler: (req, res) => {
    logger.logSecurity('Session creation rate limit exceeded', {
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    
    res.status(429).json({
      error: 'Занадто багато нових сесій',
      message: 'Спробуйте створити нову сесію через годину'
    });
  }
});

module.exports = {
  chatRateLimit,
  generalRateLimit,
  sessionRateLimit,
  RedisStore
};