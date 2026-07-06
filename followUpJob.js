// followUpJob.js
const cron = require('node-cron');
const Lead = require('./Lead');
const { sendGmailEmail, isGmailConnected } = require('./gmailService');
const { generateFollowUpSuggestion } = require('./followUpAI');

/**
 * Process a single follow-up email for a lead
 */
async function processFollowUp(lead, userId) {
    try {
        console.log(`📧 [FOLLOW-UP] Processing follow-up for lead: ${lead.email}`);

        // Check if Gmail is still connected
        const isConnected = await isGmailConnected(userId);
        if (!isConnected) {
            console.error(`❌ [FOLLOW-UP] Gmail not connected for user ${userId}`);
            // Disable auto follow-up for this lead
            lead.autoFollowUpEnabled = false;
            lead.followUpScheduledDate = null;
            await lead.save();
            return { success: false, error: 'Gmail not connected' };
        }

        // Get last 2 messages for context
        const lastMessages = (lead.replies || []).slice(-2).map(msg => ({
            from: msg.from,
            content: msg.content,
            date: msg.date
        }));

        // Generate follow-up message using AI
        const followUpMessage = await generateFollowUpSuggestion(
            lastMessages,
            lead.name,
            lead.company || 'the team'
        );

        // Send the email using Gmail API
        const subject = `Following up | ${lead.company || 'our conversation'}`;
        const result = await sendGmailEmail(
            userId,
            lead.email,
            subject,
            followUpMessage
        );

        if (result) {
            // Update lead record
            lead.lastFollowUpSent = new Date();
            lead.followUpCount = (lead.followUpCount || 0) + 1;

            // Schedule next follow-up (3 days later) if still enabled
            if (lead.autoFollowUpEnabled && lead.followUpCount < 5) {
                const nextDate = new Date();
                nextDate.setDate(nextDate.getDate() + 3);
                lead.followUpScheduledDate = nextDate;
            } else {
                // Disable auto follow-up after 5 attempts or if manually disabled
                lead.autoFollowUpEnabled = false;
                lead.followUpScheduledDate = null;
                console.log(`✅ [FOLLOW-UP] Auto follow-up completed (${lead.followUpCount} attempts) for ${lead.email}`);
            }

            // Save the sent message to conversation history
            lead.replies = lead.replies || [];
            lead.replies.push({
                date: new Date(),
                content: followUpMessage,
                subject: subject,
                from: 'ai',
                status: 'sent'
            });

            await lead.save();
            console.log(`✅ [FOLLOW-UP] Sent to ${lead.email} (attempt ${lead.followUpCount}/5)`);
            return { success: true, lead };
        } else {
            console.error(`❌ [FOLLOW-UP] Send failed for ${lead.email}`);
            return { success: false, error: 'Send failed' };
        }
    } catch (err) {
        console.error(`❌ [FOLLOW-UP] Error processing ${lead.email}:`, err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Main job: Find leads that need follow-up and process them
 */
async function processPendingFollowUps() {
    const now = new Date();
    console.log(`🔍 [FOLLOW-UP JOB] Checking for pending follow-ups at ${now.toISOString()}`);

    try {
        // Find leads with auto follow-up enabled and scheduled date <= now
        const pendingLeads = await Lead.find({
            autoFollowUpEnabled: true,
            followUpScheduledDate: { $lte: now }
        }).limit(50);

        if (pendingLeads.length === 0) {
            console.log(`📭 [FOLLOW-UP JOB] No pending follow-ups found`);
            return;
        }

        console.log(`📋 [FOLLOW-UP JOB] Found ${pendingLeads.length} leads needing follow-up`);

        // Group leads by userId
        const leadsByUser = {};
        for (const lead of pendingLeads) {
            const userId = lead.userId.toString();
            if (!leadsByUser[userId]) {
                leadsByUser[userId] = [];
            }
            leadsByUser[userId].push(lead);
        }

        // Process each user's leads
        for (const [userId, leads] of Object.entries(leadsByUser)) {
            console.log(`📋 [FOLLOW-UP JOB] Processing ${leads.length} leads for user ${userId}`);

            // Check if user has Gmail connected
            const isConnected = await isGmailConnected(userId);
            if (!isConnected) {
                console.error(`❌ [FOLLOW-UP JOB] Gmail not connected for user ${userId}, skipping ${leads.length} leads`);
                // Disable auto follow-up for all leads of this user
                for (const lead of leads) {
                    lead.autoFollowUpEnabled = false;
                    lead.followUpScheduledDate = null;
                    await lead.save();
                }
                continue;
            }

            // Process each lead for this user
            for (const lead of leads) {
                await processFollowUp(lead, userId);
                // Small delay between emails to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        console.log(`✅ [FOLLOW-UP JOB] Completed processing`);
    } catch (err) {
        console.error(`❌ [FOLLOW-UP JOB] Fatal error:`, err.message);
    }
}

/**
 * Start the follow-up cron job
 * Runs every hour to check for pending follow-ups
 */
function startFollowUpJob() {
    // Run every hour (at minute 0)
    cron.schedule('0 * * * *', () => {
        processPendingFollowUps();
    });

    // Also run once at startup to catch any missed follow-ups
    setTimeout(() => {
        processPendingFollowUps();
    }, 30000);

    console.log(`⏰ [FOLLOW-UP JOB] Scheduled to run every hour`);
}

module.exports = { startFollowUpJob, processPendingFollowUps };
