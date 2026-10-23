// aiSuggestionRoutes.js
const express = require('express');
const router = express.Router();
const { verifyToken } = require('./authMiddleware');
const { validate } = require('./validationMiddleware');
const { aiSuggestionSchema } = require('./validationSchemas');
const { suggestOutreach } = require('./aiSuggestionController');

// POST /api/ai/suggest-outreach
// Note: server.js registers this as app.use('/api/ai/suggest-outreach', ...)
// So the full path becomes POST /api/ai/suggest-outreach/suggest-outreach
// We should use '/' here since the prefix is already applied in server.js
router.post('/', verifyToken, validate(aiSuggestionSchema), suggestOutreach);

module.exports = router;
