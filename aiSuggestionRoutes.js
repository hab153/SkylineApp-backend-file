// aiSuggestionRoutes.js
const express = require('express');
const router = express.Router();
const { verifyToken } = require('./authMiddleware');
const { validate } = require('./validationMiddleware');
const { aiSuggestionSchema } = require('./validationSchemas');
const { suggestOutreach } = require('./aiSuggestionController');

// POST /api/ai/suggest-outreach
router.post('/suggest-outreach', verifyToken, validate(aiSuggestionSchema), suggestOutreach);

module.exports = router;
