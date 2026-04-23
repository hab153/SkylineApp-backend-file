const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const authRoutes = require('./authRoutes');
const { generateDreamPlan, chat, refinePlan } = require('./businessAI');
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
//  CHECK SUBSCRIPTION EXPIRY MIDDLEWARE
// ════════════════════════════════════════════
const checkSubscriptionExpiry = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        
        // Check if pro subscription has expired
        if (user.subscriptionTier === 'pro' && user.subscriptionEndDate) {
            const now = new Date();
            const endDate = new Date(user.subscriptionEndDate);
            
            if (now > endDate) {
                // Auto-downgrade to free
                user.subscriptionTier = 'free';
                user.subscriptionEndDate = null;
                await user.save();
                console.log(`⚠️ User ${user._id} downgraded to free - subscription expired`);
            }
        }
        
        next();
    } catch (err) {
        console.error('Error checking subscription expiry:', err);        next();
    }
};

// ════════════════════════════════════════════
//  WEBHOOK ROUTE - FIXED FOR FLUTTERWAVE TEST MODE
// ════════════════════════════════════════════
app.post('/api/flutterwave-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    console.log("🔥 Webhook hit!");
    
    const sig = req.headers['verif-hash'];
    const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
    
    console.log("SIG:", sig);
    console.log("ENV HASH:", secretHash);
    
    // Verify signature (Security Check)
    if (secretHash && sig !== secretHash) {
        console.log("⚠️ Hash mismatch - check your FLUTTERWAVE_SECRET_HASH");
        return res.status(401).send('Unauthorized');
    }

    try {
        const payload = JSON.parse(req.body.toString());
        console.log("📦 Webhook Payload Received:", JSON.stringify(payload, null, 2));
        
        // FIX 1: Handle Flutterwave test mode payload structure
        if (payload.status === 'successful') {
            console.log("✅ Payment successful (detected from direct status field)");
            
            const txRef = payload.txRef || payload.tx_ref;
            
            if (!txRef) {
                console.error("❌ No txRef found in webhook payload!");
                return res.status(400).send('Missing txRef');
            }
            
            console.log(`🔍 Looking for user with txRef: ${txRef}`);
            
            // FIX 2: Find user by lastTxRef (saved during payment creation)
            const user = await User.findOne({ lastTxRef: txRef });
            
            if (!user) {
                console.error(`❌ User not found for txRef: ${txRef}`);
                return res.status(404).send("User not found");
            }
            
            console.log(`✅ Found user: ${user._id} (${user.email})`);
            
            // Update User to Pro Plan in Database            
            const updatedUser = await User.findByIdAndUpdate(
                user._id, 
                {
                    subscriptionTier: 'pro',
                    subscriptionEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                    lastTxRef: null // Clear after use
                },
                { new: true }
            );
            
            console.log(`🎉 User ${user._id} upgraded to Pro via Webhook!`);
            console.log(`📅 Subscription ends: ${updatedUser.subscriptionEndDate}`);
            
        } else if (payload.event === 'charge.completed' && payload.data?.status === 'successful') {
            // Fallback for live mode payload structure
            console.log("✅ Payment successful (detected from event/data structure)");
            
            const txRef = payload.data.tx_ref;
            const userId = payload.data.meta?.userId;
            
            if (userId) {
                const updatedUser = await User.findByIdAndUpdate(
                    userId, 
                    {
                        subscriptionTier: 'pro',
                        subscriptionEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                    },
                    { new: true }
                );
                
                if (updatedUser) {
                    console.log(`🎉 User ${userId} upgraded to Pro via Webhook!`);
                }
            } else if (txRef) {
                const user = await User.findOne({ lastTxRef: txRef });
                if (user) {
                    await User.findByIdAndUpdate(user._id, {
                        subscriptionTier: 'pro',
                        subscriptionEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                        lastTxRef: null
                    });
                    console.log(`🎉 User ${user._id} upgraded to Pro via Webhook (txRef fallback)!`);
                }
            }
        } else {
            console.log(`ℹ️ Webhook received but payment not successful. Status: ${payload.status || 'unknown'}`);
        }

        res.status(200).send('Webhook received');
    } catch (error) {
        console.error('❌ Webhook Error:', error);
        res.status(500).send('Webhook failed');
    }
});

// Now apply express.json() for all other routes
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

