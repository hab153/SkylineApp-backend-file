const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const crypto = require('crypto');

// IMPORT NEW AI FILES FOR TIERS
const freeAI = require('./Free');
const goAI = require('./Go');
const { generateBusinessResponse } = require('./businessAI'); 

// IMPORT MONTH 2 FILES
const Lead = require('./Lead');
const EmailAccount = require('./EmailAccount'); // <--- NEW BRIDGE MODEL
const { getAuthUrl, exchangeCodeForToken, getUserEmail, sendEmail } = require('./nylasService');

const authRoutes = require('./authRoutes');
const Message = require('./Message');
const User = require('./User');
const Report = require('./Report');
const requestQueue = require('./requestQueue');
const { verifyAge, changeEmail, verifyLayer2, verifyLayer3, deleteAccount } = require('./authController');

// Load environment variables
dotenv.config();

const app = express();

// Middleware
app.use(cors());

// ════════════════════════════════════════════
//  IN-MEMORY STATE STORE (For Nylas Auth)
// ════════════════════════════════════════════
const stateStore = {};

// ════════════════════════════════════════════
//  HELPER: REFRESH NYLAS TOKEN
// ════════════════════════════════════════════
async function refreshNylasToken(emailAccount) {
    try {
        const response = await axios.post(`${process.env.NYLAS_API_URI || 'https://api.us.nylas.com'}/v3/connect/token`, {
            client_id: process.env.NYLAS_CLIENT_ID,
            client_secret: process.env.NYLAS_CLIENT_SECRET,
            grant_type: 'refresh_token',            refresh_token: emailAccount.refreshToken
        });

        const newAccessToken = response.data.access_token;
        
        // Update the database with the new token and new expiry (1 hour from now)
        emailAccount.accessToken = newAccessToken;
        emailAccount.tokenExpiry = new Date(Date.now() + 3600 * 1000); 
        await emailAccount.save();
        
        console.log(`🔄 [NYLAS] Token refreshed for User ${emailAccount.userId}`);
        return newAccessToken;
    } catch (err) {
        console.error('❌ [NYLAS] Token Refresh Failed:', err.message);
        throw err;
    }
}

// ════════════════════════════════════════════
//  CHECK SUBSCRIPTION EXPIRY MIDDLEWARE
// ════════════════════════════════════════════
const checkSubscriptionExpiry = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        
        if (user.subscriptionTier && user.subscriptionTier !== 'free' && user.subscriptionEndDate) {
            const now = new Date();
            const endDate = new Date(user.subscriptionEndDate);
            if (now > endDate) {
                user.subscriptionTier = 'free';
                user.subscriptionEndDate = null;
                await user.save();
                console.log(`⚠️ User ${user._id} downgraded to free - subscription expired`);
            }
        }
        next();
    } catch (err) {
        console.error('Error checking subscription expiry:', err);
        next();
    }
};

// ════════════════════════════════════════════
//  WEBHOOK ROUTE - MUST BE BEFORE express.json()
// ════════════════════════════════════════════
app.post('/api/flutterwave-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    console.log("🔥 Webhook hit!");
    
    const sig = req.headers['verif-hash'];    const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
    
    if (secretHash && sig !== secretHash) {
        console.log("⚠️ Hash mismatch - check your FLUTTERWAVE_SECRET_HASH");
        return res.status(401).send('Unauthorized');
    }

    let payload;
    try {
        const rawBody = req.body.toString('utf-8');
        payload = JSON.parse(rawBody);
    } catch (e) {
        console.error('❌ Failed to parse webhook body:', e.message);
        return res.status(400).send('Invalid JSON');
    }

    try {
        let txRef, status, planType;
        
        if (payload.status) {
            status = payload.status;
            txRef = payload.txRef || payload.tx_ref;
            planType = payload.meta?.plan;
        } else if (payload.event === 'charge.completed') {
            status = payload.data?.status;
            txRef = payload.data?.tx_ref;
            planType = payload.data?.meta?.plan;
        }

        if (status === 'successful') {
            console.log(`✅ Payment successful for txRef: ${txRef}`);
            if (!txRef) return res.status(400).send('Missing txRef');
            
            if (!planType) {
                if (txRef.includes('_go_')) planType = 'go';
                else if (txRef.includes('_pro_')) planType = 'pro';
                else planType = 'free';
            }

            const user = await User.findOne({ lastTxRef: txRef });
            if (user) {
                const endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
                await User.findByIdAndUpdate(user._id, {
                    subscriptionTier: planType, 
                    subscriptionEndDate: endDate,
                    lastTxRef: null
                });
                console.log(`🎉 User ${user._id} upgraded to ${planType.toUpperCase()} Plan!`);
            } else {
                console.error(`❌ User not found for txRef: ${txRef}`);            }
        } else {
            console.log(`ℹ️ Webhook received but payment not successful. Status: ${status || 'unknown'}`);
        }

        res.status(200).send('Webhook received');
    } catch (error) {
        console.error('❌ Webhook Error:', error);
        res.status(500).send('Webhook failed');
    }
});

