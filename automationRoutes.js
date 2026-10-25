const express = require('express');
const router = express.Router();
const { verifyToken } = require('./authMiddleware');
const { 
    pauseAllSchedules, 
    resumeAllSchedules, 
    cancelAllSchedules,
    pauseSingleSchedule,    // ✅ NEW
    resumeSingleSchedule,   // ✅ NEW
    deleteSingleSchedule    // ✅ NEW
} = require('./scheduleController');

// Bulk automation routes
router.put('/pause', verifyToken, pauseAllSchedules);
router.put('/resume', verifyToken, resumeAllSchedules);
router.delete('/cancel', verifyToken, cancelAllSchedules);

// ✅ NEW: Per-schedule routes
router.put('/schedule/:id/pause', verifyToken, pauseSingleSchedule);
router.put('/schedule/:id/resume', verifyToken, resumeSingleSchedule);
router.delete('/schedule/:id', verifyToken, deleteSingleSchedule);

module.exports = router;
