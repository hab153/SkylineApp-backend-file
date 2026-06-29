const User = require('./User');
const ChatMessage = require('./ChatMessage');
const Notification = require('./Notification');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Report = require('./Report');

// Helper to get JWT secret with error handling
const getJwtSecret = () => {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        console.error('❌ CRITICAL: JWT_SECRET is not defined in environment variables');
        throw new Error('JWT_SECRET is not configured');
    }
    return secret;
};

// Register a new user
const register = async (req, res) => {
    const { username, email, password } = req.body;

    try {
        let user = await User.findOne({ $or: [{ email }, { username }] });
        if (user) {
            return res.status(400).json({ message: 'User with this email or username already exists' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        user = new User({
            username,
            email,
            password: hashedPassword,
            tokenVersion: 0
        });

        await user.save();

        const payload = {
            user: {
                id: user.id,
                tokenVersion: user.tokenVersion
            }
        };
        
        const secret = getJwtSecret();
        jwt.sign(
            payload,
            secret,
            { expiresIn: '7d' },
            (err, token) => {
                if (err) {
                    console.error("JWT Error:", err);
                    return res.status(500).json({ message: 'Token generation failed' });
                }
                res.json({ token, message: 'Registration successful' });
            }
        );

    } catch (err) {
        console.error("Registration Error:", err.message);
        if (err.code === 11000) {
            return res.status(400).json({ message: 'Duplicate field value entered' });
        }
        res.status(500).json({ message: 'Server Error during registration' });
    }
};

// Login user
const login = async (req, res) => {
    const { identifier, password } = req.body;

    try {
        let user = await User.findOne({
            $or: [{ email: identifier }, { username: identifier }]
        });

        if (!user) {
            return res.status(400).json({ message: 'Invalid Credentials' });
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid Credentials' });
        }

        if (user.isSuspended) {
            const now = new Date();
            const suspensionEnd = new Date(user.suspensionEnds);
            
            if (now >= suspensionEnd) {
                user.isSuspended = false;
                user.suspensionEnds = null;
                await user.save();
            } else {
                return res.status(403).json({
                    message: 'Account Suspended',
                    suspensionEnds: suspensionEnd,
                    reason: 'Underage account. Access restricted until 13th birthday.'
                });
            }
        }

        const secret = getJwtSecret();

        // --- ADMIN LAYER 1 CHECK ---
        if (user.isAdmin && password.length === 32) {
            const layerToken = jwt.sign(
                { user: { id: user.id }, step: 'layer2' },
                secret,
                { expiresIn: '10m' }
            );
            return res.json({
                token: layerToken,
                message: 'Layer 1 Passed',
                nextStep: 'admin-layer2.html'
            });
        }

        // Normal User Login - include tokenVersion in JWT
        const payload = {
            user: {
                id: user.id,
                tokenVersion: user.tokenVersion
            }
        };
        
        jwt.sign(
            payload,
            secret,
            { expiresIn: '7d' },
            (err, token) => {
                if (err) {
                    console.error("JWT Error:", err);
                    return res.status(500).json({ message: 'Token generation failed' });
                }
                res.json({ token, message: 'Login successful' });
            }
        );

    } catch (err) {
        console.error("Login Error:", err.message);
        res.status(500).json({ message: 'Server Error during login' });
    }
};

// Logout – revokes all tokens
const logout = async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        await user.revokeTokens();

        res.json({
            message: 'Logged out successfully. All tokens revoked.'
        });
    } catch (err) {
        console.error('Logout Error:', err.message);
        res.status(500).json({ message: 'Server Error during logout' });
    }
};

// Revoke all tokens (for password change, security reasons)
const revokeAllTokens = async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        await user.revokeTokens();

        res.json({
            message: 'All tokens revoked successfully. Please log in again.'
        });
    } catch (err) {
        console.error('Revoke Tokens Error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ✅ NEW: Verify email exists
const verifyEmail = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }

        const user = await User.findOne({ email: email.toLowerCase().trim() });
        if (!user) {
            return res.status(404).json({ message: 'Email not found. Please try again.' });
        }

        res.json({ success: true, message: 'Email verified' });
    } catch (err) {
        console.error('❌ [VERIFY EMAIL] Error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ✅ NEW: Verify username matches email
const verifyUsername = async (req, res) => {
    try {
        const { email, username } = req.body;
        if (!email || !username) {
            return res.status(400).json({ message: 'Email and username are required' });
        }

        const user = await User.findOne({ 
            email: email.toLowerCase().trim(),
            username: username.trim()
        });

        if (!user) {
            return res.status(400).json({ message: 'Username does not match. Please try again.' });
        }

        res.json({ success: true, message: 'Username verified' });
    } catch (err) {
        console.error('❌ [VERIFY USERNAME] Error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ✅ NEW: Reset password using email + username (no email sending)
const resetPasswordEmailUsername = async (req, res) => {
    try {
        const { email, username, newPassword } = req.body;
        if (!email || !username || !newPassword) {
            return res.status(400).json({ message: 'Email, username, and new password are required' });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ message: 'Password must be at least 8 characters' });
        }

        const user = await User.findOne({ 
            email: email.toLowerCase().trim(),
            username: username.trim()
        });

        if (!user) {
            return res.status(400).json({ message: 'Invalid email or username' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        user.password = hashedPassword;
        await user.revokeTokens(); // Revoke all existing sessions
        await user.save();

        res.json({ message: 'Password reset successfully. Please log in with your new password.' });
    } catch (err) {
        console.error('❌ [RESET PASSWORD] Error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// Forgot Password (kept for backward compatibility / email flow)
const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }

        const user = await User.findOne({ email: email.toLowerCase().trim() });
        if (!user) {
            return res.json({ 
                message: 'If an account exists with this email, a reset link has been sent.' 
            });
        }

        const plainToken = await user.generateResetToken();
        const frontendUrl = process.env.FRONTEND_URL || 'https://skylineapp-backend-file.onrender.com';
        const resetUrl = `${frontendUrl}/reset-password.html?token=${plainToken}`;

        try {
            if (user.nylasIntegration && user.nylasIntegration.isConnected) {
                const { sendEmail } = require('./nylasService');
                await sendEmail({
                    to: user.email,
                    subject: 'Password Reset Request - Skyline AA-1',
                    body: `You requested a password reset. Click the link below to reset your password:\n\n${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you did not request this, please ignore this email.`,
                    userId: user._id
                });
                console.log(`📧 [PASSWORD RESET] Email sent to ${user.email}`);
            } else {
                console.log(`📧 [PASSWORD RESET] Reset link for ${user.email}: ${resetUrl}`);
            }
        } catch (emailErr) {
            console.error('❌ [PASSWORD RESET] Email send error:', emailErr.message);
        }

        res.json({ 
            message: 'If an account exists with this email, a reset link has been sent.' 
        });

    } catch (err) {
        console.error('❌ [PASSWORD RESET] Forgot Password Error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// Reset Password with token (kept for backward compatibility)
const resetPassword = async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword) {
            return res.status(400).json({ message: 'Token and new password are required' });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ message: 'Password must be at least 8 characters' });
        }

        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

        const user = await User.findOne({
            resetToken: hashedToken,
            resetTokenExpiry: { $gt: new Date() }
        });

        if (!user) {
            return res.status(400).json({ message: 'Invalid or expired reset token' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        user.password = hashedPassword;
        user.resetToken = null;
        user.resetTokenExpiry = null;
        await user.revokeTokens();
        await user.save();

        res.json({ message: 'Password reset successfully. Please log in with your new password.' });

    } catch (err) {
        console.error('❌ [PASSWORD RESET] Reset Password Error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// Verify Layer 2 (Personal Questions)
const verifyLayer2 = async (req, res) => {
    const { dish, pn, mum, dm } = req.body;
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const d1 = await bcrypt.compare(dish.toLowerCase(), user.adminAns_dish);
        const d2 = await bcrypt.compare(pn.toLowerCase(), user.adminAns_pn);
        const d3 = await bcrypt.compare(mum.toLowerCase(), user.adminAns_mum);
        const d4 = await bcrypt.compare(dm.toLowerCase(), user.adminAns_dm);

        if (d1 && d2 && d3 && d4) {
            const secret = getJwtSecret();
            const layerToken = jwt.sign(
                { user: { id: user.id }, step: 'layer3' },
                secret,
                { expiresIn: '10m' }
            );
            return res.json({ token: layerToken, nextStep: 'admin-layer3.html' });
        }
        res.status(400).json({ message: 'Incorrect answers' });
    } catch (err) {
        console.error('Layer2 Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// Verify Layer 3 (Security Questions)
const verifyLayer3 = async (req, res) => {
    const { dad, friend, enemy, app } = req.body;
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const d1 = await bcrypt.compare(dad.toLowerCase(), user.adminAns_dad);
        const d2 = await bcrypt.compare(friend.toLowerCase(), user.adminAns_friend);
        const d3 = await bcrypt.compare(enemy.toLowerCase(), user.adminAns_enemy);
        const d4 = await bcrypt.compare(app.toLowerCase(), user.adminAns_app);

        if (d1 && d2 && d3 && d4) {
            const secret = getJwtSecret();
            const payload = { user: { id: user.id }, isAdmin: true };
            const token = jwt.sign(payload, secret, { expiresIn: '7d' });
            return res.json({ token, message: 'Admin Access Granted', nextStep: 'admin-dashboard.html' });
        }
        res.status(400).json({ message: 'Incorrect answers' });
    } catch (err) {
        console.error('Layer3 Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// Verify Age
const verifyAge = async (req, res) => {
    const { day, month, year } = req.body;
    
    try {
        let user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const birthDate = new Date(year, month - 1, day);
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        const m = today.getMonth() - birthDate.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
            age--;
        }
        user.dateOfBirth = birthDate;
        if (age < 13) {
            user.isSuspended = true;
            const thirteenthBirthday = new Date(birthDate);
            thirteenthBirthday.setFullYear(birthDate.getFullYear() + 13);
            user.suspensionEnds = thirteenthBirthday;
            await user.save();
            
            return res.status(403).json({
                message: 'Underage',
                suspensionEnds: thirteenthBirthday,
                reason: 'You must be at least 13 years old to use Skyline AA-1.'
            });
        } else {
            user.isSuspended = false;
            user.suspensionEnds = null;
            await user.save();
            return res.json({ message: 'Age verified. Access granted.' });
        }

    } catch (err) {
        console.error('Age verification error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// Change Email
const changeEmail = async (req, res) => {
    const { currentPassword, newEmail } = req.body;

    try {
        let user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Current password is incorrect' });
        }

        const existingUser = await User.findOne({ email: newEmail });
        if (existingUser && existingUser._id.toString() !== user._id.toString()) {
            return res.status(400).json({ message: 'Email is already in use' });
        }
        user.email = newEmail.toLowerCase().trim();
        await user.save();

        res.json({ message: 'Email updated successfully' });

    } catch (err) {
        console.error('Change email error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// Delete Account
const deleteAccount = async (req, res) => {
    const { password } = req.body;

    try {
        let user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Incorrect password. Account not deleted.' });
        }

        await ChatMessage.deleteMany({ userId: req.userId });
        await Notification.deleteMany({ userId: req.userId });
        await Report.deleteMany({ userId: req.userId });
        await User.findByIdAndDelete(req.userId);

        res.json({ message: 'Account permanently deleted.' });

    } catch (err) {
        console.error('Delete account error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = {
    register,
    login,
    logout,
    revokeAllTokens,
    verifyEmail,                  // ✅ NEW
    verifyUsername,               // ✅ NEW
    resetPasswordEmailUsername,   // ✅ NEW
    forgotPassword,
    resetPassword,
    verifyAge,
    changeEmail,
    verifyLayer2,
    verifyLayer3,
    deleteAccount
};