// ════════════════════════════════════════════
//  INBOUND EMAIL WEBHOOK - USES EMAIL ACCOUNT BRIDGE
// ════════════════════════════════════════════
app.all('/api/webhooks/inbound-email', express.raw({ type: 'application/json' }), async (req, res) => {
    if (req.method === 'GET') {
        const challenge = req.query.challenge;
        if (challenge) return res.status(200).send(challenge); 
        return res.status(400).send('No challenge provided');
    }

    if (req.method === 'POST') {
        try {
            const payload = JSON.parse(req.body.toString('utf-8'));
            const messageData = payload.data?.object;
            
            if (messageData && (payload.type === 'message.created' || payload.event === 'message.created')) {
                const fromEmail = messageData.from?.[0]?.email;
                const toEmail = messageData.to?.[0]?.email;
                
                // 1. FIND THE OWNER OF THE INBOX (THE BRIDGE)
                const grantId = payload.grant_id || messageData.grant_id; 
                let ownerUserId = null;

                if (grantId) {
                    const account = await EmailAccount.findOne({ nylasGrantId: grantId });
                    if (account) ownerUserId = account.userId;
                } 
                
                // Fallback: Look up by "To" email address
                if (!ownerUserId && toEmail) {
                    const account = await EmailAccount.findOne({ emailAddress: toEmail.toLowerCase() });
                    if (account) ownerUserId = account.userId;
                }

                if (!ownerUserId) {
                    console.warn(`⚠️ [WEBHOOK] Could not identify owner for To: ${toEmail}`);
                    return res.status(200).send('OK');
                }
                // 2. FIND THE LEAD (Who sent the reply?)
                const lead = await Lead.findOne({ email: fromEmail, userId: ownerUserId });
                
                if (lead) {
                    lead.status = 'Replied';
                    lead.lastContactDate = new Date();
                    
                    const bodyText = messageData.body || messageData.snippet || '';
                    lead.replies = lead.replies || [];
                    lead.replies.push({
                        date: new Date(),
                        content: bodyText,
                        from: 'lead',
                        subject: messageData.subject
                    });
                    await lead.save();

                    // 3. CREATE NOTIFICATION FOR THE CORRECT USER
                    const notification = new Message({
                        userId: ownerUserId,
                        sessionId: 'reply-notification',
                        role: 'ai',
                        title: '📬 New Lead Reply',
                        content: `${lead.name} replied:\n\n"${bodyText.substring(0, 200)}..."`,
                        notificationType: 'reply',
                        leadId: lead._id,
                        isRead: false
                    });
                    await notification.save();
                    console.log(`🔔 Notification saved for User: ${ownerUserId}`);
                } else {
                    console.warn(`⚠️ [WEBHOOK] No lead found for ${fromEmail} under User ${ownerUserId}`);
                }
            }
            return res.status(200).send('OK');
        } catch (err) {
            console.error('❌ Webhook Error:', err);
            return res.status(500).send('Error');
        }
    }
    res.status(405).send('Method Not Allowed');
});

// ════════════════════════════════════════════
//  NOW apply express.json() for all other routes
// ════════════════════════════════════════════
app.use(express.json());
app.use(express.static(path.join(__dirname)));
// Database Connection
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.log('❌ MongoDB Connection Error:', err));

