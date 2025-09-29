const { Pool } = require('pg');
const redis = require('redis');
const logger = require('../utils/logger');

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Redis connection
const redisClient = redis.createClient({
  url: process.env.REDIS_URL,
  retry_strategy: (options) => {
    if (options.error && options.error.code === 'ECONNREFUSED') {
      logger.error('Redis server refused connection');
      return new Error('Redis server refused connection');
    }
    if (options.total_retry_time > 1000 * 60 * 60) {
      logger.error('Redis retry time exhausted');
      return new Error('Retry time exhausted');
    }
    if (options.attempt > 10) {
      logger.error('Redis max retry attempts reached');
      return undefined;
    }
    return Math.min(options.attempt * 100, 3000);
  }
});

// Database connection handlers
pool.on('connect', () => {
  logger.info('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  logger.error('PostgreSQL connection error:', err);
  process.exit(-1);
});

// Redis connection handlers
redisClient.on('connect', () => {
  logger.info('Connected to Redis');
});

redisClient.on('error', (err) => {
  logger.error('Redis connection error:', err);
});

// Initialize Redis connection
redisClient.connect().catch((err) => {
  logger.error('Failed to connect to Redis:', err);
});

// Database query helper
const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Executed query', { text, duration, rows: res.rowCount });
    return res;
  } catch (err) {
    logger.error('Database query error:', { text, error: err.message });
    throw err;
  }
};

// Transaction helper
const transaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// Cache helpers
const cache = {
  async get(key) {
    try {
      const value = await redisClient.get(key);
      return value ? JSON.parse(value) : null;
    } catch (err) {
      logger.error('Cache get error:', err);
      return null;
    }
  },

  async set(key, value, ttl = 3600) {
    try {
      await redisClient.setEx(key, ttl, JSON.stringify(value));
    } catch (err) {
      logger.error('Cache set error:', err);
    }
  },

  async del(key) {
    try {
      await redisClient.del(key);
    } catch (err) {
      logger.error('Cache delete error:', err);
    }
  }
};

// Health check functions
const checkDatabaseHealth = async () => {
  try {
    await pool.query('SELECT 1');
    return { status: 'healthy', message: 'Database connection OK' };
  } catch (err) {
    return { status: 'unhealthy', message: err.message };
  }
};

const checkRedisHealth = async () => {
  try {
    await redisClient.ping();
    return { status: 'healthy', message: 'Redis connection OK' };
  } catch (err) {
    return { status: 'unhealthy', message: err.message };
  }
};

module.exports = {
  pool,
  redisClient,
  query,
  transaction,
  cache,
  checkDatabaseHealth,
  checkRedisHealth
};