const express = require('express');
const router = express.Router();
const { createSchedule, getPendingSchedules, toggleApproval } = require('./scheduleController');
const { validate } = require('./validationMiddleware');
const { scheduleSchema } = require('./validationSchemas');
const { verifyToken } = require('./authMiddleware');  // ⭐ DESTRUCTURED

router.post('/schedule', verifyToken, validate(scheduleSchema), createSchedule);
router.get('/schedules/pending', verifyToken, getPendingSchedules);
router.put('/schedules/:id/approve', verifyToken, toggleApproval);

module.exports = router;
