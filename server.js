const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

// IMPORT NEW AI FILES FOR TIERS
const freeAI = require('./Free');
const goAI = require('./Go');
// FIXED: Only import generateBusinessResponse as it handles all intents
const { generateBusinessResponse } = require('./businessAI'); 

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
//  CHECK SUBSCRIPTION EXPIRY MIDDLEWARE
// ════════════════════════════════════════════
const checkSubscriptionExpiry = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        
        // Check if paid subscription has expired
        if (user.subscriptionTier && user.subscriptionTier !== 'free' && user.subscriptionEndDate) {
            const now = new Date();                        
            const endDate = new Date(user.subscriptionEndDate);                        
            if (now > endDate) {
                // Auto-downgrade to free                
                user.subscriptionTier = 'free';
                user.subscriptionEndDate = null;
                await user.save();
                console.log(`⚠️ User ${user._id} downgraded to free - subscription expired`);
            }                        }        
        next();
    } catch (err) {
        console.error('Error checking subscription expiry:', err);
        next();
    }
};

// ════════════════════════════════════════════
//  WEBHOOK ROUTE - UPDATED FOR 3 TIERS
// ════════════════════════════════════════════
app.post('/api/flutterwave-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    console.log("🔥 Webhook hit!");
    
    const sig = req.headers['verif-hash'];
    const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
    
    // Verify signature (Security Check)
    if (secretHash && sig !== secretHash) {
        console.log("⚠️ Hash mismatch - check your FLUTTERWAVE_SECRET_HASH");
        return res.status(401).send('Unauthorized');
    }

    try {
        const payload = JSON.parse(req.body.toString());
        
        let txRef, status, planType;
        
        // Handle different payload structures (Test vs Live)
        if (payload.status) {
            // Test Mode / Direct Status
            status = payload.status;
            txRef = payload.txRef || payload.tx_ref;
            planType = payload.meta?.plan;
        } else if (payload.event === 'charge.completed') {
            // Live Mode Event
            status = payload.data?.status;
            txRef = payload.data?.tx_ref;
            planType = payload.data?.meta?.plan;
        }

        if (status === 'successful') {            
            console.log(`✅ Payment successful for txRef: ${txRef}`);
            if (!txRef) return res.status(400).send('Missing txRef');                        
            
            // Infer plan from txRef if meta is missing (Safety Net)
            if (!planType) {                
                if (txRef.includes('_go_')) planType = 'go';                
                else if (txRef.includes('_pro_')) planType = 'pro';
                else planType = 'free';                                    }

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
                console.error(`❌ User not found for txRef: ${txRef}`);
            }
        } else {
            console.log(`ℹ️ Webhook received but payment not successful. Status: ${status || 'unknown'}`);
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
        req.userId = decoded.user.id;                        next();
    } catch (err) {
        console.error('Token Verification Failed:', err.message);        
        return res.status(401).json({ message: 'Invalid token' });        
    }
};

// ── Daily Usage Limit Middleware (UPDATED: FREE = 30) ──
const checkDailyLimit = async (req, res, next) => {
    try {
        // 1. Fetch Fresh User Data
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        // 2. Initialize Usage Object if Missing (Crucial for new/old users)
        if (!user.usage) {
            user.usage = {
                dailyCallCount: 0,
                lastCallDate: new Date()
            };
        }

        // 3. Define Limits Based on TIER
        let limit = 30; // Free Limit (Updated from 4 to 30)
        if (user.subscriptionTier === 'go') limit = 18; 
        if (user.subscriptionTier === 'pro') limit = 40; 

        const now = new Date();
        const todayStr = now.toDateString();
        
        // Handle case where lastCallDate might be missing or invalid
        const lastCallDate = user.usage.lastCallDate ? new Date(user.usage.lastCallDate) : null;
        const lastCallStr = lastCallDate ? lastCallDate.toDateString() : '';

        // 4. Reset Count if it's a New Day
        if (lastCallStr !== todayStr) {
            user.usage.dailyCallCount = 0;
            user.usage.lastCallDate = now;            
            await user.save(); // Save the reset
        }

        // 5. Check Limit
        if (user.usage.dailyCallCount >= limit) {
            return res.status(429).json({ 
                message: `Daily limit reached (${limit}/${limit}). Upgrade your plan for more.` 
            });
        }

        // 6. Increment and Save
        user.usage.dailyCallCount += 1;                await user.save();

        next(); // Proceed to the actual route

    } catch (err) {
        console.error('Error checking daily limit:', err);
        res.status(500).json({ message: 'Server Error checking usage limits' });
    }
};

