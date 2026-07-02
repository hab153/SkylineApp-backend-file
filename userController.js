const bcrypt = require('bcryptjs');
const User = require('./User');
const { changeEmail, verifyAge } = require('./authController');
const { isValidObjectId, sanitizeObject } = require('./sanitize');
const { deleteAccount, deactivateAccount, restoreAccount, getDeletionStatus } = require('./deleteAccount');

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

/**
 * DELETE /api/users/me
 * Permanently delete user account (Right to Be Forgotten)
 * Requires password verification
 */
const deleteUserAccount = async (req, res) => {
    try {
        const { password, reason = 'User requested permanent deletion' } = req.body;

        if (!password) {
            return res.status(400).json({ 
                error: 'Password is required to delete your account' 
            });
        }

        // Check if user exists
        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Call the deletion service
        const result = await deleteAccount(req.userId, password, req);

        // Clear local session data (frontend will handle this)
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

/**
 * POST /api/users/me/deactivate
 * Soft deactivate account (recovery possible within 30 days)
 */
const deactivateUserAccount = async (req, res) => {
    try {
        const { password, reason = 'User requested deactivation' } = req.body;

        if (!password) {
            return res.status(400).json({ error: 'Password is required' });
        }

        // Verify user exists
        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Verify password
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

/**
 * POST /api/users/me/restore
 * Restore deactivated account
 */
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

/**
 * GET /api/users/me/deletion-status
 * Get deletion/suspension status
 */
const getDeletionStatusHandler = async (req, res) => {
    try {
        const result = await getDeletionStatus(req.userId);
        return res.json(result);
    } catch (error) {
        console.error('[UserController] getDeletionStatus error:', error);
        return res.status(404).json({ error: error.message || 'User not found' });
    }
};

// Wrappers for authController functions (they expect (req, res) signatures)
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
    getDeletionStatus: getDeletionStatusHandler
};