// ── Daily Usage Limit Middleware (UPDATED: 80 for Pro, 4 for Free) ──
const checkDailyLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        // DEFINE LIMITS
        const FREE_LIMIT = 4;       // Free users get 4 calls/day
        const PRO_LIMIT = 80;       // Pro users get 80 calls/day

        // Determine which limit applies to this user
        const limit = user.subscriptionTier === 'pro' ? PRO_LIMIT : FREE_LIMIT;

        const now = new Date();        const todayStr = now.toDateString();
        
        // Reset count if it's a new day
        if (!user.usage.lastCallDate || user.usage.lastCallDate.toDateString() !== todayStr) {
            if (!user.usage) user.usage = {};
            user.usage.dailyCallCount = 0;
            user.usage.lastCallDate = now;
            await user.save();
        }

        // Check if limit is reached
        if (user.usage.dailyCallCount >= limit) {
            return res.status(429).json({ 
                message: `Daily limit reached. You have used ${limit} calls today. Please come back tomorrow or upgrade your plan.` 
            });
        }

        // Increment count and save
        user.usage.dailyCallCount += 1;
        await user.save();

        next(); // Allow the request to proceed

    } catch (err) {
        console.error('Error checking daily limit:', err);
        res.status(500).json({ message: 'Server Error checking usage limits' });
    }
};

// ════════════════════════════════════════════
//  FLUTTERWAVE PAYMENT ROUTES
// ════════════════════════════════════════════

// Manual verification route (fallback)
app.get('/api/verify-payment/:tx_ref', async (req, res) => {
    try {
        const tx_ref = req.params.tx_ref;
        
        console.log(`🔍 Verifying payment for tx_ref: ${tx_ref}`);

        const response = await axios.get(
            `${process.env.FLUTTERWAVE_BASE_URL}/transactions/verify_by_reference?tx_ref=${tx_ref}`,
            {
                headers: {
                    Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
                },
            }
        );

        const data = response.data.data;        
        console.log(`📊 Verification response status: ${data.status}`);

        if (data.status === "successful") {
            let userId = data.meta?.userId;
            
            if (!userId) {
                const user = await User.findOne({ lastTxRef: tx_ref });
                if (user) {
                    userId = user._id;
                }
            }
            
            if (!userId) {
                console.error("❌ No userId found in verification response and no user found by txRef");
                return res.status(400).json({ success: false, message: "No userId found" });
            }
            
            console.log(`✅ Verifying payment for user: ${userId}`);

            const updatedUser = await User.findByIdAndUpdate(
                userId, 
                {
                    subscriptionTier: 'pro',
                    subscriptionEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                    lastTxRef: null
                },
                { new: true }
            );
            
            if (updatedUser) {
                console.log(`✅ User ${userId} upgraded to Pro via manual verification.`);
                return res.json({ success: true, message: "Payment verified and account upgraded" });
            } else {
                console.error(`❌ User ${userId} not found!`);
                return res.status(404).json({ success: false, message: "User not found" });
            }
        }

        res.json({ success: false, message: "Payment not successful" });

    } catch (err) {
        console.error('❌ Verification Error:', err.response?.data || err.message);
        res.status(500).json({ message: "Verification failed", error: err.message });
    }
});

