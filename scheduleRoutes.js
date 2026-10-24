const express = require('express');
const router = express.Router();
const { createSchedule, getPendingSchedules, toggleApproval } = require('./scheduleController');
const { scheduleSchema } = require('./validationSchemas');
const authMiddleware = require('./authMiddleware'); // Adjust path to your actual auth middleware

// POST /api/leads/schedule - Create new schedule (validates atomic approval)
router.post('/schedule', authMiddleware, scheduleSchema, createSchedule);

// GET /api/leads/schedules/pending - Get user's pending schedules for Review Sheet
router.get('/schedules/pending', authMiddleware, getPendingSchedules);

// PUT /api/leads/schedules/:id/approve - Toggle approval for individual lead
router.put('/schedules/:id/approve', authMiddleware, toggleApproval);

module.exports = router;
