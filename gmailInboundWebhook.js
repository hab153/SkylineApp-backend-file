const { google } = require('googleapis');
const User = require('./User');
const Lead = require('./Lead');
const Notification = require('./Notification');
const { getGmailClient } = require('./gmailService');

/**
 * Process a new inbound email from Gmail watch notification
 * This is called when Gmail sends a push notification about a new email
 */
async function processInboundEmail(userId, messageId) {
    try {
        console.log(`📩 [GMAIL INBOUND] Processing email ${messageId} for user ${userId}`);

        const gmail = await getGmailClient(userId);

        // Get the email message
        const response = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'full'
        });

        const message = response.data;
        const headers = message.payload.headers;

        // Extract email details
        const from = headers.find(h => h.name === 'From')?.value || '';
        const to = headers.find(h => h.name === 'To')?.value || '';
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const date = headers.find(h => h.name === 'Date')?.value || '';

        // Extract email body
        let body = '';
        if (message.payload.parts) {
            // Multipart email
            for (const part of message.payload.parts) {
                if (part.mimeType === 'text/plain' && part.body?.data) {
                    body = Buffer.from(part.body.data, 'base64').toString('utf-8');
                    break;
                }
                if (part.mimeType === 'text/html' && part.body?.data) {
                    body = Buffer.from(part.body.data, 'base64').toString('utf-8');
                    // Strip HTML tags for plain text
                    body = body.replace(/<[^>]*>/g, '');
                    break;
                }
            }
        } else if (message.payload.body?.data) {
            body = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
        }

        // Extract email address from "From" header
        const emailMatch = from.match(/<([^>]+)>/);
        const senderEmail = emailMatch ? emailMatch[1] : from.trim();

        // Find the lead by email
        const lead = await Lead.findOne({
            userId: userId,
            email: senderEmail
        });

        if (!lead) {
            console.log(`⚠️ [GMAIL INBOUND] No lead found for email: ${senderEmail}`);
            return;
        }

        // Add reply to lead
        lead.replies = lead.replies || [];
        lead.replies.push({
            from: from,
            subject: subject,
            body: body,
            receivedAt: new Date(),
            isRead: false,
            messageId: messageId
        });
        lead.lastContactDate = new Date();
        lead.status = 'Replied';
        await lead.save();

        // Create notification
        await Notification.create({
            userId: userId,
            type: 'lead_reply',
            content: `New reply from ${from}: ${subject}`,
            leadId: lead._id,
            isRead: false,
            createdAt: new Date()
        });

        console.log(`✅ [GMAIL INBOUND] Processed reply from ${senderEmail} for lead ${lead.name}`);

        // Trigger auto-reply if enabled
        if (lead.autoReplyEnabled) {
            await triggerAutoReply(userId, lead, from, subject, body);
        }

    } catch (error) {
        console.error('❌ [GMAIL INBOUND] Error processing email:', error.message);
        throw error;
    }
}

/**
 * Trigger auto-reply for a lead
 */
async function triggerAutoReply(userId, lead, to, originalSubject, originalBody) {
    try {
        console.log(`🤖 [GMAIL INBOUND] Triggering auto-reply for lead ${lead.email}`);

        const user = await User.findById(userId);
        if (!user) {
            console.error('❌ [GMAIL INBOUND] User not found');
            return;
        }

        // Check auto-reply limit
        const tier = user.subscriptionTier || 'free';
        const limits = { free: 0, go: 20, pro: 100 };
        const limit = limits[tier] || 0;

        if (limit === 0) {
            console.log(`⚠️ [GMAIL INBOUND] Auto-reply not available for ${tier} plan`);
            return;
        }

        // Check daily limit
        if (!user.usage) user.usage = {};
        if (user.usage.dailyAutoReplyCount === undefined) user.usage.dailyAutoReplyCount = 0;
        if (!user.usage.lastAutoReplyDate) user.usage.lastAutoReplyDate = null;

        const today = new Date().toDateString();
        const lastDateStr = user.usage.lastAutoReplyDate ? new Date(user.usage.lastAutoReplyDate).toDateString() : null;
        if (lastDateStr !== today) {
            user.usage.dailyAutoReplyCount = 0;
            user.usage.lastAutoReplyDate = new Date();
            await user.save();
        }

        if (user.usage.dailyAutoReplyCount >= limit) {
            console.log(`⚠️ [GMAIL INBOUND] Auto-reply limit reached for user (${limit})`);
            return;
        }

        // Generate AI reply
        const { generateAIReply } = require('./aiReplyGenerator');
        const reply = await generateAIReply(originalSubject, originalBody, lead.autoReplyInstructions);

        if (!reply) {
            console.log(`⚠️ [GMAIL INBOUND] No auto-reply generated`);
            return;
        }

        // Send the auto-reply
        const { sendGmailEmail } = require('./gmailService');
        await sendGmailEmail(
            userId,
            to,
            `Re: ${originalSubject}`,
            reply
        );

        // Increment counter
        user.usage.dailyAutoReplyCount += 1;
        await user.save();

        console.log(`✅ [GMAIL INBOUND] Auto-reply sent to ${lead.email}`);

    } catch (error) {
        console.error('❌ [GMAIL INBOUND] Auto-reply error:', error.message);
    }
}