// Initialize Payment Route (UPDATED - saves txRef to user)
app.post('/api/create-flutterwave-payment', verifyToken, async (req, res) => {
    try {        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const vercelUrl = process.env.VERCEL_URL || 'https://new-version-oesx.vercel.app'; 

        const amount = 10;
        const currency = "USD"; 
        const email = user.email;
        const fullName = user.fullName || user.username;        
        const txRef = `skyline_pro_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

        // Save txRef to user BEFORE creating payment
        user.lastTxRef = txRef;
        await user.save();
        console.log(`💾 Saved txRef ${txRef} to user ${user._id}`);

        const payload = {
            tx_ref: txRef,
            amount: amount,
            currency: currency,
            redirect_url: `${vercelUrl}/payment-success.html?tx_ref=${txRef}`,
            customer: {
                email: email,
                phonenumber: user.phone || "08012345678",
                name: fullName,
            },
            customizations: {
                title: 'Skyline AA-1 Pro Plan',
                description: 'Monthly Subscription for Unlimited Access',
                logo: 'https://your-logo-url.com/logo.png',
            },
            meta: {
                userId: user._id.toString(),
                plan: 'pro_monthly'
            }
        };

        console.log(`💰 Creating payment for user ${user._id}, tx_ref: ${txRef}`);

        const response = await axios.post(`${process.env.FLUTTERWAVE_BASE_URL}/payments`, payload, {
            headers: {
                Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
                'Content-Type': 'application/json',
            },
        });

        if (response.data.status === 'success') {
            console.log(`✅ Payment link created for user ${user._id}`);
            res.json({ link: response.data.data.link, tx_ref: txRef });
        } else {            console.error('❌ Failed to initialize payment:', response.data);
            res.status(400).json({ message: 'Failed to initialize payment', error: response.data });
        }
    } catch (error) {
        console.error('❌ Flutterwave Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Server Error initializing payment' });
    }
});

// ════════════════════════════════════════════
//  PROTECTED API ROUTES (WITH EXPIRY CHECK)
// ════════════════════════════════════════════

// 1. Get All Chat Sessions
app.get('/api/sessions', verifyToken, checkSubscriptionExpiry, async (req, res) => {
    try {        
        const sessions = await Message.aggregate([
            { $match: { userId: new mongoose.Types.ObjectId(req.userId) } },
            { $sort: { createdAt: -1 } },
            {
                $group: {
                    _id: '$sessionId',
                    title: { $first: '$title' },
                    lastUpdated: { $first: '$createdAt' }
                }
            },
            { $sort: { lastUpdated: -1 } }
        ]);
        res.json(sessions);
    } catch (error) {
        res.status(500).json({ message: 'Server Error fetching sessions' });
    }
});

// 2. Get Messages for a Specific Session
app.get('/api/history/:sessionId', verifyToken, checkSubscriptionExpiry, async (req, res) => {
    try {
        const messages = await Message.find({
            userId: req.userId,
            sessionId: req.params.sessionId
        }).sort({ createdAt: 1 });
        res.json(messages);
    } catch (error) {
        res.status(500).json({ message: 'Server Error fetching history' });
    }
});

// 3. Conversational Chat Route
app.post('/api/chat', verifyToken, checkSubscriptionExpiry, checkDailyLimit, async (req, res) => {
    const { message, history, sessionId } = req.body;    const userId = req.userId;
    if (!message) return res.status(400).json({ message: 'Message is required' });

    const currentSessionId = sessionId || uuidv4();

    try {
        await new Message({
            userId,
            sessionId: currentSessionId,
            role: 'user',
            content: message,
            title: message.substring(0, 30) + '...'
        }).save();

        const user = await User.findById(userId);        
        const userProfile = {
            fullName:    user.fullName,
            country:     user.country,
            skillLevel:  user.skillLevel,
            primaryGoal: user.primaryGoal,
            interests:   user.interests,
            bio:         user.bio
        };

        const { reply, updatedHistory } = await requestQueue.enqueue(async () => {
            return await chat(message, history || [], userProfile);
        });

        await new Message({
            userId,
            sessionId: currentSessionId,
            role: 'ai',
            content: reply
        }).save();

        res.json({ reply, sessionId: currentSessionId, history: updatedHistory });

    } catch (error) {
        console.error('Chat route error:', error);
        res.status(500).json({ message: error.message || 'Server Error' });
    }
});

// 4. Analyze Dream & Generate Squibb-Style Plan
app.post('/api/dreams/analyze', verifyToken, checkSubscriptionExpiry, checkDailyLimit, async (req, res) => {
    const { dream, sessionId } = req.body;
    const userId = req.userId;

    if (!dream) return res.status(400).json({ message: 'Dream description is required' });
    const currentSessionId = sessionId || uuidv4();    
    try {
        await new Message({
            userId,
            sessionId: currentSessionId,
            role: 'user',
            content: dream,
            title: dream.substring(0, 30) + '...'
        }).save();

        const user = await User.findById(userId);
        const userProfile = {
            fullName:    user.fullName,
            country:     user.country,
            skillLevel:  user.skillLevel,            
            primaryGoal: user.primaryGoal,
            interests:   user.interests,
            bio:         user.bio
        };
        const { plan, audit } = await requestQueue.enqueue(async () => {
            return await generateDreamPlan(dream, userProfile);
        });

        await new Message({
            userId,
            sessionId: currentSessionId,
            role: 'ai',
            content: JSON.stringify(plan)
        }).save();

        res.json({ plan, audit, sessionId: currentSessionId });

    } catch (error) {
        console.error('Dream analyze error:', error);
        res.status(500).json({ message: error.message || 'Server Error' });
    }
});

// 4b. Refine an existing plan
app.post('/api/dreams/refine', verifyToken, checkSubscriptionExpiry, checkDailyLimit, async (req, res) => {
    const { originalPlan, followUpAnswer, dreamDescription, sessionId } = req.body;
    const userId = req.userId;

    if (!originalPlan || !followUpAnswer || !dreamDescription) {
        return res.status(400).json({
            message: 'originalPlan, followUpAnswer, and dreamDescription are required'
        });
    }

    const currentSessionId = sessionId || uuidv4();        try {
        await new Message({
            userId,
            sessionId: currentSessionId,
            role: 'user',
            content: followUpAnswer
        }).save();

        const user = await User.findById(userId);
        const userProfile = {
            fullName:    user.fullName,
            country:     user.country,
            skillLevel:  user.skillLevel,
            primaryGoal: user.primaryGoal,            
            interests:   user.interests,
            bio:         user.bio
        };
        const { plan, audit } = await requestQueue.enqueue(async () => {
            return await refinePlan(originalPlan, followUpAnswer, dreamDescription, userProfile);
        });
        await new Message({
            userId,
            sessionId: currentSessionId,
            role: 'ai',
            content: JSON.stringify(plan)
        }).save();

        res.json({ plan, audit, sessionId: currentSessionId });

    } catch (error) {
        console.error('Plan refinement error:', error);
        res.status(500).json({ message: error.message || 'Server Error' });
    }
});

// 5. Get User Profile (with expiry check)
app.get('/api/users/me', verifyToken, checkSubscriptionExpiry, async (req, res) => {
    try {
        const user = await User.findById(req.userId).select('-password');
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(user);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// 6. Update User Profile
app.put('/api/users/me', verifyToken, checkSubscriptionExpiry, async (req, res) => {
    try {        const { fullName, primaryGoal, skillLevel, interests, country, bio, profilePicture } = req.body;

        let user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (fullName)       user.fullName       = fullName;
        if (primaryGoal)    user.primaryGoal    = primaryGoal;
        if (skillLevel)     user.skillLevel     = skillLevel;
        if (interests)      user.interests      = interests;
        if (country)        user.country        = country;
        if (bio)            user.bio            = bio;
        if (profilePicture) user.profilePicture = profilePicture;
        await user.save();
        res.json(user);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// 7. Change Password
app.put('/api/auth/change-password', verifyToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    try {
        let user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Current password is incorrect' });

        if (newPassword.length < 8)
            return res.status(400).json({ message: 'New password must be at least 8 characters' });

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        await user.save();

        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// 8. Change Email
app.put('/api/auth/change-email', verifyToken, changeEmail);

// 9. Verify Age
app.put('/api/users/verify-age', verifyToken, verifyAge);
// 10. Delete Account
app.delete('/api/users/me', verifyToken, async (req, res) => {
    await deleteAccount(req, res);
});

// ════════════════════════════════════════════
//  ADMIN LAYER ROUTES
// ════════════════════════════════════════════

app.post('/api/admin/verify-layer-2', verifyToken, verifyLayer2);
app.post('/api/admin/verify-layer-3', verifyToken, verifyLayer3);

app.get('/api/admin/users', verifyToken, async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user || !user.isAdmin)
            return res.status(403).json({ message: 'Access denied. Admins only.' });

        const users = await User.find().select('-password');
        res.json(users);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
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
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
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
        console.error(err);
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
        console.error('Chat View Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

app.post('/api/admin/users/:id/message', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const { messageContent } = req.body;
        if (!messageContent) return res.status(400).json({ message: 'Message content is required' });

        const targetUser = await User.findById(req.params.id);
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        const newMessage = new Message({
            userId: req.params.id,
            sessionId: 'admin-direct-message',             role: 'ai', 
            content: `[ADMIN MESSAGE]: ${messageContent}`,
            title: 'Direct Message from Admin'
        });

        await newMessage.save();

        res.json({ message: 'Message sent successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ════════════════════════════════════════════
//  REPORT ROUTES
// ════════════════════════════════════════════

app.post('/api/reports', verifyToken, async (req, res) => {
    try {
        const { subject, message } = req.body;
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const newReport = new Report({
            userId: req.userId,
            username: user.username,
            subject,
            message
        });
        await newReport.save();
        res.json({ message: 'Report submitted successfully' });
    } catch (err) {
        console.error(err);
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
// ════════════════════════════════════════════
//  NOTIFICATION ROUTES (USER)
// ════════════════════════════════════════════

app.get('/api/notifications', verifyToken, async (req, res) => {
    try {
        const notifications = await Message.find({ 
            userId: req.userId,             
            sessionId: 'admin-direct-message' 
        }).sort({ createdAt: -1 });
        
        res.json(notifications);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error fetching notifications' });
    }
});

app.get('/api/notifications/count', verifyToken, async (req, res) => {
    try {
        const count = await Message.countDocuments({ 
            userId: req.userId, 
            sessionId: 'admin-direct-message' 
        });
        
        res.json({ count });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server Error counting notifications' });
    }
});

// Scheduled expiry check (runs daily at midnight)
const scheduleExpiryCheck = async () => {
    try {
        const now = new Date();
        const result = await User.updateMany(
            {
                subscriptionTier: 'pro',
                subscriptionEndDate: { $lt: now }
            },
            {
                subscriptionTier: 'free',
                subscriptionEndDate: null
            }
        );
        
        if (result.modifiedCount > 0) {
            console.log(`🔄 Downgraded ${result.modifiedCount} expired pro users`);
        }    } catch (err) {
        console.error('Error in expiry check:', err);
    }
};

// Run expiry check on startup and every 24 hours
setTimeout(() => {
    scheduleExpiryCheck();
    setInterval(scheduleExpiryCheck, 24 * 60 * 60 * 1000);
}, 5000);

// ════════════════════════════════════════════
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
