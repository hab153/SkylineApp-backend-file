const User = require('./User');

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

module.exports = { checkSubscriptionExpiry };
