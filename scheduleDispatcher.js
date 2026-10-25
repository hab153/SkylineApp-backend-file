const cron = require('node-cron');
const ScheduledMessage = require('./ScheduledMessage');
const { checkAndIncrement } = require('./limitService');
// Import the actual batch-send handler directly to avoid HTTP overhead
const { sendBatchEmails } = require('./leadController'); 

/**
 * Background job that runs every minute to dispatch scheduled emails.
 * Enforces daily limits BEFORE sending, respects pace, and updates status atomically.
 */
function startScheduleDispatcher() {
    // Run every minute
    cron.schedule('* * * * *', async () => {
        try {
            const now = new Date();
            
            // ✅ UPDATED: Only process active 'pending' messages
            // Paused and cancelled messages are automatically excluded
            const dueMessages = await ScheduledMessage.find({
                status: 'pending',
                scheduledAt: { $lte: now }
            }).sort({ scheduledAt: 1 });

            if (dueMessages.length === 0) return;

            console.log(`🕒 [DISPATCHER] Found ${dueMessages.length} due scheduled messages`);

            // Group by userId to enforce per-user limits and pacing
            const userQueues = {};
            for (const msg of dueMessages) {
                if (!userQueues[msg.userId]) userQueues[msg.userId] = [];
                userQueues[msg.userId].push(msg);
            }

            // Process each user's queue sequentially
            for (const [userId, messages] of Object.entries(userQueues)) {
                await processUserQueue(userId, messages);
            }

        } catch (err) {
            console.error('❌ [DISPATCHER] Cron error:', err.message);
        }
    });

    console.log('✅ [DISPATCHER] Schedule dispatcher started (runs every minute)');
}

/**
 * Process a single user's pending queue with limit checks and pace enforcement
 */
async function processUserQueue(userId, messages) {
    let lastSendTime = null;

    for (const message of messages) {
        // ── Pace Throttling ──
        if (lastSendTime && message.paceMinutes > 0) {
            const elapsedMs = Date.now() - lastSendTime.getTime();
            const requiredMs = message.paceMinutes * 60 * 1000;
            
            if (elapsedMs < requiredMs) {
                console.log(`⏳ [DISPATCHER] Pacing: waiting ${Math.ceil((requiredMs - elapsedMs)/1000)}s for user ${userId}`);
                // Skip this message; it will be retried on next cron tick
                continue;
            }
        }

        // ─ Daily Limit Check BEFORE Sending ──
        const limitCheck = await checkAndIncrement(userId, 'email');
        
        if (!limitCheck.allowed) {
            console.warn(` [DISPATCHER] Daily limit reached for user ${userId}. Marking remaining as failed.`);
            
            // Mark THIS message and ALL remaining pending messages for this user as failed
            await markRemainingAsFailed(userId, message._id, 'daily_limit_exhausted');
            return; // Stop processing this user entirely
        }

        // ── Send via Existing Batch Endpoint (Direct Function Call) ──
        try {
            // Construct mock req/res for the existing controller
            const mockReq = {
                userId,
                body: {
                    leads: [{
                        name: message.companyName,
                        email: message.leadEmail,
                        company: message.companyName,
                        messages: [{ subject: message.subject, body: message.body }]
                    }]
                }
            };
            const mockRes = {
                json: () => {},
                status: () => ({ json: () => {} })
            };

            await sendBatchEmails(mockReq, mockRes);

            // Update status to sent
            message.status = 'sent';
            message.failureReason = null;
            await message.save();
            
            lastSendTime = new Date();
            console.log(`✅ [DISPATCHER] Sent scheduled email to ${message.leadEmail} for user ${userId}`);

        } catch (sendErr) {
            console.error(`❌ [DISPATCHER] Failed to send to ${message.leadEmail}:`, sendErr.message);
            
            message.status = 'failed';
            message.failureReason = sendErr.message || 'Unknown send error';
            await message.save();
            
            // Continue to next message (don't block entire queue on single failure)
        }
    }
}

/**
 * Mark current and all remaining pending messages for a user as failed due to limit exhaustion
 */
async function markRemainingAsFailed(userId, currentMessageId, reason) {
    const result = await ScheduledMessage.updateMany(
        { 
            userId, 
            status: 'pending',
            _id: { $gte: currentMessageId } // Only mark current and subsequent
        },
        { 
            status: 'failed', 
            failureReason: reason 
        }
    );
    
    console.log(` [DISPATCHER] Marked ${result.modifiedCount} messages as failed for user ${userId}: ${reason}`);
}

module.exports = { startScheduleDispatcher };
