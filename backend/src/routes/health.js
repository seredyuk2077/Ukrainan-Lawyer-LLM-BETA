const express = require('express');
const healthCheck = require('../utils/healthcheck');
const logger = require('../utils/logger');

const router = express.Router();

// Health check endpoint
router.get('/', async (req, res) => {
  try {
    const health = await healthCheck();
    
    const statusCode = health.status === 'healthy' ? 200 : 503;
    
    res.status(statusCode).json({
      success: health.status === 'healthy',
      ...health
    });
    
  } catch (error) {
    logger.error('Health check endpoint error:', error);
    
    res.status(503).json({
      success: false,
      status: 'error',
      message: 'Health check failed',
      timestamp: new Date().toISOString()
    });
  }
});

// Liveness probe (simple check)
router.get('/live', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Readiness probe (checks dependencies)
router.get('/ready', async (req, res) => {
  try {
    const { checkDatabaseHealth, checkRedisHealth } = require('../config/database');
    
    const [dbHealth, redisHealth] = await Promise.all([
      checkDatabaseHealth(),
      checkRedisHealth()
    ]);
    
    const isReady = dbHealth.status === 'healthy' && redisHealth.status === 'healthy';
    
    res.status(isReady ? 200 : 503).json({
      success: isReady,
      status: isReady ? 'ready' : 'not ready',
      services: {
        database: dbHealth,
        redis: redisHealth
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Readiness check error:', error);
    
    res.status(503).json({
      success: false,
      status: 'not ready',
      message: 'Readiness check failed',
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;