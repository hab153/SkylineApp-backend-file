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

// IMPORT AUTO-REPLY GENERATOR
const { generateAIReply } = require('./aiReplyGenerator');

// IMPORT MONTH 2 FILES
const Lead = require('./Lead');
const EmailAccount = require('./EmailAccount');
const { getAuthUrl, exchangeCodeForToken, getUserEmail, sendEmail } = require('./nylasService');

const authRoutes = require('./authRoutes');
const Message = require('./Message');
const User = require('./User');
const Report = require('./Report');
const requestQueue = require('./requestQueue');
const { verifyAge, changeEmail, verifyLayer2, verifyLayer3, deleteAccount } = require('./authController');

dotenv.config();
const app = express();
app.use(cors());
const stateStore = {};

// ════════════════════════════════════════════
//  refreshNylasToken
//  Retries once with 2s delay before giving up.
//  NEVER deletes the EmailAccount record.
// ════════════════════════════════════════════
async function refreshNylasToken(emailAccount, attempt = 1) {
    try {
        const response = await axios.post(
            `${process.env.NYLAS_API_URI || 'https://api.us.nylas.com'}/v3/connect/token`,
            {
                client_id:     process.env.NYLAS_CLIENT_ID,
                client_secret: process.env.NYLAS_CLIENT_SECRET,
                grant_type:    'refresh_token',
                refresh_token: emailAccount.refreshToken            }        );

        const newAccessToken = response.data.access_token;

        emailAccount.accessToken      = newAccessToken;
        emailAccount.tokenExpiry      = new Date(Date.now() + 3600 * 1000);
        emailAccount.refreshFailCount = 0;
        await emailAccount.save();

        console.log(`🔄 [NYLAS] Token refreshed successfully (attempt ${attempt}).`);
        return newAccessToken;

    } catch (err) {
        console.error(
            `❌ [NYLAS] Token refresh failed (attempt ${attempt}):`,
            err.response?.status,
            err.response?.data?.error_description || err.message
        );

        if (attempt === 1) {
            console.log(`⏳ [NYLAS] Retrying token refresh in 2 seconds...`);
            await new Promise(r => setTimeout(r, 2000));
            return refreshNylasToken(emailAccount, 2);
        }

        try {
            emailAccount.refreshFailCount = (emailAccount.refreshFailCount || 0) + 1;
            emailAccount.lastRefreshError = err.response?.data?.error_description || err.message;
            await emailAccount.save();
        } catch (saveErr) {
            console.warn('[NYLAS] Could not save fail count:', saveErr.message);
        }

        throw err;
    }
}

