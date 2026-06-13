const Notification = require('./Notification');   // NEW
const Lead = require('./Lead');

// GET /api/my-notifications
const getMyNotifications = async (req, res) => {
    try {
        const notifications = await Notification.find({ userId: req.userId }).sort({ createdAt: -1 });
        res.json(notifications);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// GET /api/notifications/replies
const getRepliesCount = async (req, res) => {
    try {
        const repliedLeads = await Lead.find({ userId: req.userId, status: 'Replied' }).sort({ lastContactDate: -1 });
        res.json({ count: repliedLeads.length, leads: repliedLeads });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// GET /api/notifications/count
const getNotificationCount = async (req, res) => {
    try {
        const count = await Notification.countDocuments({ userId: req.userId, isRead: false });
        res.json({ count });
    } catch (err) {
        res.status(500).json({ message: 'Server Error counting notifications' });
    }
};

module.exports = {
    getMyNotifications,
    getRepliesCount,
    getNotificationCount
};
