const { checkDatabaseHealth, checkRedisHealth } = require('../config/database');
const openaiService = require('../config/openai');
const logger = require('./logger');

async function healthCheck() {
  try {
    const checks = await Promise.allSettled([
      checkDatabaseHealth(),
      checkRedisHealth(),
      openaiService.checkHealth()
    ]);

    const [dbHealth, redisHealth, openaiHealth] = checks.map(result => 
      result.status === 'fulfilled' ? result.value : { status: 'error', message: result.reason.message }
    );

    const overall = dbHealth.status === 'healthy' && 
                   redisHealth.status === 'healthy' && 
                   openaiHealth.status === 'healthy' ? 'healthy' : 'unhealthy';

    const healthStatus = {
      status: overall,
      timestamp: new Date().toISOString(),
      services: {
        database: dbHealth,
        redis: redisHealth,
        openai: openaiHealth
      },
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: process.env.npm_package_version || '1.0.0'
    };

    if (overall === 'unhealthy') {
      logger.error('Health check failed', healthStatus);
      process.exit(1);
    }

    return healthStatus;
  } catch (error) {
    logger.error('Health check error:', error);
    process.exit(1);
  }
}

// If called directly (for Docker health check)
if (require.main === module) {
  healthCheck()
    .then(() => {
      console.log('Health check passed');
      process.exit(0);
    })
    .catch(() => {
      console.error('Health check failed');
      process.exit(1);
    });
}

module.exports = healthCheck;