// ════════════════════════════════════════════
//  PROACTIVE TOKEN REFRESH JOB
//  Runs every 10 minutes. Refreshes tokens
//  expiring within the next 30 minutes.
// ════════════════════════════════════════════
async function proactiveTokenRefresh() {
    try {
        const soon = new Date(Date.now() + 30 * 60 * 1000);
        const accounts = await EmailAccount.find({
            isConnected:  true,
            refreshToken: { $exists: true, $ne: null },
            tokenExpiry:  { $lte: soon }        });
        if (accounts.length === 0) return;
        console.log(`🔁 [PROACTIVE] Refreshing ${accounts.length} token(s) before expiry...`);

        for (const account of accounts) {
            try {
                await refreshNylasToken(account);
            } catch (err) {
                console.warn(`⚠️ [PROACTIVE] Could not refresh token for ${account.emailAddress}: ${err.message}`);
            }
        }
    } catch (err) {
        console.error('❌ [PROACTIVE] Token refresh job error:', err.message);
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
            if (now > new Date(user.subscriptionEndDate)) {
                user.subscriptionTier    = 'free';
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
//  WEBHOOK — MUST BE BEFORE express.json()
// ════════════════════════════════════════════
app.post('/api/flutterwave-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    console.log("🔥 Webhook hit!");
    const sig        = req.headers['verif-hash'];
    const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
    if (secretHash && sig !== secretHash) {
        console.log("⚠️ Hash mismatch");
        return res.status(401).send('Unauthorized');    }
    let payload;
    try {        payload = JSON.parse(req.body.toString('utf-8'));
    } catch (e) {
        return res.status(400).send('Invalid JSON');
    }
    try {
        let txRef, status, planType;
        if (payload.status) {
            status   = payload.status;
            txRef    = payload.txRef || payload.tx_ref;
            planType = payload.meta?.plan;
        } else if (payload.event === 'charge.completed') {
            status   = payload.data?.status;
            txRef    = payload.data?.tx_ref;
            planType = payload.data?.meta?.plan;
        }
        if (status === 'successful') {
            if (!txRef) return res.status(400).send('Missing txRef');
            if (!planType) {
                if (txRef.includes('_go_'))       planType = 'go';
                else if (txRef.includes('_pro_')) planType = 'pro';
                else                              planType = 'free';
            }
            const user = await User.findOne({ lastTxRef: txRef });
            if (user) {
                const endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
                await User.findByIdAndUpdate(user._id, {
                    subscriptionTier:    planType,
                    subscriptionEndDate: endDate,
                    lastTxRef:           null
                });
                console.log(`🎉 User ${user._id} upgraded to ${planType.toUpperCase()}!`);
            } else {
                console.error(`❌ User not found for txRef: ${txRef}`);
            }
        }
        res.status(200).send('Webhook received');
    } catch (error) {
        console.error('❌ Webhook Error:', error);
        res.status(500).send('Webhook failed');
    }
});

// ════════════════════════════════════════════
//  INBOUND EMAIL WEBHOOK
//  FIX 1: followUpCount now uses lead.followUpCount
//         (stored field) instead of recalculating
//         from the replies array — avoids off-by-one//         bug where freshly-pushed lead reply was
//         included in the count.
//  FIX 2: followUpCount resets to 0 when lead replies
//         so active conversations never hit the cap.//  FIX 3: Guards against missing refresh token before
//         attempting to send — logs clearly instead of
//         crashing.
// ════════════════════════════════════════════
app.all('/api/webhooks/inbound-email', express.raw({ type: 'application/json' }), async (req, res) => {
    if (req.method === 'GET') {
        const challenge = req.query.challenge;
        if (challenge) return res.status(200).send(challenge);
        return res.status(400).send('No challenge provided');
    }

    if (req.method === 'POST') {
        try {
            const payload     = JSON.parse(req.body.toString('utf-8'));
            const messageData = payload.data?.object;

            if (messageData && (payload.type === 'message.created' || payload.event === 'message.created')) {
                const fromEmail = messageData.from?.[0]?.email;
                const toEmail   = messageData.to?.[0]?.email;
                console.log(`📩 [WEBHOOK] Email from ${fromEmail} to ${toEmail}`);

                // 1. Find inbox owner
                const grantId = payload.grant_id || messageData.grant_id;
                let ownerUserId = null;
                if (grantId) {
                    const account = await EmailAccount.findOne({ nylasGrantId: grantId });
                    if (account) ownerUserId = account.userId;
                }
                if (!ownerUserId && toEmail) {
                    const account = await EmailAccount.findOne({ emailAddress: toEmail.toLowerCase() });
                    if (account) ownerUserId = account.userId;
                }
                if (!ownerUserId) {
                    console.warn(`⚠️ [WEBHOOK] Could not identify owner for To: ${toEmail}`);
                    return res.status(200).send('OK');
                }

                // 2. Find the Lead
                const lead = await Lead.findOne({ email: fromEmail, userId: ownerUserId });
                if (lead) {
                    // ── FIX 1: Reset follow-up count BEFORE saving the new reply
                    //    so the stored field is always correct for next AI call
                    lead.status          = 'Replied';
                    lead.lastContactDate = new Date();
                    lead.followUpCount   = 0; // FIX: reset — lead is actively replying
                    const bodyText = messageData.body || messageData.snippet || '';
                    lead.replies   = lead.replies || [];
                    lead.replies.push({
                        date:    new Date(),
                        content: bodyText,                        from:    'lead',
                        subject: messageData.subject
                    });
                    await lead.save();

                    // 3. Notification
                    await new Message({
                        userId:           ownerUserId,
                        sessionId:        'reply-notification',
                        role:             'ai',
                        title:            '📬 New Lead Reply',
                        content:          `${lead.name} replied:\n\n"${bodyText.substring(0, 200)}..."`,
                        notificationType: 'reply',
                        leadId:           lead._id,
                        isRead:           false
                    }).save();
                    console.log(`🔔 Notification saved for User: ${ownerUserId}`);

                    // 4. Auto-Reply
                    console.log(`🤖 [AUTO-REPLY] Enabled: ${lead.autoReplyEnabled}`);
                    if (lead.autoReplyEnabled && lead.autoReplyInstructions) {
                        try {
                            // CHECK AUTO-REPLY LIMITS HERE
                            const ownerUser = await User.findById(ownerUserId);
                            let autoReplyLimit = 10; // Free
                            if (ownerUser.subscriptionTier === 'go') autoReplyLimit = 40;
                            if (ownerUser.subscriptionTier === 'pro') autoReplyLimit = 70;

                            // You need to track auto-reply count in User.usage or Lead
                            // For simplicity, let's assume we store it in User.usage.autoReplyCount
                            if (!ownerUser.usage) ownerUser.usage = { autoReplyCount: 0, lastAutoReplyDate: new Date() };
                            
                            const todayStr = new Date().toDateString();
                            const lastAutoStr = ownerUser.usage.lastAutoReplyDate ? new Date(ownerUser.usage.lastAutoReplyDate).toDateString() : '';
                            
                            if (lastAutoStr !== todayStr) {
                                ownerUser.usage.autoReplyCount = 0;
                                ownerUser.usage.lastAutoReplyDate = new Date();
                                await ownerUser.save();
                            }

                            if (ownerUser.usage.autoReplyCount >= autoReplyLimit) {
                                console.log(`🚫 [AUTO-REPLY] Limit reached for user ${ownerUserId} (${autoReplyLimit}/${autoReplyLimit})`);
                                // Optional: Send a notification to the user that their auto-reply limit is reached
                            } else {                                // Increment count
                                ownerUser.usage.autoReplyCount += 1;
                                await ownerUser.save();

                                // Build conversation history from last 4 messages
                                const history = lead.replies.slice(-4).map(msg => ({                                    role:    msg.from === 'lead' ? 'user' : 'assistant',
                                    content: msg.content
                                }));

                                // ── FIX 2: Use stored followUpCount field — NOT recalculated
                                //    from the replies array. Recalculating was broken because
                                //    the new lead reply was already in the array, causing the
                                //    slice to include AI replies from before reset, hitting cap.
                                const followUpCount = lead.followUpCount || 0;
                                console.log(`📊 [AUTO-REPLY] followUpCount: ${followUpCount}`);

                                // Call AI generator
                                const aiResult = await generateAIReply(
                                    bodyText,
                                    lead.autoReplyInstructions,
                                    lead.name,
                                    history,
                                    {
                                        mode:         'full', // lead is actively replying — use full
                                        followUpCount: followUpCount
                                    }
                                );

                                console.log(`🧠 [AUTO-REPLY] AI result: action=${aiResult?.action} | risk=${aiResult?.riskLevel} | tokens=${aiResult?.tokensUsed}`);

                                // Check if AI generated a sendable reply
                                if (aiResult && aiResult.action === 'REPLY' && aiResult.reply) {
                                    const emailAccount = await EmailAccount.findOne({ userId: ownerUserId });

                                    if (!emailAccount) {
                                        console.error('❌ [AUTO-REPLY] No email account found for user.');

                                    // ── FIX 3: Guard against missing refresh token
                                    } else if (!emailAccount.refreshToken) {
                                        console.error('❌ [AUTO-REPLY] No refresh token — user must reconnect Nylas. Go to Nylas dashboard and ensure offline_access scope is enabled.');

                                    } else {
                                        let accessToken = emailAccount.accessToken;

                                        // Refresh token if expiring within 5 minutes
                                        const isExpired = !emailAccount.tokenExpiry ||
                                            new Date() > new Date(emailAccount.tokenExpiry.getTime() - 5 * 60 * 1000);

                                        if (isExpired) {                                            try {
                                                console.log('🔄 [AUTO-REPLY] Token expiring — refreshing...');
                                                accessToken = await refreshNylasToken(emailAccount);
                                            } catch (refreshErr) {
                                                console.error(`❌ [AUTO-REPLY] Token refresh failed — skipping send: ${refreshErr.message}`);
                                                accessToken = null;
                                            }                                        }

                                        if (accessToken) {
                                            const result = await sendEmail(
                                                accessToken,
                                                lead.email,
                                                `Re: ${messageData.subject}`,
                                                aiResult.reply
                                            );

                                            if (result.success) {
                                                // Save AI reply and increment followUpCount
                                                lead.replies.push({
                                                    date:    new Date(),
                                                    content: aiResult.reply,
                                                    subject: `Re: ${messageData.subject}`,
                                                    from:    'ai',
                                                    status:  'sent'
                                                });
                                                lead.followUpCount = (lead.followUpCount || 0) + 1;
                                                await lead.save();
                                                console.log(`✅ [AUTO-REPLY] Sent to ${lead.email} | followUpCount now: ${lead.followUpCount}`);
                                            } else {
                                                console.error(`❌ [AUTO-REPLY] Send failed: ${result.error}`);
                                            }
                                        }
                                    }
                                } else {
                                    console.log(`🔇 [AUTO-REPLY] Skipped. Action: ${aiResult?.action || 'NULL'} | Reason: ${aiResult?.reasoning || 'No reply generated'}`);
                                }
                            }
                        } catch (aiErr) {
                            console.error('❌ [AUTO-REPLY] Generation error:', aiErr.message);
                        }
                    } else {
                        console.log(`⚪ [AUTO-REPLY] Disabled or no instructions set.`);
                    }
                } else {
                    console.warn(`⚠️ [WEBHOOK] No lead found for ${fromEmail} under User ${ownerUserId}`);
                }
            }
            return res.status(200).send('OK');
        } catch (err) {            console.error('❌ Webhook Error:', err);
            return res.status(500).send('Error');
        }
    }
    res.status(405).send('Method Not Allowed');
});

// ════════════════════════════════════════════//  NOW apply express.json()
// ════════════════════════════════════════════
app.use(express.json());
app.use(express.static(path.join(__dirname)));

mongoose.connect(process.env.MONGODB_URI)
    .then(() => {
        console.log('✅ MongoDB Connected');
        proactiveTokenRefresh();
        setInterval(proactiveTokenRefresh, 10 * 60 * 1000);
        console.log('🔁 [PROACTIVE] Token refresh job started (every 10 min)');
    })
    .catch(err => console.log('❌ MongoDB Connection Error:', err));

app.use('/api/auth', authRoutes);

// ── Verify Token Middleware ──
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token      = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(403).json({ message: 'No token provided' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secretkey');
        req.userId = decoded.user.id;
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Invalid token' });
    }
};

// ── Daily Usage Limit Middleware ──
const checkDailyLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        if (!user.usage) user.usage = { dailyCallCount: 0, lastCallDate: new Date() };
        
        // UPDATED LIMITS
        let limit = 7; // Free plan
        if (user.subscriptionTier === 'go')  limit = 30;
        if (user.subscriptionTier === 'pro') limit = 50;
        const todayStr = new Date().toDateString();
        const lastStr  = user.usage.lastCallDate ? new Date(user.usage.lastCallDate).toDateString() : '';
        
        if (lastStr !== todayStr) {
            user.usage.dailyCallCount = 0;
            user.usage.lastCallDate   = new Date();
            await user.save();
        }
                if (user.usage.dailyCallCount >= limit) {
            return res.status(429).json({ message: `Daily limit reached (${limit}/${limit}). Upgrade for more.` });
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
//  CREATE FLUTTERWAVE PAYMENT LINK (WITH FULL TRACKING)
// ════════════════════════════════════════════
app.post('/api/create-flutterwave-payment', verifyToken, async (req, res) => {
    console.log('💳 [PAYMENT] Request received for plan:', req.body.planType);
    
    try {
        const { planType } = req.body; // 'go' or 'pro'
        const user = await User.findById(req.userId);
        
        if (!user) {
            console.error('❌ [PAYMENT] User not found for ID:', req.userId);
            return res.status(404).json({ message: 'User not found' });
        }

        console.log('👤 [PAYMENT] User identified:', user.email);

        let amount = 0;
        let planName = '';

        if (planType === 'go') {
            amount = 49;
            planName = 'GO Plan';
        } else if (planType === 'pro') {
            amount = 129;
            planName = 'PRO Plan';
        } else {
            console.error('❌ [PAYMENT] Invalid plan type:', planType);
            return res.status(400).json({ message: 'Invalid plan type' });
        }

        // Create a unique transaction reference
        const txRef = `skyline_${planType}_${user._id}_${Date.now()}`;
        console.log('🔖 [PAYMENT] Transaction Reference:', txRef);

        // Save txRef to user so webhook can find them later
        user.lastTxRef = txRef;        await user.save();
        console.log('💾 [PAYMENT] TxRef saved to User document');

        // Check if Secret Key is present
        if (!process.env.FLUTTERWAVE_SECRET_KEY) {
            console.error('❌ [PAYMENT] FLUTTERWAVE_SECRET_KEY is MISSING in Environment Variables');
            return res.status(500).json({ message: 'Server configuration error: Missing Payment Key' });
        }
        console.log('🔑 [PAYMENT] Secret Key found (starts with):', process.env.FLUTTERWAVE_SECRET_KEY.substring(0, 10) + '...');

        // Flutterwave API Payload
        const payload = {
            tx_ref: txRef,
            amount: amount,
            currency: "USD",
            redirect_url: "https://skylineai-app.vercel.app/dashboard.html?payment=success",
            meta: {
                plan: planType,
                userId: user._id.toString()
            },
            customer: {
                email: user.email || "customer@example.com", 
                name: user.fullName || "Skyline User"
            },
            customizations: {
                title: "Skyline AA-1 Subscription",
                description: `Payment for ${planName}`,
                logo: "https://skylineai-app.vercel.app/logo.png" 
            }
        };

        console.log('🚀 [PAYMENT] Sending request to Flutterwave API...');

        // Call Flutterwave API
        const response = await axios.post(
            'https://api.flutterwave.com/v3/payments',
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.status === 'success') {
    console.log('✅ [PAYMENT] Link Generated:', response.data.data.link);
    res.json({ 
        link: response.data.data.link,
        txRef: txRef
    });
} else {  // ← Moved the else outside the res.json()
    console.error('❌ [PAYMENT] Flutterwave API Error:', response.data);
    throw new Error(response.data.message || 'Failed to create payment link');
        }

// ════════════════════════════════════════════
//  WHATSAPP-STYLE INBOX ROUTES
// ════════════════════════════════════════════
app.get('/api/conversations', verifyToken, async (req, res) => {
    try {
        const leads         = await Lead.find({ userId: req.userId }).sort({ lastContactDate: -1 }).limit(50);
        const conversations = leads.map(lead => {
            const lastReply = lead.replies?.length > 0 ? lead.replies[lead.replies.length - 1] : null;
            const preview   = lastReply
                ? lastReply.content.replace(/<[^>]*>?/gm, '').substring(0, 50)
                : "No messages yet";
            return {
                id:               lead._id,
                name:             lead.name,
                company:          lead.company,
                email:            lead.email,
                status:           lead.status,
                lastMessage:      preview,
                lastDate:         lead.lastContactDate,
                unread:           !lastReply || lastReply.from === 'lead',
                autoReplyEnabled: lead.autoReplyEnabled
            };
        });
        res.json(conversations);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.get('/api/conversations/:leadId', verifyToken, async (req, res) => {
    try {
        const lead = await Lead.findOne({ _id: req.params.leadId, userId: req.userId });
        if (!lead) return res.status(404).json({ message: 'Conversation not found' });
        const cleanHistory = (lead.replies || []).map(msg => ({
            ...msg.toObject(),
            content: msg.content.replace(/<[^>]*>?/gm, '')
        }));
        res.json({            lead: {
                id:                   lead._id,
                name:                 lead.name,
                email:                lead.email,
                company:              lead.company,
                status:               lead.status,
                autoReplyEnabled:     lead.autoReplyEnabled,
                autoReplyInstructions: lead.autoReplyInstructions
            },
            messages: cleanHistory
        });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});
app.put('/api/leads/:leadId/rename', verifyToken, async (req, res) => {
    try {
        const lead = await Lead.findOne({ _id: req.params.leadId, userId: req.userId });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });
        lead.name = req.body.newName;
        await lead.save();
        res.json({ success: true, newName: lead.name });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.put('/api/leads/:leadId/auto-reply', verifyToken, async (req, res) => {
    try {
        const { enabled, instructions } = req.body;
        const lead = await Lead.findOne({ _id: req.params.leadId, userId: req.userId });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });
        lead.autoReplyEnabled = enabled;
        if (instructions !== undefined) lead.autoReplyInstructions = instructions;
        await lead.save();
        res.json({ success: true, enabled: lead.autoReplyEnabled, instructions: lead.autoReplyInstructions });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

// ════════════════════════════════════════════
//  BATCH SEND ROUTE
// ════════════════════════════════════════════
app.post('/api/leads/batch-send', verifyToken, async (req, res) => {
    try {
        const { leads }    = req.body;
        const emailAccount = await EmailAccount.findOne({ userId: req.userId });
        if (!emailAccount) {
            return res.status(401).json({ success: false, error: 'NYLAS_DISCONNECTED', message: 'No connection found.' });        }

        const isExpired = !emailAccount.tokenExpiry ||
            new Date() > new Date(emailAccount.tokenExpiry.getTime() - 15 * 60 * 1000);
        let currentAccessToken = emailAccount.accessToken;

        if (isExpired) {
            try {
                currentAccessToken = await refreshNylasToken(emailAccount);
            } catch (refreshErr) {
                return res.status(401).json({ success: false, error: 'NYLAS_DISCONNECTED', message: 'Session expired. Please reconnect.' });
            }
        }
        let sentCount = 0;
        let errors    = [];
        const now     = new Date();

        for (const leadData of leads) {
            try {
                let lead = await Lead.findOne({ email: leadData.email, userId: req.userId });
                if (!lead) {
                    lead = new Lead({
                        userId:          req.userId,
                        name:            leadData.name,
                        email:           leadData.email,
                        company:         leadData.company,
                        status:          'Contacted',
                        lastContactDate: now,
                        followUpCount:   0
                    });
                } else {
                    lead.status          = 'Contacted';
                    lead.lastContactDate = now;
                }

                if (leadData.messages?.length > 0) {
                    if (!lead.replies) lead.replies = [];
                    lead.replies.push({
                        date:    now,
                        content: leadData.messages[0].body,
                        subject: leadData.messages[0].subject,
                        from:    'ai',
                        status:  'sent'
                    });
                    lead.followUpCount = (lead.followUpCount || 0) + 1;
                }
                await lead.save();

                if (leadData.messages?.length > 0) {
                    const result = await sendEmail(                        currentAccessToken,
                        leadData.email,
                        leadData.messages[0].subject,
                        leadData.messages[0].body
                    );
                    if (result.success) {
                        sentCount++;
                        console.log(`✅ Email sent to ${leadData.email}`);
                    } else {
                        lead.status = 'Failed';
                        await lead.save();
                        errors.push({ email: leadData.email, error: result.error });
                    }                }
            } catch (err) {
                errors.push({ email: leadData.email, error: err.message });
            }
        }
        res.json({ success: true, message: `Sent ${sentCount} emails.`, errors });
    } catch (err) {
        console.error('Batch Send Error:', err);
        res.status(500).json({ message: 'Server Error during batch send' });
    }
});

// ════════════════════════════════════════════
//  RECONNECT AND AUTO-SEND PENDING
// ════════════════════════════════════════════
app.post('/api/reconnect-and-send', verifyToken, async (req, res) => {
    try {
        const emailAccount = await EmailAccount.findOne({ userId: req.userId });
        if (!emailAccount) return res.status(400).json({ message: 'Nylas not connected' });

        let currentAccessToken = emailAccount.accessToken;
        const isExpired = !emailAccount.tokenExpiry ||
            new Date() > new Date(emailAccount.tokenExpiry.getTime() - 15 * 60 * 1000);
        if (isExpired) currentAccessToken = await refreshNylasToken(emailAccount);

        const leadsWithPending = await Lead.find({ userId: req.userId, 'replies.status': 'pending' });
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
                msg.status = result.success ? 'sent' : 'failed';
                if (result.success) sentCount++;            }
            await lead.save();
        }
        res.json({ success: true, sentCount });
    } catch (err) {
        console.error('Auto-send Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ════════════════════════════════════════════
//  NOTIFICATIONS// ════════════════════════════════════════════
app.get('/api/my-notifications', verifyToken, async (req, res) => {
    try {
        const replyNotifications = await Message.find({ userId: req.userId, sessionId: 'reply-notification' }).sort({ createdAt: -1 });
        const adminMessages      = await Message.find({ userId: req.userId, sessionId: 'admin-direct-message' }).sort({ createdAt: -1 });
        const allNotifications   = [...replyNotifications, ...adminMessages].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json(allNotifications);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════
//  NYLAS AUTH
// ════════════════════════════════════════════
app.get('/api/auth/nylas/url', verifyToken, (req, res) => {
    const userId      = req.userId;
    const randomState = uuidv4();
    stateStore[randomState] = userId;
    setTimeout(() => { delete stateStore[randomState]; }, 10 * 60 * 1000);
    res.json({ url: getAuthUrl(randomState) });
});

app.get('/api/auth/nylas/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return res.redirect('https://skylineai-app.vercel.app/dashboard.html?connected=false&error=' + oauthError);
    if (!code || !state) return res.status(400).send('Missing required parameters.');
    const userId = stateStore[state];
    if (!userId) return res.status(400).send('Session expired. Please try connecting again.');
    delete stateStore[state];
    try {
        const tokenData   = await exchangeCodeForToken(code);
        const accessToken  = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;
        const grantId      = tokenData.grant_id;

        if (!refreshToken) {
            console.error('❌ [NYLAS CALLBACK] No refresh_token returned from Nylas! Ensure offline_access scope is enabled in your Nylas app settings.');
        }
        let emailAddress = 'unknown@nylas.com';
        try {
            emailAddress = await getUserEmail(accessToken);
        } catch (emailErr) {
            console.warn(`⚠️ Could not retrieve email: ${emailErr.message}`);
        }

        await User.findByIdAndUpdate(userId, {
            'nylasIntegration.accessToken':  accessToken,
            'nylasIntegration.emailAddress': emailAddress,            'nylasIntegration.isConnected':  true,
            'nylasIntegration.connectedAt':  new Date()
        });

        if (grantId) {
            const saved = await EmailAccount.findOneAndUpdate(
                { nylasGrantId: grantId },
                {
                    userId,
                    emailAddress,
                    isConnected:      true,
                    provider:         'gmail',
                    accessToken,
                    refreshToken,
                    tokenExpiry:      new Date(Date.now() + 3600 * 1000),
                    refreshFailCount: 0,
                    lastRefreshError: null
                },
                { upsert: true, new: true }
            );
            console.log(`✅ [AUTH] Grant ${grantId} linked to User ${userId} — refreshToken saved: ${!!saved.refreshToken}`);
        }

        res.redirect('https://skylineai-app.vercel.app/dashboard.html?connected=true');
    } catch (err) {
        console.error(`❌ Nylas Callback Error: ${err.message}`);
        res.redirect(`https://skylineai-app.vercel.app/dashboard.html?connected=false&error=token_exchange_failed`);
    }
});

// ════════════════════════════════════════════
//  OTHER ROUTES
// ════════════════════════════════════════════
app.get('/api/notifications/replies', verifyToken, async (req, res) => {
    try {
        const repliedLeads = await Lead.find({ userId: req.userId, status: 'Replied' }).sort({ lastContactDate: -1 });
        res.json({ count: repliedLeads.length, leads: repliedLeads });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }});

app.post('/api/chat', verifyToken, checkSubscriptionExpiry, checkDailyLimit, async (req, res) => {
    const { message, history, sessionId } = req.body;
    const userId = req.userId;
    if (!message) return res.status(400).json({ message: 'Message is required' });
    const currentSessionId = sessionId || uuidv4();
    const user = await User.findById(userId);
    const plan = user.subscriptionTier || 'free';
    try {        await new Message({
            userId,
            sessionId: currentSessionId,
            role:      'user',
            content:   message,
            title:     message.substring(0, 30) + '...'
        }).save();

        let aiReply, updatedHistory;
        if (plan === 'free') {
            const result  = await freeAI.generateFreeResponse(message, history || [], user);
            aiReply       = result.reply;
            updatedHistory = result.updatedHistory;
        } else if (plan === 'go') {
            try {
                const result  = await goAI.generateGoResponse(message, history || [], user);
                aiReply       = result ? result.reply : "⚠️ Go AI Service unavailable.";
                updatedHistory = result ? (result.updatedHistory || []) : [];
            } catch (goError) {
                aiReply = "⚠️ Go AI Service currently unavailable.";
            }
        } else {
            const userProfile = {
                fullName:    user.fullName,
                country:     user.country,
                skillLevel:  user.skillLevel,
                primaryGoal: user.primaryGoal,
                interests:   user.interests,
                bio:         user.bio,
                userId:      user._id.toString()
            };
            const result  = await requestQueue.enqueue(async () => generateBusinessResponse(message, history || [], userProfile));
            aiReply       = result.reply;
            updatedHistory = result.updatedHistory;
        }

        await new Message({ userId, sessionId: currentSessionId, role: 'ai', content: aiReply }).save();
        res.json({ reply: aiReply, sessionId: currentSessionId, history: updatedHistory });
    } catch (error) {
        console.error('Chat route error:', error);
        res.status(500).json({ message: error.message || 'Server Error' });    }
});

app.get('/api/leads', verifyToken, async (req, res) => {
    try {
        const leads = await Lead.find({ userId: req.userId }).sort({ createdAt: -1 });
        res.json(leads);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });    }
});

app.post('/api/feedback', verifyToken, async (req, res) => {
    try {
        const { messageId, type } = req.body;
        if (!messageId || !['like', 'dislike'].includes(type)) return res.status(400).json({ message: 'Invalid feedback data' });
        const message = await Message.findById(messageId);
        if (!message) return res.status(404).json({ message: 'Message not found' });
        if (message.userId.toString() !== req.userId) return res.status(403).json({ message: 'Unauthorized' });
        message.feedback = message.feedback === type ? null : type;
        await message.save();
        res.json({ success: true, feedback: message.feedback });
    } catch (err) {
        res.status(500).json({ message: 'Server Error saving feedback' });
    }
});

app.get('/api/sessions', verifyToken, checkSubscriptionExpiry, async (req, res) => {
    try {
        const sessions = await Message.aggregate([
            { $match: { userId: new mongoose.Types.ObjectId(req.userId) } },
            { $sort:  { createdAt: -1 } },
            { $group: { _id: '$sessionId', title: { $first: '$title' }, lastUpdated: { $first: '$createdAt' } } },
            { $sort:  { lastUpdated: -1 } }
        ]);
        res.json(sessions);
    } catch (error) {
        res.status(500).json({ message: 'Server Error fetching sessions' });
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

app.post('/api/dreams/analyze', verifyToken, checkSubscriptionExpiry, checkDailyLimit, async (req, res) => {    const { dream, sessionId } = req.body;
    const userId = req.userId;
    if (!dream) return res.status(400).json({ message: 'Dream description is required' });
    const currentSessionId = sessionId || uuidv4();
    try {
        await new Message({ userId, sessionId: currentSessionId, role: 'user', content: dream, title: dream.substring(0, 30) + '...' }).save();
        const user        = await User.findById(userId);
        const userProfile = { fullName: user.fullName, country: user.country, skillLevel: user.skillLevel, primaryGoal: user.primaryGoal, interests: user.interests, bio: user.bio, userId: user._id.toString() };        const result      = await requestQueue.enqueue(async () => generateBusinessResponse(dream, [], userProfile));
        await new Message({ userId, sessionId: currentSessionId, role: 'ai', content: result.reply }).save();
        res.json({ plan: result.reply, audit: {}, sessionId: currentSessionId });
    } catch (error) {
        res.status(500).json({ message: error.message || 'Server Error' });
    }
});

app.post('/api/dreams/refine', verifyToken, checkSubscriptionExpiry, checkDailyLimit, async (req, res) => {
    const { followUpAnswer, dreamDescription, sessionId } = req.body;
    const userId = req.userId;
    if (!followUpAnswer || !dreamDescription) return res.status(400).json({ message: 'followUpAnswer and dreamDescription are required' });
    const currentSessionId = sessionId || uuidv4();
    try {
        await new Message({ userId, sessionId: currentSessionId, role: 'user', content: followUpAnswer }).save();
        const user        = await User.findById(userId);
        const userProfile = { fullName: user.fullName, country: user.country, skillLevel: user.skillLevel, primaryGoal: user.primaryGoal, interests: user.interests, bio: user.bio, userId: user._id.toString() };
        const result      = await requestQueue.enqueue(async () => generateBusinessResponse(followUpAnswer, [], userProfile));
        await new Message({ userId, sessionId: currentSessionId, role: 'ai', content: result.reply }).save();
        res.json({ plan: result.reply, audit: {}, sessionId: currentSessionId });
    } catch (error) {
        res.status(500).json({ message: error.message || 'Server Error' });
    }
});

app.get('/api/users/me', verifyToken, checkSubscriptionExpiry, async (req, res) => {
    try {
        const user = await User.findById(req.userId).select('-password');
        if (!user) return res.status(404).json({ message: 'User not found' });
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
        if (fullName)       user.fullName       = fullName;
        if (primaryGoal)    user.primaryGoal    = primaryGoal;
        if (skillLevel)     user.skillLevel     = skillLevel;        if (interests)      user.interests      = interests;
        if (country)        user.country        = country;
        if (bio)            user.bio            = bio;
        if (profilePicture) user.profilePicture = profilePicture;
        await user.save();
        res.json(user);
    } catch (err) {        res.status(500).json({ message: 'Server Error' });
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
        const salt    = await bcrypt.genSalt(10);
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

app.post('/api/admin/verify-layer-2', verifyToken, verifyLayer2);
app.post('/api/admin/verify-layer-3', verifyToken, verifyLayer3);

app.get('/api/admin/users', verifyToken, async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user || !user.isAdmin) return res.status(403).json({ message: 'Access denied. Admins only.' });
        const users = await User.find().select('-password');
        res.json(users);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.put('/api/admin/users/:id/suspend', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const targetUser = await User.findById(req.params.id);        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        targetUser.isSuspended    = !targetUser.isSuspended;
        targetUser.suspensionEnds = targetUser.isSuspended ? new Date('2099-12-31') : null;
        await targetUser.save();
        res.json({ message: 'Status updated' });
    } catch (err) {        res.status(500).json({ message: 'Server Error' });
    }
});

app.delete('/api/admin/users/:id', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        await User.findByIdAndDelete(req.params.id);
        res.json({ message: 'User deleted' });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.get('/api/admin/users/:id/details', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const targetUser = await User.findById(req.params.id).select('-password');
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        const messages = await Message.find({ userId: req.params.id }).sort({ createdAt: 1 });
        res.json({ user: targetUser, history: messages });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.get('/api/admin/users/:id/chat-view', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const targetUser = await User.findById(req.params.id).select('-password');
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        const chatMessages = await Message.find({ userId: req.params.id }).sort({ createdAt: 1 });
        res.json({ user: targetUser, messages: chatMessages });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.post('/api/admin/users/:id/message', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });        const { messageContent } = req.body;
        if (!messageContent) return res.status(400).json({ message: 'Message content is required' });
        const targetUser = await User.findById(req.params.id);
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        await new Message({            userId:    req.params.id,
            sessionId: 'admin-direct-message',
            role:      'ai',
            content:   `[ADMIN MESSAGE]: ${messageContent}`,
            title:     'Direct Message from Admin'
        }).save();
        res.json({ message: 'Message sent successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.post('/api/reports', verifyToken, async (req, res) => {
    try {
        const { subject, message } = req.body;
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        await new Report({ userId: req.userId, username: user.username, subject, message }).save();
        res.json({ message: 'Report submitted successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.get('/api/admin/reports', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const reports = await Report.find().sort({ createdAt: -1 });
        res.json(reports);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.get('/api/notifications/count', verifyToken, async (req, res) => {
    try {
        const adminCount = await Message.countDocuments({ userId: req.userId, sessionId: 'admin-direct-message' });
        const replyCount = await Message.countDocuments({ userId: req.userId, sessionId: 'reply-notification' });
        res.json({ count: adminCount + replyCount });
    } catch (err) {
        res.status(500).json({ message: 'Server Error counting notifications' });
    }
});

// ════════════════════════════════════════════//  EXPIRY CHECK JOB
// ════════════════════════════════════════════
const scheduleExpiryCheck = async () => {
    try {        const result = await User.updateMany(
            { subscriptionTier: { $ne: 'free' }, subscriptionEndDate: { $lt: new Date() } },
            { subscriptionTier: 'free', subscriptionEndDate: null }
        );
        if (result.modifiedCount > 0) console.log(`🔄 Downgraded ${result.modifiedCount} expired users`);
    } catch (err) {
        console.error('Error in expiry check:', err);
    }
};
setTimeout(() => {
    scheduleExpiryCheck();
    setInterval(scheduleExpiryCheck, 24 * 60 * 60 * 1000);
}, 5000);

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => { console.log(`🚀 Server running on port ${PORT}`); });
