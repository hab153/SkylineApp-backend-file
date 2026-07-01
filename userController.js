const bcrypt = require('bcryptjs');
const User = require('./User');
const { changeEmail, verifyAge, deleteAccount } = require('./authController');
const { isValidObjectId, sanitizeObject } = require('./sanitize');

// GET /api/users/me
const getUserProfile = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        const user = await User.findById(req.userId).select('-password');
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(user);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// PUT /api/users/me
const updateUserProfile = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        // Sanitize the update data
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
        res.status(500).json({ message: 'Server Error' });
    }
};

// PUT /api/auth/change-password
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
        res.status(500).json({ message: 'Server Error' });
    }
};

// Wrappers for authController functions (they expect (req, res) signatures)
const changeEmailWrapper = (req, res) => changeEmail(req, res);
const verifyAgeWrapper = (req, res) => verifyAge(req, res);
const deleteUserAccount = (req, res) => deleteAccount(req, res);

module.exports = {
    getUserProfile,
    updateUserProfile,
    changePassword,
    changeEmail: changeEmailWrapper,
    verifyAge: verifyAgeWrapper,
    deleteUserAccount
};
