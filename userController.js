// userController.js
// UPDATED: Uses researchLimitService for accurate research limits

const bcrypt = require('bcryptjs');
const User = require('./User');
const { changeEmail, verifyAge } = require('./authController');
const { isValidObjectId, sanitizeObject } = require('./sanitize');
const { deleteAccount, deactivateAccount, restoreAccount, getDeletionStatus } = require('./deleteAccount');
const { getRemainingLimits } = require('./limitService');           // For emails + chats
const { getRemaining: getResearchRemaining } = require('./researchLimitService'); // ⭐ For research

// ─── ✅ GET /api/user/dashboard-data ───
const getDashboardData = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }

        const userId = req.userId;

        console.log(`📡 [DASHBOARD] Fetching fresh data for user: ${userId}`);

        const user = await User.findById(userId)
            .select('email username fullName subscriptionTier subscriptionEndDate nylasIntegration')
            .lean();

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // ─── Email connection status ───
        let emailStatus = {
            connected: false,
            email: null,
            isExpired: false
        };

        if (user.nylasIntegration && user.nylasIntegration.isConnected) {
            emailStatus.connected = true;
            emailStatus.email = user.nylasIntegration.emailAddress || null;

            if (user.nylasIntegration.tokenExpiry) {
                emailStatus.isExpired = new Date() > new Date(user.nylasIntegration.tokenExpiry);
            }
        }

        // ⭐ Get real limits — research from NEW service, emails/chats from OLD
        const generalLimits = await getRemainingLimits(userId);
        const researchData = await getResearchRemaining(userId);

        const limits = {
            emails: generalLimits.emails,
            research: researchData.research,  // ⭐ From new service
            chats: generalLimits.chats
        };

        const dashboardData = {
            subscription: {
                tier: user.subscriptionTier || 'free',
                endDate: user.subscriptionEndDate || null
            },
            email: emailStatus,
            user: {
                id: user._id,
                email: user.email,
                username: user.username,
                fullName: user.fullName || user.username
            },
            limits: limits
        };

        console.log(`✅ [DASHBOARD] Data fetched for user: ${userId}`, limits);
        res.json(dashboardData);

    } catch (error) {
        console.error('❌ [getDashboardData] Error:', error.message);
        res.status(500).json({
            message: 'Server Error fetching dashboard data',
            error: error.message
        });
    }
};

// ─── ⭐ GET /api/users/me (UPDATED) ───
const getUserProfile = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }

        const user = await User.findById(req.userId).select('-password').lean();
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // ⭐ Get real limits
        const generalLimits = await getRemainingLimits(req.userId);
        const researchData = await getResearchRemaining(req.userId);

        // ⭐ Build combined limits object
        const remainingLimits = {
            emails: generalLimits.emails,
            research: researchData.research,  // ⭐ From new service
            chats: generalLimits.chats
        };

        console.log(`✅ [getUserProfile] User: ${req.userId} | Limits:`, remainingLimits);

        const userProfile = {
            ...user,
            remainingLimits: remainingLimits
        };

        res.json(userProfile);
    } catch (err) {
        console.error('[getUserProfile] Error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ─── PUT /api/users/me ───
const updateUserProfile = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }

        const sanitizedBody = sanitizeObject(req.body);
        const { fullName, primaryGoal, skillLevel, interests, country, bio, profilePicture } = sanitizedBody;

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
        console.error('[updateUserProfile] Error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ─── PUT /api/auth/change-password ───
const changePassword = async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }

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
        console.error('[changePassword] Error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ─── DELETE /api/users/me ───
const deleteUserAccount = async (req, res) => {
    try {
        const { password, reason = 'User requested permanent deletion' } = req.body;

        if (!password) {
            return res.status(400).json({
                error: 'Password is required to delete your account'
            });
        }

        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const result = await deleteAccount(req.userId, password, req);

        return res.json({
            success: true,
            message: result.message,
            redirect: '/login?deleted=true'
        });

    } catch (error) {
        console.error('[UserController] deleteUserAccount error:', error);

        if (error.message === 'Invalid password') {
            return res.status(401).json({ error: 'Invalid password. Please try again.' });
        }
        if (error.message === 'User not found') {
            return res.status(404).json({ error: 'User not found' });
        }

        return res.status(500).json({
            error: 'Failed to delete account. Please try again or contact support.'
        });
    }
};

// ─── POST /api/users/me/deactivate ───
const deactivateUserAccount = async (req, res) => {
    try {
        const { password, reason = 'User requested deactivation' } = req.body;

        if (!password) {
            return res.status(400).json({ error: 'Password is required' });
        }

        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).json({ error: 'Invalid password' });
        }

        const result = await deactivateAccount(req.userId, reason, req);
        return res.json(result);

    } catch (error) {
        console.error('[UserController] deactivateUserAccount error:', error);
        if (error.message === 'Invalid password') {
            return res.status(401).json({ error: 'Invalid password' });
        }
        return res.status(500).json({ error: 'Failed to deactivate account' });
    }
};

// ─── POST /api/users/me/restore ───
const restoreUserAccount = async (req, res) => {
    try {
        const { reason = 'User requested restoration' } = req.body;

        const result = await restoreAccount(req.userId, reason);
        return res.json(result);
    } catch (error) {
        console.error('[UserController] restoreUserAccount error:', error);
        return res.status(400).json({
            error: error.message || 'Failed to restore account'
        });
    }
};

// ─── GET /api/users/me/deletion-status ───
const getDeletionStatusHandler = async (req, res) => {
    try {
        const result = await getDeletionStatus(req.userId);
        return res.json(result);
    } catch (error) {
        console.error('[UserController] getDeletionStatus error:', error);
        return res.status(404).json({ error: error.message || 'User not found' });
    }
};

// ─── ⭐ GET /api/users/me/usage (UPDATED) ───
const getUserUsage = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }

        // ⭐ Use new service for research
        const generalLimits = await getRemainingLimits(req.userId);
        const researchData = await getResearchRemaining(req.userId);

        const user = await User.findById(req.userId).select('subscriptionTier').lean();
        const tier = user?.subscriptionTier || 'free';

        const planLimits = {
            free: { emails: 30, research: 4, chats: 30 },
            go: { emails: 70, research: 10, chats: 90 },
            pro: { emails: 120, research: 20, chats: 150 }
        };

        const max = planLimits[tier] || planLimits.free;

        res.json({
            limits: {
                email: {
                    used: max.emails - generalLimits.emails,
                    max: max.emails,
                    remaining: generalLimits.emails
                },
                research: {
                    used: max.research - researchData.research,  // ⭐ Uses new value
                    max: max.research,
                    remaining: researchData.research
                },
                chat: {
                    used: max.chats - generalLimits.chats,
                    max: max.chats,
                    remaining: generalLimits.chats
                }
            },
            tier: tier,
            resetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        });

    } catch (err) {
        console.error('[getUserUsage] Error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ─── Wrappers for authController functions ───
const changeEmailWrapper = (req, res) => changeEmail(req, res);
const verifyAgeWrapper = (req, res) => verifyAge(req, res);

module.exports = {
    getUserProfile,
    updateUserProfile,
    changePassword,
    changeEmail: changeEmailWrapper,
    verifyAge: verifyAgeWrapper,
    deleteUserAccount,
    deactivateUserAccount,
    restoreUserAccount,
    getDeletionStatus: getDeletionStatusHandler,
    getDashboardData,
    getUserUsage
};