// ════════════════════════════════════════════
//  FLUTTERWAVE PAYMENT ROUTES (UPDATED PRICES: GO $9, PRO $20)
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

            // Determine plan type from txRef if not in meta                        let planType = 'pro'; // Default fallback
            if (tx_ref.includes('_go_')) planType = 'go';
            else if (tx_ref.includes('_pro_')) planType = 'pro';

            const updatedUser = await User.findByIdAndUpdate(
                userId, 
                {
                    subscriptionTier: planType,                    
                    subscriptionEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                    lastTxRef: null                
                },
                { new: true }
            );                        
            if (updatedUser) {
                console.log(`✅ User ${userId} upgraded to ${planType.toUpperCase()} via manual verification.`);
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

// Initialize Payment Route (UPDATED PRICES)
app.post('/api/create-flutterwave-payment', verifyToken, async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const { planType } = req.body; // 'go' or 'pro' from frontend
        let amount = 0;
        let planName = '';
        if (planType === 'go') {
            amount = 9; // NEW PRICE FOR GO            
            planName = 'Skyline AA-1 GO Plan';
        } else if (planType === 'pro') {
            amount = 20; // NEW PRICE FOR PRO
            planName = 'Skyline AA-1 PRO Plan';
        } else {
            return res.status(400).json({ message: 'Invalid plan type' });
        }

        const vercelUrl = process.env.VERCEL_URL || 'https://skylineai-app.vercel.app';                         const txRef = `skyline_${planType}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

        // Save txRef to user BEFORE creating payment
        user.lastTxRef = txRef;
        await user.save();
        console.log(`💾 Saved txRef ${txRef} to user ${user._id} for plan ${planType}`);
        const payload = {
            tx_ref: txRef,
            amount: amount,            
            currency: "USD", 
            redirect_url: `${vercelUrl}/payment-success.html?tx_ref=${txRef}`,            
            customer: {                
                email: user.email,
                phonenumber: user.phone || "08012345678",
                name: user.fullName || user.username,
            },
            customizations: {
                title: planName,
                description: 'Monthly Subscription',
                logo: 'https://your-logo-url.com/logo.png',
            },
            meta: {
                userId: user._id.toString(),
                plan: planType
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
        } else {
            console.error('❌ Failed to initialize payment:', response.data);            
            res.status(400).json({ message: 'Failed to initialize payment', error: response.data });
        }    
    } catch (error) {
        console.error('❌ Flutterwave Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Server Error initializing payment' });
    }
});

// ════════════════════════════════════════════//  CHAT ROUTE (THE AI ROUTER)
// ════════════════════════════════════════════

app.post('/api/chat', verifyToken, checkSubscriptionExpiry, checkDailyLimit, async (req, res) => {    
    const { message, history, sessionId } = req.body;    
    const userId = req.userId;
    if (!message) return res.status(400).json({ message: 'Message is required' });

    const currentSessionId = sessionId || uuidv4();
    const user = await User.findById(userId);
    const plan = user.subscriptionTier || 'free';    
    
    try {
        await new Message({
            userId,
            sessionId: currentSessionId,
            role: 'user',
            content: message,
            title: message.substring(0, 30) + '...'
        }).save();

        let aiReply, updatedHistory;

        // ROUTE TO CORRECT AI FILE BASED ON PLAN
        if (plan === 'free') {
            console.log("🟢 Routing to Free AI");
            const result = await freeAI.generateFreeResponse(message, history || [], user);
            aiReply = result.reply;
            updatedHistory = result.updatedHistory;
        } 
        else if (plan === 'go') {
            console.log("🟡 Routing to Go AI");
            try {
                const result = await goAI.generateGoResponse(message, history || [], user);
                
                // SAFETY CHECK: Ensure result exists
                if (result && result.reply) {
                    aiReply = result.reply;
                    updatedHistory = result.updatedHistory || [];
                } else {
                    console.error("❌ Go AI returned empty result");
                    aiReply = "⚠️ Sorry, I encountered an internal error. Please try again.";
                }
            } catch (goError) {
                console.error("❌ Go AI Route Error:", goError);
                aiReply = "⚠️ Go AI Service is currently unavailable.";
            }
        } 
        else {
            // PRO PLAN uses BusinessAI (Existing Logic)                        console.log("🔴 Routing to Pro/Business AI");
            const userProfile = {
                fullName: user.fullName, country: user.country, skillLevel: user.skillLevel,
                primaryGoal: user.primaryGoal, interests: user.interests, bio: user.bio,
                userId: user._id.toString()
            };
            const result = await requestQueue.enqueue(async () => {                
                // FIXED: Use generateBusinessResponse
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
        res.status(500).json({ message: error.message || 'Server Error' });
    }
});

// ════════════════════════════════════════════
//  FEEDBACK ROUTE (LIKE / DISLIKE) - NEW
// ════════════════════════════════════════════
app.post('/api/feedback', verifyToken, async (req, res) => {
    try {
        const { messageId, type } = req.body; // type is 'like' or 'dislike'
        
        if (!messageId || !['like', 'dislike'].includes(type)) {
            return res.status(400).json({ message: 'Invalid feedback data' });
        }

        // Find the message and update feedback
        const message = await Message.findById(messageId);
        
        if (!message) {
            return res.status(404).json({ message: 'Message not found' });
        }

        // Optional: Ensure the user owns this message/session
        if (message.userId.toString() !== req.userId) {
            return res.status(403).json({ message: 'Unauthorized' });
        }
        // If clicking the same button again, toggle it off (optional UX)        if (message.feedback === type) {
            message.feedback = null;
        } else {
            message.feedback = type;
        }
        
        await message.save();

        res.json({ success: true, feedback: message.feedback });

    } catch (err) {        
        console.error('Feedback Error:', err);
        res.status(500).json({ message: 'Server Error saving feedback' });
    }
});

// ════════════════════════════════════════════
//  OTHER PROTECTED API ROUTES (WITH EXPIRY CHECK)
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
    } catch (error) {                res.status(500).json({ message: 'Server Error fetching history' });
    }
});

// 3. Analyze Dream & Generate Squibb-Style Plan
// FIXED: Now uses generateBusinessResponse which detects 'planner' or 'mastery' intent
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
            bio:         user.bio,
            userId:      user._id.toString()
        };

        // FIXED: Use generateBusinessResponse instead of generateDreamPlan
        const result = await requestQueue.enqueue(async () => {
            return await generateBusinessResponse(dream, [], userProfile);
        });

        await new Message({
            userId,
            sessionId: currentSessionId,
            role: 'ai',
            content: result.reply
        }).save();

        res.json({ 
            plan: result.reply, 
            audit: {}, 
            sessionId: currentSessionId         
        });
    } catch (error) {
        console.error('Dream analyze error:', error);
        res.status(500).json({ message: error.message || 'Server Error' });
    }
});

// 4b. Refine an existing plan
// FIXED: Now uses generateBusinessResponse which handles follow-ups naturally
app.post('/api/dreams/refine', verifyToken, checkSubscriptionExpiry, checkDailyLimit, async (req, res) => {
    const { originalPlan, followUpAnswer, dreamDescription, sessionId } = req.body;    
    const userId = req.userId;    
    
    if (!followUpAnswer || !dreamDescription) {
        return res.status(400).json({
            message: 'followUpAnswer and dreamDescription are required'        
        });
    }

    const currentSessionId = sessionId || uuidv4();        
    try {
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
            bio:         user.bio,
            userId:      user._id.toString()
        };

        // FIXED: Use generateBusinessResponse instead of refinePlan
        const result = await requestQueue.enqueue(async () => {
            return await generateBusinessResponse(followUpAnswer, [], userProfile);
        });

        await new Message({
            userId,
            sessionId: currentSessionId,
            role: 'ai',
            content: result.reply        
        }).save();
        res.json({ 
            plan: result.reply, 
            audit: {}, 
            sessionId: currentSessionId 
        });

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
    try {        
        const { fullName, primaryGoal, skillLevel, interests, country, bio, profilePicture } = req.body;

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
app.put('/api/auth/change-password', verifyToken, async (req, res) => {        const { currentPassword, newPassword } = req.body;

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
        console.error(err);        res.status(500).json({ message: 'Server Error' });
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
    try {        const admin = await User.findById(req.userId);
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
            sessionId: 'admin-direct-message',             
            role: 'ai', 
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
            userId: req.userId,            username: user.username,
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
        console.error(err);        res.status(500).json({ message: 'Server Error counting notifications' });
    }
});

// Scheduled expiry check (runs daily at midnight)
const scheduleExpiryCheck = async () => {
    try {
        const now = new Date();
        const result = await User.updateMany(
            {                
                subscriptionTier: { $ne: 'free' }, // Check all non-free plans                
                subscriptionEndDate: { $lt: now }
            },
            {
                subscriptionTier: 'free',
                subscriptionEndDate: null
            }
        );
        if (result.modifiedCount > 0) {
            console.log(`🔄 Downgraded ${result.modifiedCount} expired users`);
        }    
    } catch (err) {
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
