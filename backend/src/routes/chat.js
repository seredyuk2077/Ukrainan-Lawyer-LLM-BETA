const express = require('express');
const chatController = require('../controllers/chatController');
const { validate, schemas, sanitizeMessage } = require('../middleware/validation');
const { chatRateLimit, sessionRateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// Send message to chat
router.post('/message', 
  chatRateLimit,
  sanitizeMessage,
  validate(schemas.sendMessage),
  chatController.sendMessage
);

// Get chat history
router.get('/history/:sessionId',
  validate(schemas.getHistory, 'params'),
  chatController.getHistory
);

// Create new session
router.post('/session',
  sessionRateLimit,
  validate(schemas.createSession),
  chatController.createSession
);

// Update session
router.put('/session/:sessionId',
  validate({ sessionId: schemas.getHistory.extract('sessionId') }, 'params'),
  validate(schemas.createSession),
  chatController.updateSession
);

// Delete session
router.delete('/session/:sessionId',
  validate({ sessionId: schemas.getHistory.extract('sessionId') }, 'params'),
  chatController.deleteSession
);

// Get user sessions
router.get('/sessions/:userId',
  validate({
    userId: schemas.createSession.extract('userId').required(),
    ...schemas.getHistory.extract(['limit', 'offset'])
  }, 'params'),
  chatController.getUserSessions
);

// Get statistics (admin endpoint)
router.get('/stats',
  chatController.getStats
);

module.exports = router;