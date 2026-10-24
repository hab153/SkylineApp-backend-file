const express = require('express');
const router = express.Router();
const { createSchedule, getPendingSchedules, toggleApproval } = require('./scheduleController');
const { validate } = require('./validationMiddleware'); // <--- Ensure this is imported
const { scheduleSchema } = require('./validationSchemas');
const authMiddleware = require('./authMiddleware');

// ✅ THIS LINE MUST HAVE validate(scheduleSchema)
router.post('/schedule', authMiddleware, validate(scheduleSchema), createSchedule);

router.get('/schedules/pending', authMiddleware, getPendingSchedules);
router.put('/schedules/:id/approve', authMiddleware, toggleApproval);

module.exports = router;
