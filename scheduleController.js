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

        // ── Validate atomic approval ──
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

        // ─ Save all scheduled messages atomically ──
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

        // ─ Return enriched lead data with scheduledAt for frontend countdown ──
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

module.exports = {
    createSchedule,
    getPendingSchedules,
    toggleApproval
};
