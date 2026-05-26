const User = require('./User');
const Message = require('./Message');
const Report = require('./Report');
const { verifyLayer2, verifyLayer3 } = require('./authController');

// Verification layers (direct passthrough)
const adminVerifyLayer2 = (req, res) => verifyLayer2(req, res);
const adminVerifyLayer3 = (req, res) => verifyLayer3(req, res);

// GET /api/admin/users
const getAllUsers = async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user || !user.isAdmin) return res.status(403).json({ message: 'Access denied. Admins only.' });
        const users = await User.find().select('-password');
        res.json(users);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// PUT /api/admin/users/:id/suspend
const suspendUser = async (req, res) => {
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
};

// DELETE /api/admin/users/:id
const deleteUser = async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        await User.findByIdAndDelete(req.params.id);
        res.json({ message: 'User deleted' });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// GET /api/admin/users/:id/details
const getUserDetails = async (req, res) => {
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
};

// GET /api/admin/users/:id/chat-view
const getUserChatView = async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const targetUser = await User.findById(req.params.id).select('-password');
        if (!targetUser) return res.status(404). json({ message: 'User not found' });
        const chatMessages = await Message.find({ userId: req.params.id }).sort({ createdAt: 1 });
        res.json({ user: targetUser, messages: chatMessages });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// POST /api/admin/users/:id/message
const sendUserMessage = async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const { messageContent } = req.body;
        if (!messageContent) return res.status(400).json({ message: 'Message content is required' });
        const targetUser = await User.findById(req.params.id);
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        await new Message({
            userId: req.params.id,
            sessionId: 'admin-direct-message',
            role: 'ai',
            content: `[ADMIN MESSAGE]: ${messageContent}`,
            title: 'Direct Message from Admin'
        }).save();
        res.json({ message: 'Message sent successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// GET /api/admin/reports
const getAllReports = async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const reports = await Report.find().sort({ createdAt: -1 });
        res.json(reports);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = {
    adminVerifyLayer2,
    adminVerifyLayer3,
    getAllUsers,
    suspendUser,
    deleteUser,
    getUserDetails,
    getUserChatView,
    sendUserMessage,
    getAllReports
};