// Auth Routes
app.use('/api/auth', authRoutes);

// ── Verify Token Middleware ──
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(403).json({ message: 'No token provided' });
    try {
        const secret = process.env.JWT_SECRET || 'secretkey';
        const decoded = jwt.verify(token, secret);
        req.userId = decoded.user.id;
        next();
    } catch (err) {
        console.error('Token Verification Failed:', err.message);
        return res.status(401).json({ message: 'Invalid token' });
    }
};

// ── Daily Usage Limit Middleware ──
const checkDailyLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!user.usage) {
            user.usage = { dailyCallCount: 0, lastCallDate: new Date() };
        }

        let limit = 30;
        if (user.subscriptionTier === 'go') limit = 18; 
        if (user.subscriptionTier === 'pro') limit = 40; 

        const now = new Date();
        const todayStr = now.toDateString();
        const lastCallDate = user.usage.lastCallDate ? new Date(user.usage.lastCallDate) : null;
        const lastCallStr = lastCallDate ? lastCallDate.toDateString() : '';

        if (lastCallStr !== todayStr) {
            user.usage.dailyCallCount = 0;
            user.usage.lastCallDate = now;
            await user.save();
        }
        if (user.usage.dailyCallCount >= limit) {
            return res.status(429).json({ message: `Daily limit reached (${limit}/${limit}). Upgrade your plan for more.` });
        }

        user.usage.dailyCallCount += 1;
        await user.save();
        next();
    } catch (err) {
        console.error('Error checking daily limit:', err);
        res.status(500).json({ message: 'Server Error checking usage limits' });
    }
};

// ════════════════════════════════════════════
//  WHATSAPP-STYLE INBOX ROUTES
// ════════════════════════════════════════════

// 1. GET CONVERSATIONS (Sidebar List)
app.get('/api/conversations', verifyToken, async (req, res) => {
    try {
        const leads = await Lead.find({ userId: req.userId })
            .sort({ lastContactDate: -1 })
            .limit(50); 

        const conversations = leads.map(lead => {
            const lastReply = lead.replies && lead.replies.length > 0 
                ? lead.replies[lead.replies.length - 1] 
                : null;

            let preview = "No messages yet";
            if (lastReply) {
                // Strip HTML tags for clean preview
                preview = lastReply.content.replace(/<[^>]*>?/gm, '').substring(0, 50);
            }

            return {
                id: lead._id,
                name: lead.name,
                company: lead.company,
                email: lead.email,
                status: lead.status,
                lastMessage: preview,
                lastDate: lead.lastContactDate,
                unread: !lastReply || lastReply.from === 'lead' 
            };
        });

        res.json(conversations);
    } catch (err) {
        console.error('Error fetching conversations:', err);        res.status(500).json({ message: 'Server Error' });
    }
});

