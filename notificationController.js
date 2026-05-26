const Message = require('./Message');
const Lead = require('./Lead');

// GET /api/my-notifications
const getMyNotifications = async (req, res) => {
    try {
        const replyNotifications = await Message.find({ userId: req.userId, sessionId: 'reply-notification' }).sort({ createdAt: -1 });
        const adminMessages = await Message.find({ userId: req.userId, sessionId: 'admin-direct-message' }).sort({ createdAt: -1 });
        const allNotifications = [...replyNotifications, ...adminMessages].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json(allNotifications);
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
        const adminCount = await Message.countDocuments({ userId: req.userId, sessionId: 'admin-direct-message' });
        const replyCount = await Message.countDocuments({ userId: req.userId, sessionId: 'reply-notification' });
        res.json({ count: adminCount + replyCount });
    } catch (err) {
        res.status(500).json({ message: 'Server Error counting notifications' });
    }
};

module.exports = {
    getMyNotifications,
    getRepliesCount,
    getNotificationCount
};