/**
 * Setup Gmail watch for a user
 * This enables push notifications for new emails
 */
async function setupGmailWatch(userId) {
    try {
        console.log(`🔔 [GMAIL INBOUND] Setting up Gmail watch for user ${userId}`);

        const gmail = await getGmailClient(userId);

        const response = await gmail.users.watch({
            userId: 'me',
            requestBody: {
                labelIds: ['INBOX'],
                topicName: process.env.GMAIL_PUBSUB_TOPIC || 'projects/your-project/topics/gmail-watch'
            }
        });

        // Store watch expiration
        const user = await User.findById(userId);
        if (user) {
            user.gmailIntegration = user.gmailIntegration || {};
            user.gmailIntegration.watchExpiration = response.data.expiration
                ? new Date(parseInt(response.data.expiration))
                : null;
            user.gmailIntegration.historyId = response.data.historyId;
            await user.save();
        }

        console.log(`✅ [GMAIL INBOUND] Gmail watch setup for user ${userId}`);
        return response.data;

    } catch (error) {
        console.error('❌ [GMAIL INBOUND] Setup watch error:', error.message);
        throw error;
    }
}

/**
 * Handle Gmail push notification webhook
 * This is the endpoint that Gmail calls when a new email arrives
 */
async function handleGmailWebhook(req, res) {
    try {
        console.log('📩 [GMAIL WEBHOOK] Received notification from Gmail');

        const { message } = req.body;
        if (!message || !message.data) {
            return res.status(400).send('Invalid notification');
        }

        // Decode the base64 data
        const data = Buffer.from(message.data, 'base64').toString('utf-8');
        const notification = JSON.parse(data);

        console.log(`📩 [GMAIL WEBHOOK] Notification: ${notification.emailAddress}, historyId: ${notification.historyId}`);

        // Find user by email address
        const user = await User.findOne({ 'gmailIntegration.emailAddress': notification.emailAddress });
        if (!user) {
            console.log(`⚠️ [GMAIL WEBHOOK] User not found for email: ${notification.emailAddress}`);
            return res.status(200).send('OK');
        }

        // Get new messages from history
        const gmail = await getGmailClient(user._id);
        const historyResponse = await gmail.users.history.list({
            userId: 'me',
            startHistoryId: notification.historyId,
            historyTypes: ['messageAdded']
        });

        const history = historyResponse.data;

        if (history.history) {
            for (const record of history.history) {
                if (record.messagesAdded) {
                    for (const added of record.messagesAdded) {
                        const messageId = added.message.id;
                        await processInboundEmail(user._id, messageId);
                    }
                }
            }
        }

        // Update historyId
        user.gmailIntegration.historyId = notification.historyId;
        await user.save();

        res.status(200).send('OK');

    } catch (error) {
        console.error('❌ [GMAIL WEBHOOK] Error:', error.message);
        res.status(200).send('OK'); // Always return 200 to Gmail
    }
}

module.exports = {
    processInboundEmail,
    setupGmailWatch,
    handleGmailWebhook
};