// 2. GET SINGLE CONVERSATION (Chat Area)
app.get('/api/conversations/:leadId', verifyToken, async (req, res) => {
    try {
        const lead = await Lead.findOne({ _id: req.params.leadId, userId: req.userId });
        
        if (!lead) return res.status(404).json({ message: 'Conversation not found' });

        // Clean up all messages in history (Strip HTML)
        const cleanHistory = (lead.replies || []).map(msg => ({
            ...msg.toObject(),
            content: msg.content.replace(/<[^>]*>?/gm, '') // Strip HTML tags
        }));

        res.json({
            lead: {
                id: lead._id,
                name: lead.name,
                email: lead.email,
                company: lead.company,
                status: lead.status
            },
            messages: cleanHistory
        });
    } catch (err) {
        console.error('Error fetching conversation details:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// 3. RENAME CUSTOMER
app.put('/api/leads/:leadId/rename', verifyToken, async (req, res) => {
    try {
        const { newName } = req.body;
        const lead = await Lead.findOne({ _id: req.params.leadId, userId: req.userId });
        
        if (!lead) return res.status(404).json({ message: 'Lead not found' });

        lead.name = newName;
        await lead.save();
        
        res.json({ success: true, newName: lead.name });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});
// ════════════════════════════════════════════
//  BATCH SEND ROUTE (WITH AUTO-REFRESH LOGIC)
// ════════════════════════════════════════════
app.post('/api/leads/batch-send', verifyToken, async (req, res) => {
    try {
        const { leads } = req.body;
        
        // 1. Get the Email Account for this user
        const emailAccount = await EmailAccount.findOne({ userId: req.userId });
        
        if (!emailAccount) {
            return res.status(400).json({ message: 'No email account connected.' });
        }

        // 2. Check if token is expired (or expires in next 5 mins)
        const isExpired = !emailAccount.tokenExpiry || new Date() > new Date(emailAccount.tokenExpiry.getTime() - 5 * 60 * 1000);
        
        let currentAccessToken = emailAccount.accessToken;

        if (isExpired) {
            console.log('🔄 Access token expired. Refreshing...');
            try {
                currentAccessToken = await refreshNylasToken(emailAccount);
            } catch (refreshErr) {
                // If refresh fails, the grant is likely invalid. Force reconnect.
                return res.status(401).json({ 
                    success: false, 
                    error: 'NYLAS_DISCONNECTED', 
                    message: 'Session expired. Please reconnect.' 
                });
            }
        }

        let sentCount = 0;
        let errors = [];
        const now = new Date();

        for (const leadData of leads) {
            try {
                let lead = await Lead.findOne({ email: leadData.email, userId: req.userId });
                
                if (!lead) {
                    lead = new Lead({
                        userId: req.userId,
                        name: leadData.name,
                        email: leadData.email,
                        company: leadData.company,
                        status: 'Contacted',
                        lastContactDate: now
                    });                } else {
                    lead.status = 'Contacted';
                    lead.lastContactDate = now;
                }
                
                if (leadData.messages && leadData.messages.length > 0) {
                    if (!lead.replies) lead.replies = [];
                    lead.replies.push({
                        date: now,
                        content: leadData.messages[0].body,
                        subject: leadData.messages[0].subject,
                        from: 'ai',
                        status: 'sent'
                    });
                }
                await lead.save();

                if (leadData.messages && leadData.messages.length > 0) {
                    const result = await sendEmail(
                        currentAccessToken, // Use the fresh token
                        leadData.email, 
                        leadData.messages[0].subject, 
                        leadData.messages[0].body
                    );

                    if (result.success) {
                        sentCount++;
                        console.log(`✅ Email sent to ${leadData.email}`);
                    } else {
                        // If send fails due to auth, try refreshing one last time
                        if (result.error && result.error.includes('401')) {
                             try {
                                currentAccessToken = await refreshNylasToken(emailAccount);
                                // Retry send logic could go here, but for now we mark as error
                             } catch(e) {}
                        }
                        lead.status = 'Failed';
                        await lead.save();
                        errors.push({ email: leadData.email, error: result.error });
                        console.error(`❌ Failed to send to ${leadData.email}: ${result.error}`);
                    }
                }
            } catch (err) {
                console.error(`Failed to send to ${leadData.email}:`, err.message);
                errors.push({ email: leadData.email, error: err.message });
            }
        }

        res.json({ 
            success: true,             message: `Sent ${sentCount} emails.`, 
            errors: errors 
        });

    } catch (err) {
        console.error('Batch Send Error:', err);
        res.status(500).json({ message: 'Server Error during batch send' });
    }
});

// ════════════════════════════════════════════
//  RECONNECT AND AUTO-SEND PENDING MESSAGES
// ════════════════════════════════════════════
app.post('/api/reconnect-and-send', verifyToken, async (req, res) => {
    try {
        const emailAccount = await EmailAccount.findOne({ userId: req.userId });
        if (!emailAccount) {
            return res.status(400).json({ message: 'Nylas not connected' });
        }

        // Ensure we have a fresh token
        let currentAccessToken = emailAccount.accessToken;
        const isExpired = !emailAccount.tokenExpiry || new Date() > new Date(emailAccount.tokenExpiry.getTime() - 5 * 60 * 1000);
        
        if (isExpired) {
            currentAccessToken = await refreshNylasToken(emailAccount);
        }
        
        // Find all leads with pending messages for this user        
        const leadsWithPending = await Lead.find({ 
            userId: req.userId, 
            'replies.status': 'pending' 
        });

        let sentCount = 0;

        for (const lead of leadsWithPending) {
            const pendingMessages = lead.replies.filter(r => r.status === 'pending');
            
            for (const msg of pendingMessages) {
                const result = await sendEmail(
                    currentAccessToken, 
                    lead.email, 
                    msg.subject || 'Re: Conversation', 
                    msg.content
                );

                if (result.success) {
                    msg.status = 'sent';
                    sentCount++;                } else {
                    msg.status = 'failed';
                }
            }
            await lead.save();
        }

        res.json({ success: true, sentCount });
    } catch (err) {
        console.error('Auto-send Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ════════════════════════════════════════════
//  SIMPLIFIED NOTIFICATIONS ENDPOINT
// ════════════════════════════════════════════
app.get('/api/my-notifications', verifyToken, async (req, res) => {
    try {
        console.log(`🔍 Fetching notifications for user: ${req.userId}`);
        
        const replyNotifications = await Message.find({
            userId: req.userId,
            sessionId: 'reply-notification'
        }).sort({ createdAt: -1 });
        
        console.log(`✅ Found ${replyNotifications.length} reply notifications`);
        const adminMessages = await Message.find({
            userId: req.userId,
            sessionId: 'admin-direct-message'
        }).sort({ createdAt: -1 });
        
        console.log(`✅ Found ${adminMessages.length} admin messages`);
        
        const allNotifications = [...replyNotifications, ...adminMessages];
        allNotifications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        res.json(allNotifications);
    } catch (err) {
        console.error('❌ Error fetching notifications:', err);
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════
//  NYLAS AUTHENTICATION ROUTES (WITH BRIDGE)
// ════════════════════════════════════════════

app.get('/api/auth/nylas/url', verifyToken, (req, res) => {
    const userId = req.userId;    const randomState = uuidv4();
    stateStore[randomState] = userId;
    
    setTimeout(() => { delete stateStore[randomState]; }, 10 * 60 * 1000);

    const url = getAuthUrl(randomState);
    res.json({ url });
});

app.get('/api/auth/nylas/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
        return res.redirect('https://skylineai-app.vercel.app/dashboard.html?connected=false&error=' + oauthError);
    }

    if (!code || !state) {
        return res.status(400).send('Missing required parameters.');
    }

    const userId = stateStore[state];
    if (!userId) {
        return res.status(400).send('Session expired. Please try connecting again.');
    }
    
    delete stateStore[state];
    try {
        const tokenData = await exchangeCodeForToken(code);
        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token; // <--- GET REFRESH TOKEN
        const grantId = tokenData.grant_id; 

        let emailAddress = 'unknown@nylas.com';
        try {
            emailAddress = await getUserEmail(accessToken);
        } catch (emailErr) {
            console.warn(`⚠️ Could not retrieve email: ${emailErr.message}`);
        }

        // 1. Update User's primary integration (Legacy support)
        await User.findByIdAndUpdate(userId, { 
            'nylasIntegration.accessToken': accessToken,
            'nylasIntegration.emailAddress': emailAddress,
            'nylasIntegration.isConnected': true,
            'nylasIntegration.connectedAt': new Date()
        });

        // 2. CREATE/UPDATE THE EMAIL ACCOUNT BRIDGE (THE FIX)
        if (grantId) {
            await EmailAccount.findOneAndUpdate(                { nylasGrantId: grantId },
                {
                    userId: userId,
                    emailAddress: emailAddress,
                    isConnected: true,
                    provider: 'gmail',
                    accessToken: accessToken,
                    refreshToken: refreshToken, // <--- SAVE REFRESH TOKEN
                    tokenExpiry: new Date(Date.now() + 3600 * 1000) // <--- SET EXPIRY
                },
                { upsert: true, new: true }
            );
            console.log(`✅ [AUTH] Linked Grant ${grantId} to User ${userId}`);
        }

        res.redirect('https://skylineai-app.vercel.app/dashboard.html?connected=true');
    } catch (err) {
        console.error(`❌ Nylas Callback Error: ${err.message}`);
        res.redirect(`https://skylineai-app.vercel.app/dashboard.html?connected=false&error=token_exchange_failed`);
    }
});

// ════════════════════════════════════════════
//  CHECK FOR NEW REPLIES (For Frontend Notification)
// ════════════════════════════════════════════
app.get('/api/notifications/replies', verifyToken, async (req, res) => {
    try {
        const repliedLeads = await Lead.find({ 
            userId: req.userId, 
            status: 'Replied' 
        }).sort({ lastContactDate: -1 });
        res.json({ 
            count: repliedLeads.length,
            leads: repliedLeads 
        });
    } catch (err) {
        console.error('Error fetching replies:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ════════════════════════════════════════════
//  CHAT ROUTE (THE AI ROUTER)
// ════════════════════════════════════════════
app.post('/api/chat', verifyToken, checkSubscriptionExpiry, checkDailyLimit, async (req, res) => {
    const { message, history, sessionId } = req.body;
    const userId = req.userId;
    if (!message) return res.status(400).json({ message: 'Message is required' });
    const currentSessionId = sessionId || uuidv4();
    const user = await User.findById(userId);    const plan = user.subscriptionTier || 'free';
    try {
        await new Message({
            userId,
            sessionId: currentSessionId,
            role: 'user',
            content: message,
            title: message.substring(0, 30) + '...'
        }).save();

        let aiReply, updatedHistory;
        if (plan === 'free') {
            const result = await freeAI.generateFreeResponse(message, history || [], user);
            aiReply = result.reply;
            updatedHistory = result.updatedHistory;
        } 
        else if (plan === 'go') {
            try {
                const result = await goAI.generateGoResponse(message, history || [], user);
                aiReply = result ? result.reply : "⚠️ Go AI Service unavailable.";
                updatedHistory = result ? (result.updatedHistory || []) : [];
            } catch (goError) {
                aiReply = "⚠️ Go AI Service currently unavailable.";
            }
        } 
        else {
            const userProfile = {
                fullName: user.fullName, country: user.country, skillLevel: user.skillLevel,
                primaryGoal: user.primaryGoal, interests: user.interests, bio: user.bio,
                userId: user._id.toString()
            };
            const result = await requestQueue.enqueue(async () => {
                return await generateBusinessResponse(message, history || [], userProfile);
            });
            aiReply = result.reply;
            updatedHistory = result.updatedHistory;
        }

        await new Message({
            userId,
            sessionId: currentSessionId,
            role: 'ai',
            content: aiReply
        }).save();

        res.json({ reply: aiReply, sessionId: currentSessionId, history: updatedHistory });

    } catch (error) {
        console.error('Chat route error:', error);
        res.status(500).json({ message: error.message || 'Server Error' });    }
});

// ════════════════════════════════════════════
//  GET LEADS FOR DASHBOARD
// ════════════════════════════════════════════
app.get('/api/leads', verifyToken, async (req, res) => {
    try {
        const leads = await Lead.find({ userId: req.userId }).sort({ createdAt: -1 });
        res.json(leads);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// ════════════════════════════════════════════
//  FEEDBACK ROUTE
// ════════════════════════════════════════════
app.post('/api/feedback', verifyToken, async (req, res) => {
    try {
        const { messageId, type } = req.body;
        if (!messageId || !['like', 'dislike'].includes(type)) {
            return res.status(400).json({ message: 'Invalid feedback data' });
        }
        const message = await Message.findById(messageId);
        if (!message) return res.status(404).json({ message: 'Message not found' });
        if (message.userId.toString() !== req.userId) {
            return res.status(403).json({ message: 'Unauthorized' });
        }
        message.feedback = message.feedback === type ? null : type;
        await message.save();
        res.json({ success: true, feedback: message.feedback });
    } catch (err) {
        res.status(500).json({ message: 'Server Error saving feedback' });
    }
});

// ════════════════════════════════════════════
//  OTHER PROTECTED API ROUTES
// ════════════════════════════════════════════
app.get('/api/sessions', verifyToken, checkSubscriptionExpiry, async (req, res) => {
    try {
        const sessions = await Message.aggregate([
            { $match: { userId: new mongoose.Types.ObjectId(req.userId) } },
            { $sort: { createdAt: -1 } },
            { $group: { _id: '$sessionId', title: { $first: '$title' }, lastUpdated: { $first: '$createdAt' } } },
            { $sort: { lastUpdated: -1 } }
        ]);
        res.json(sessions);
    } catch (error) {        res.status(500).json({ message: 'Server Error fetching sessions' });
    }
});

app.get('/api/history/:sessionId', verifyToken, checkSubscriptionExpiry, async (req, res) => {
    try {
        const messages = await Message.find({ userId: req.userId, sessionId: req.params.sessionId }).sort({ createdAt: 1 });
        res.json(messages);
    } catch (error) {
        res.status(500).json({ message: 'Server Error fetching history' });
    }
});

app.post('/api/dreams/analyze', verifyToken, checkSubscriptionExpiry, checkDailyLimit, async (req, res) => {
    const { dream, sessionId } = req.body;
    const userId = req.userId;
    if (!dream) return res.status(400).json({ message: 'Dream description is required' });
    const currentSessionId = sessionId || uuidv4();
    try {
        await new Message({ userId, sessionId: currentSessionId, role: 'user', content: dream, title: dream.substring(0, 30) + '...' }).save();
        const user = await User.findById(userId);
        const userProfile = { fullName: user.fullName, country: user.country, skillLevel: user.skillLevel, primaryGoal: user.primaryGoal, interests: user.interests, bio: user.bio, userId: user._id.toString() };
        const result = await requestQueue.enqueue(async () => { return await generateBusinessResponse(dream, [], userProfile); });
        await new Message({ userId, sessionId: currentSessionId, role: 'ai', content: result.reply }).save();
        res.json({ plan: result.reply, audit: {}, sessionId: currentSessionId });
    } catch (error) {
        res.status(500).json({ message: error.message || 'Server Error' });
    }
});

app.post('/api/dreams/refine', verifyToken, checkSubscriptionExpiry, checkDailyLimit, async (req, res) => {
    const { originalPlan, followUpAnswer, dreamDescription, sessionId } = req.body;
    const userId = req.userId;
    if (!followUpAnswer || !dreamDescription) { return res.status(400).json({ message: 'followUpAnswer and dreamDescription are required' }); }
    const currentSessionId = sessionId || uuidv4();
    try {
        await new Message({ userId, sessionId: currentSessionId, role: 'user', content: followUpAnswer }).save();
        const user = await User.findById(userId);
        const userProfile = { fullName: user.fullName, country: user.country, skillLevel: user.skillLevel, primaryGoal: user.primaryGoal, interests: user.interests, bio: user.bio, userId: user._id.toString() };
        const result = await requestQueue.enqueue(async () => { return await generateBusinessResponse(followUpAnswer, [], userProfile); });
        await new Message({ userId, sessionId: currentSessionId, role: 'ai', content: result.reply }).save();
        res.json({ plan: result.reply, audit: {}, sessionId: currentSessionId });
    } catch (error) {
        res.status(500).json({ message: error.message || 'Server Error' });
    }
});

app.get('/api/users/me', verifyToken, checkSubscriptionExpiry, async (req, res) => {
    try {
        const user = await User.findById(req.userId).select('-password');        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(user);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.put('/api/users/me', verifyToken, checkSubscriptionExpiry, async (req, res) => {
    try {
        const { fullName, primaryGoal, skillLevel, interests, country, bio, profilePicture } = req.body;
        let user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        if (fullName) user.fullName = fullName;
        if (primaryGoal) user.primaryGoal = primaryGoal;
        if (skillLevel) user.skillLevel = skillLevel;
        if (interests) user.interests = interests;
        if (country) user.country = country;
        if (bio) user.bio = bio;
        if (profilePicture) user.profilePicture = profilePicture;
        await user.save();
        res.json(user);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.put('/api/auth/change-password', verifyToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    try {
        let user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Current password is incorrect' });
        if (newPassword.length < 8) return res.status(400).json({ message: 'New password must be at least 8 characters' });
        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        await user.save();
        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.put('/api/auth/change-email', verifyToken, changeEmail);
app.put('/api/users/verify-age', verifyToken, verifyAge);
app.delete('/api/users/me', verifyToken, async (req, res) => { await deleteAccount(req, res); });

// ADMIN ROUTES
app.post('/api/admin/verify-layer-2', verifyToken, verifyLayer2);
app.post('/api/admin/verify-layer-3', verifyToken, verifyLayer3);app.get('/api/admin/users', verifyToken, async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user || !user.isAdmin) return res.status(403).json({ message: 'Access denied. Admins only.' });
        const users = await User.find().select('-password');
        res.json(users);
    } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});
app.put('/api/admin/users/:id/suspend', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const targetUser = await User.findById(req.params.id);
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        targetUser.isSuspended = !targetUser.isSuspended;
        targetUser.suspensionEnds = targetUser.isSuspended ? new Date('2099-12-31') : null;
        await targetUser.save();
        res.json({ message: 'Status updated' });
    } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});
app.delete('/api/admin/users/:id', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        await User.findByIdAndDelete(req.params.id);
        res.json({ message: 'User deleted' });
    } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});
app.get('/api/admin/users/:id/details', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const targetUser = await User.findById(req.params.id).select('-password');
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        const messages = await Message.find({ userId: req.params.id }).sort({ createdAt: 1 });
        res.json({ user: targetUser, history: messages });
    } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});
app.get('/api/admin/users/:id/chat-view', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const targetUser = await User.findById(req.params.id).select('-password');
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        const chatMessages = await Message.find({ userId: req.params.id }).sort({ createdAt: 1 });
        res.json({ user: targetUser, messages: chatMessages });
    } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});
app.post('/api/admin/users/:id/message', verifyToken, async (req, res) => {
    try {        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const { messageContent } = req.body;
        if (!messageContent) return res.status(400).json({ message: 'Message content is required' });
        const targetUser = await User.findById(req.params.id);
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        const newMessage = new Message({ userId: req.params.id, sessionId: 'admin-direct-message', role: 'ai', content: `[ADMIN MESSAGE]: ${messageContent}`, title: 'Direct Message from Admin' });
        await newMessage.save();
        res.json({ message: 'Message sent successfully' });
    } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

// REPORTS
app.post('/api/reports', verifyToken, async (req, res) => {
    try {
        const { subject, message } = req.body;
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        const newReport = new Report({ userId: req.userId, username: user.username, subject, message });
        await newReport.save();
        res.json({ message: 'Report submitted successfully' });
    } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});
app.get('/api/admin/reports', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const reports = await Report.find().sort({ createdAt: -1 });
        res.json(reports);
    } catch (err) { res.status(500).json({ message: 'Server Error' }); }
});

// NOTIFICATIONS COUNT
app.get('/api/notifications/count', verifyToken, async (req, res) => {
    try {
        const adminCount = await Message.countDocuments({ 
            userId: req.userId, 
            sessionId: 'admin-direct-message' 
        });
        const replyCount = await Message.countDocuments({ 
            userId: req.userId, 
            sessionId: 'reply-notification'
        });
        res.json({ count: adminCount + replyCount });
    } catch (err) {
        console.error('Error counting notifications:', err);
        res.status(500).json({ message: 'Server Error counting notifications' });
    }
});
// EXPIRY CHECK
const scheduleExpiryCheck = async () => {
    try {
        const now = new Date();
        const result = await User.updateMany({ subscriptionTier: { $ne: 'free' }, subscriptionEndDate: { $lt: now } }, { subscriptionTier: 'free', subscriptionEndDate: null });
        if (result.modifiedCount > 0) { console.log(`🔄 Downgraded ${result.modifiedCount} expired users`); }
    } catch (err) { console.error('Error in expiry check:', err); }
};
setTimeout(() => { scheduleExpiryCheck(); setInterval(scheduleExpiryCheck, 24 * 60 * 60 * 1000); }, 5000);

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => { console.log(`🚀 Server running on port ${PORT}`); });
