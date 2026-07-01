const User = require('./User');
const Report = require('./Report');
const { isValidObjectId, sanitizeString } = require('./sanitize');

// POST /api/reports
const submitReport = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        let { subject, message } = req.body;
        if (!subject || !message) {
            return res.status(400).json({ message: 'Subject and message are required' });
        }
        // Sanitize inputs
        subject = sanitizeString(subject).slice(0, 200);
        message = sanitizeString(message).slice(0, 5000);

        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        await new Report({ userId: req.userId, username: user.username, subject, message }).save();
        res.json({ message: 'Report submitted successfully' });
    } catch (err) {
        console.error('Submit report error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = { submitReport };
