// followUpJob.js
const cron = require('node-cron');
const Lead = require('./Lead');
const EmailAccount = require('./EmailAccount');
const { sendEmail } = require('./nylasService');
const { refreshNylasToken } = require('./nylasTokenRefresh');
const { generateFollowUpSuggestion } = require('./followUpAI');

/**
 * Process a single follow-up email for a lead
 */
async function processFollowUp(lead, emailAccount, accessToken) {
    try {
        console.log(`📧 [FOLLOW-UP] Processing follow-up for lead: ${lead.email}`);
        
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
        
        // Send the email
        const subject = `Following up | ${lead.company || 'our conversation'}`;
        const result = await sendEmail(
            accessToken,
            lead.email,
            subject,
            followUpMessage
        );
        
        if (result.success) {
            // Update lead record
            lead.lastFollowUpSent = new Date();
            lead.followUpCount = (lead.followUpCount || 0) + 1;
            
            // Schedule next follow-up (3 days later) if still enabled
            if (lead.autoFollowUpEnabled && lead.followUpCount < 5) { // Max 5 follow-ups
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
            console.error(`❌ [FOLLOW-UP] Send failed for ${lead.email}: ${result.error}`);
            return { success: false, error: result.error };
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
        }).limit(50); // Process 50 at a time to avoid overloading
        
        if (pendingLeads.length === 0) {
            console.log(`📭 [FOLLOW-UP JOB] No pending follow-ups found`);
            return;
        }
        
        console.log(`📋 [FOLLOW-UP JOB] Found ${pendingLeads.length} leads needing follow-up`);
        
        // Group leads by userId to reuse email account tokens
        const leadsByUser = {};
        for (const lead of pendingLeads) {
            if (!leadsByUser[lead.userId]) {
                leadsByUser[lead.userId] = [];
            }
            leadsByUser[lead.userId].push(lead);
        }
        
        // Process each user's leads
        for (const [userId, leads] of Object.entries(leadsByUser)) {
            try {
                // Get the user's email account
                const emailAccount = await EmailAccount.findOne({ userId });
                if (!emailAccount) {
                    console.error(`❌ [FOLLOW-UP JOB] No email account for user ${userId}, skipping ${leads.length} leads`);
                    continue;
                }
                
                // Ensure token is valid
                let accessToken = emailAccount.accessToken;
                const isExpired = !emailAccount.tokenExpiry ||
                    new Date() > new Date(emailAccount.tokenExpiry.getTime() - 15 * 60 * 1000);
                
                if (isExpired) {
                    try {
                        console.log(`🔄 [FOLLOW-UP JOB] Refreshing token for user ${userId}`);
                        accessToken = await refreshNylasToken(emailAccount);
                    } catch (refreshErr) {
                        console.error(`❌ [FOLLOW-UP JOB] Token refresh failed for user ${userId}: ${refreshErr.message}`);
                        continue;
                    }
                }
                
                // Process each lead for this user
                for (const lead of leads) {
                    await processFollowUp(lead, emailAccount, accessToken);
                    // Small delay between emails to avoid rate limits
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } catch (userErr) {
                console.error(`❌ [FOLLOW-UP JOB] Error processing user ${userId}:`, userErr.message);
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
    }, 30000); // 30 seconds after startup
    
    console.log(`⏰ [FOLLOW-UP JOB] Scheduled to run every hour`);
}

module.exports = { startFollowUpJob, processPendingFollowUps };
