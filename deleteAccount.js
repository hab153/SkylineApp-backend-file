const User = require('./User');
const ChatMessage = require('./ChatMessage');
const Notification = require('./Notification');
const Report = require('./Report');
// ❌ REMOVED: const EmailAccount = require('./EmailAccount');

/**
 * Delete user account and all associated data
 */
async function deleteUserAccount(req, res) {
    try {
        const userId = req.userId;
        const { password } = req.body;

        // Verify user exists
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Verify password
        const bcrypt = require('bcryptjs');
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Incorrect password' });
        }

        // Delete all user data
        await ChatMessage.deleteMany({ userId });
        await Notification.deleteMany({ userId });
        await Report.deleteMany({ userId });
        
        // EmailAccount is no longer used – tokens are in User.nylasIntegration
        // No need to delete separately

        // Delete the user
        await User.findByIdAndDelete(userId);

        res.json({ message: 'Account permanently deleted' });
    } catch (err) {
        console.error('Delete account error:', err);
        res.status(500).json({ message: 'Server error' });
    }
}

module.exports = { deleteUserAccount };
