const User = require('./User');

const scheduleExpiryCheck = async () => {
    try {
        const result = await User.updateMany(
            { subscriptionTier: { $ne: 'free' }, subscriptionEndDate: { $lt: new Date() } },
            { subscriptionTier: 'free', subscriptionEndDate: null }
        );
        if (result.modifiedCount > 0) console.log(`🔄 Downgraded ${result.modifiedCount} expired users`);
    } catch (err) {
        console.error('Error in expiry check:', err);
    }
};

const startExpiryJob = () => {
    setTimeout(() => {
        scheduleExpiryCheck();
        setInterval(scheduleExpiryCheck, 24 * 60 * 60 * 1000);
    }, 5000);
};

module.exports = { startExpiryJob };
