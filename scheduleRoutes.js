const express = require('express');
const router = express.Router();
const { createSchedule, getPendingSchedules, toggleApproval } = require('./scheduleController');
const { validate } = require('./validationMiddleware'); // ✅ Import the validate wrapper
const { scheduleSchema } = require('./validationSchemas');
const authMiddleware = require('./authMiddleware');

// ✅ CORRECT: Wrap scheduleSchema with validate() so it becomes callable middleware
router.post('/schedule', authMiddleware, validate(scheduleSchema), createSchedule);

router.get('/schedules/pending', authMiddleware, getPendingSchedules);
router.put('/schedules/:id/approve', authMiddleware, toggleApproval);

module.exports = router;
