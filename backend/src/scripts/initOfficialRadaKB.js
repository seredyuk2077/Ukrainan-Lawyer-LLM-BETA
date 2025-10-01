require('dotenv').config();
const radaOfficialApiParser = require('../services/radaOfficialApiParser');
const logger = require('../utils/logger');

async function initKnowledgeBase() {
  try {
    logger.info('🚀 Initializing legal knowledge base with official Rada API...');
    
    const totalLaws = await radaOfficialApiParser.updateDatabase();
    
    logger.info('✅ Knowledge base initialization completed', { 
      totalLaws,
      message: 'Legal knowledge base is ready for use!'
    });
    
    process.exit(0);
  } catch (error) {
    logger.error('❌ Failed to initialize knowledge base:', error);
    process.exit(1);
  }
}

// Запускаємо ініціалізацію
initKnowledgeBase();
