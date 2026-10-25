const ScheduledMessage = require('./ScheduledMessage');

/**
 * POST /api/leads/schedule
 * Validates atomic approval, saves schedule records, returns enriched data for countdown
 */
const createSchedule = async (req, res) => {
    try {
        const userId = req.userId;
        const { 
            scheduledAt, 
            timezone, 
            paceMinutes, 
            safetyRules, 
            leads 
        } = req.body;

        // ─ Validate atomic approval ──
        const unapprovedLeads = leads.filter(lead => !lead.approved);
        
        if (unapprovedLeads.length > 0) {
            return res.status(400).json({
                success: false,
                message: `${unapprovedLeads.length} lead(s) need approval before scheduling`,
                unapprovedCompanies: unapprovedLeads.map(l => l.companyName)
            });
        }

        if (!leads || leads.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No leads provided for scheduling'
            });
        }

        // ── Parse and validate scheduledAt ──
        const scheduleDate = new Date(scheduledAt);
        if (isNaN(scheduleDate.getTime())) {
            return res.status(400).json({
                success: false,
                message: 'Invalid scheduledAt timestamp'
            });
        }

        if (scheduleDate <= new Date()) {
            return res.status(400).json({
                success: false,
                message: 'Scheduled time must be in the future'
            });
        }

        //  Save all scheduled messages atomically ──
        const savedMessages = await Promise.all(
            leads.map(lead => {
                return ScheduledMessage.create({
                    userId,
                    leadEmail: lead.email,
                    companyName: lead.companyName,
                    subject: lead.subject,
                    body: lead.body,
                    scheduledAt: scheduleDate,
                    timezone,
                    paceMinutes: paceMinutes || 5,
                    safetyRules: safetyRules || {
                        stopOnReply: true,
                        stopOnUnsubscribe: true,
                        skipMissingEmail: true
                    },
                    status: 'pending',
                    approved: true
                });
            })
        );

        console.log(`✅ [SCHEDULE] Created ${savedMessages.length} scheduled messages for user ${userId}`);

        //  Return enriched lead data with scheduledAt for frontend countdown ─
        const enrichedLeads = savedMessages.map(msg => ({
            email: msg.leadEmail,
            companyName: msg.companyName,
            scheduledAt: msg.scheduledAt.toISOString(),
            scheduleStatus: msg.status
        }));

        res.status(201).json({
            success: true,
            count: savedMessages.length,
            scheduledAt: scheduleDate.toISOString(),
            leads: enrichedLeads
        });

    } catch (err) {
        console.error('❌ [SCHEDULE] Error creating schedule:', err.message);
        res.status(500).json({
            success: false,
            message: 'Failed to create schedule',
            error: err.message
        });
    }
};

/**
 * GET /api/leads/schedules/pending
 * Returns pending schedules for the current user (for loading into Review Sheet)
 */
const getPendingSchedules = async (req, res) => {
    try {
        const userId = req.userId;

        const schedules = await ScheduledMessage.find({
            userId,
            status: 'pending'
        }).sort({ scheduledAt: 1 });

        res.json({
            success: true,
            count: schedules.length,
            schedules: schedules.map(s => ({
                id: s._id,
                leadEmail: s.leadEmail,
                companyName: s.companyName,
                subject: s.subject,
                body: s.body,
                scheduledAt: s.scheduledAt.toISOString(),
                timezone: s.timezone,
                paceMinutes: s.paceMinutes,
                safetyRules: s.safetyRules,
                approved: s.approved
            }))
        });

    } catch (err) {
        console.error('❌ [SCHEDULE] Error fetching pending schedules:', err.message);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch pending schedules',
            error: err.message
        });
    }
};

/**
 * PUT /api/leads/schedules/:id/approve
 * Toggle approval status for a single scheduled message
 */
