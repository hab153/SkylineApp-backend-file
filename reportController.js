const User = require('./User');
const Report = require('./Report');

// POST /api/reports
const submitReport = async (req, res) => {
    try {
        const { subject, message } = req.body;
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        await new Report({ userId: req.userId, username: user.username, subject, message }).save();
        res.json({ message: 'Report submitted successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = { submitReport };
