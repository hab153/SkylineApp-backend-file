const express = require('express');
const router = express.Router();
const { verifyToken } = require('./authMiddleware');
const { 
    pauseAllSchedules, 
    resumeAllSchedules, 
    cancelAllSchedules 
} = require('./scheduleController');

// All automation routes require valid JWT
router.put('/pause', verifyToken, pauseAllSchedules);
router.put('/resume', verifyToken, resumeAllSchedules);
router.delete('/cancel', verifyToken, cancelAllSchedules);

module.exports = router;