const toggleApproval = async (req, res) => {
    try {
        const userId = req.userId;
        const { id } = req.params;
        const { approved } = req.body;

        const message = await ScheduledMessage.findOne({ _id: id, userId });

        if (!message) {
            return res.status(404).json({
                success: false,
                message: 'Scheduled message not found'
            });
        }

        if (message.status !== 'pending') {
            return res.status(400).json({
                success: false,
                message: 'Can only approve pending schedules'
            });
        }

        message.approved = approved;
        await message.save();

        res.json({
            success: true,
            approved: message.approved
        });

    } catch (err) {
        console.error('❌ [SCHEDULE] Error toggling approval:', err.message);
        res.status(500).json({
            success: false,
            message: 'Failed to update approval status',
            error: err.message
        });
    }
};

// ═══════════════════════════════════════════════════════════
// ✅ NEW: AUTOMATION CONTROL HANDLERS
// ═══════════════════════════════════════════════════════════

/**
 * PUT /api/automation/pause
 * Freezes all pending schedules for current user without deleting them
 */
const pauseAllSchedules = async (req, res) => {
    try {
        const userId = req.userId;
        
        const result = await ScheduledMessage.updateMany(
            { userId, status: 'pending' },
            { 
                $set: { 
                    status: 'paused',
                    pausedAt: new Date(),
                    originalScheduledAt: '$scheduledAt' // Preserve original time
                }
            }
        );

        console.log(`⏸️ [AUTOMATION] Paused ${result.modifiedCount} schedules for user ${userId}`);
        
        res.json({
            success: true,
            message: `${result.modifiedCount} schedules paused successfully`,
            pausedCount: result.modifiedCount
        });
    } catch (err) {
        console.error('❌ [AUTOMATION] Pause error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to pause schedules' });
    }
};

/**
 * PUT /api/automation/resume
 * Recalculates send times based on elapsed pause duration
 */
const resumeAllSchedules = async (req, res) => {
    try {
        const userId = req.userId;
        const now = new Date();
        
        // Find all paused messages and calculate offset
        const pausedMessages = await ScheduledMessage.find({ 
            userId, 
            status: 'paused',
            originalScheduledAt: { $ne: null }
        });

        let resumedCount = 0;
        const bulkOps = pausedMessages.map(msg => {
            const pauseDurationMs = now.getTime() - msg.pausedAt.getTime();
            const newScheduledAt = new Date(msg.originalScheduledAt.getTime() + pauseDurationMs);
            
            return {
                updateOne: {
                    filter: { _id: msg._id },
                    update: {
                        $set: {
                            status: 'pending',
                            scheduledAt: newScheduledAt,
                            pausedAt: null,
                            originalScheduledAt: null // Clean up after resume
                        }
                    }
                }
            };
        });

        if (bulkOps.length > 0) {
            const result = await ScheduledMessage.bulkWrite(bulkOps);
            resumedCount = result.modifiedCount;
        }

        console.log(`▶️ [AUTOMATION] Resumed ${resumedCount} schedules for user ${userId}`);
        
        res.json({
            success: true,
            message: `${resumedCount} schedules resumed with adjusted timing`,
            resumedCount
        });
    } catch (err) {
        console.error('❌ [AUTOMATION] Resume error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to resume schedules' });
    }
};

/**
 * DELETE /api/automation/cancel
 * Permanently removes all pending/paused schedules after confirmation
 */
const cancelAllSchedules = async (req, res) => {
    try {
        const userId = req.userId;
        
        const result = await ScheduledMessage.deleteMany({
            userId,
            status: { $in: ['pending', 'paused'] }
        });

        console.log(`🗑️ [AUTOMATION] Cancelled ${result.deletedCount} schedules for user ${userId}`);
        
        res.json({
            success: true,
            message: `${result.deletedCount} schedules permanently cancelled`,
            cancelledCount: result.deletedCount
        });
    } catch (err) {
        console.error('❌ [AUTOMATION] Cancel error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to cancel schedules' });
    }
};

// ✅ UPDATED EXPORTS
module.exports = {
    createSchedule,
    getPendingSchedules,
    toggleApproval,
    pauseAllSchedules,   // NEW
    resumeAllSchedules,  // NEW
    cancelAllSchedules   // NEW
};
