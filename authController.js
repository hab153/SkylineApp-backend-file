const User = require('./User');
const ChatMessage = require('./ChatMessage');
const Notification = require('./Notification');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Report = require('./Report');
const speakeasy = require('speakeasy'); // ✅ For TOTP 2FA
const { sanitizeQuery, isValidObjectId, sanitizeEmail, sanitizeUsername } = require('./sanitize');
const { generateCsrfToken, deleteCsrfToken } = require('./csrf');

// ✅ SECURE: Strict JWT secret getter - NO FALLBACKS
const getJwtSecret = () => {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        console.error('❌ CRITICAL: JWT_SECRET is not defined in environment variables');
        throw new Error('JWT_SECRET is not configured');
    }
    return secret;
};

// ✅ Validate security answer meets minimum requirements
function validateSecurityAnswer(answer, fieldName) {
    if (!answer || typeof answer !== 'string') {
        return `${fieldName} must be a valid string`;
    }
    const trimmed = answer.trim();
    if (trimmed.length < 3) {
        return `${fieldName} must be at least 3 characters long`;
    }
    return null; // Valid
}

// ✅ FIXED: Register function
const register = async (req, res) => {
    let { username, email, password } = req.body;
    
    const originalUsername = username;
    username = sanitizeUsername(username);
    email = sanitizeEmail(email);
    
    try {
        const emailExists = await User.findOne({ email });
        if (emailExists) {
            return res.status(400).json({ message: 'Email already registered.' });
        }
        
        const usernameExists = await User.findOne({ username });
        if (usernameExists) {
            return res.status(400).json({ message: 'Username already taken.' });
        }
        
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        
        const user = new User({ 
            username, 
            email, 
            password: hashedPassword, 
            tokenVersion: 0,
            fullName: originalUsername
        });
        await user.save();
        
        const payload = { user: { id: user.id, tokenVersion: user.tokenVersion } };
        // ✅ SECURE: Strict secret check
        const secret = getJwtSecret();
        
        jwt.sign(payload, secret, { expiresIn: '7d' }, async (err, token) => {
            if (err) {
                console.error("JWT Error:", err);
                return res.status(500).json({ message: 'Token generation failed' });
            }
            const csrfToken = await generateCsrfToken(user.id);
            res.json({ 
                token, 
                csrfToken, 
                message: 'Registration successful',
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email
                }
            });
        });
    } catch (err) {
        console.error("Registration Error:", err.message);
        if (err.code === 11000) {
            const field = Object.keys(err.keyPattern || {})[0];
            if (field === 'email') {
                return res.status(400).json({ message: 'Email already registered.' });
            }
            if (field === 'username') {
                return res.status(400).json({ message: 'Username already taken.' });
            }
            return res.status(400).json({ message: 'Duplicate field value entered.' });
        }
        res.status(500).json({ message: 'Server Error during registration' });
    }
};

// ✅ SECURE: Login function - BACKDOOR REMOVED
const login = async (req, res) => {
    let { identifier, password } = req.body;
    identifier = identifier ? identifier.trim() : '';
    try {
        const query = sanitizeQuery({
            $or: [
                { email: identifier },
                { username: identifier }
            ]
        });
        
        let user = await User.findOne(query);
        
        // Use dummy hash to prevent timing attacks if user doesn't exist
        const dummyHash = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
        const isMatch = user ? await bcrypt.compare(password, user.password) : await bcrypt.compare(password, dummyHash);

        if (!user || !isMatch) { 
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
        
        // ✅ SECURE: Strict secret check
        const secret = getJwtSecret();
        
        // ✅ If user is admin, they go through TOTP 2FA verification
        if (user.isAdmin) {
            console.log(`🔐 [ADMIN] Admin user ${user.email} logging in`);
            
            // Check if TOTP is enabled
            if (!user.adminTotpEnabled) {
                console.warn(`⚠️ [ADMIN] Admin ${user.email} has not enabled 2FA`);
                return res.status(403).json({
                    message: 'Admin 2FA not configured. Please contact support.',
                    requires2FASetup: true
                });
            }
            
            // Generate short-lived temp token for Step 2 (TOTP verification)
            const tempToken = jwt.sign(
                { 
                    id: user.id, 
                    step: 'totp_verify',
                    nonce: crypto.randomBytes(16).toString('hex')
                }, 
                secret, 
                { expiresIn: '5m' }
            );
            
            return res.json({ 
                success: true,
                tempToken: tempToken, 
                message: 'Password verified. Please enter your 2FA code.', 
                requires2FA: true
            });
        }
        
        // ─── REGULAR USER LOGIN ───
        const payload = { user: { id: user.id, tokenVersion: user.tokenVersion } };
        jwt.sign(payload, secret, { expiresIn: '7d' }, async (err, token) => {
            if (err) { 
                console.error("JWT Error:", err); 
                return res.status(500).json({ message: 'Token generation failed' }); 
            }
            const csrfToken = await generateCsrfToken(user.id);
            res.json({ 
                token, 
                csrfToken, 
                message: 'Login successful',
                user: {
                    id: user.id,
                    email: user.email,
                    username: user.username,
                    isAdmin: user.isAdmin || false
                }
            });
        });
        
    } catch (err) { 
        console.error("Login Error:", err.message); 
        res.status(500).json({ message: 'Server Error during login' }); 
    }
};

// ✅ FIXED: Logout function
const logout = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        const user = await User.findById(req.userId);
        if (!user) { return res.status(404).json({ message: 'User not found' }); }
        await user.revokeTokens();
        await deleteCsrfToken(req.userId);
        res.json({ message: 'Logged out successfully. All tokens revoked.' });
    } catch (err) { 
        console.error('Logout Error:', err.message); 
        res.status(500).json({ message: 'Server Error during logout' }); 
    }
};

// ✅ FIXED: Revoke all tokens
const revokeAllTokens = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        const user = await User.findById(req.userId);
        if (!user) { return res.status(404).json({ message: 'User not found' }); }
        await user.revokeTokens();
        await deleteCsrfToken(req.userId);
        res.json({ message: 'All tokens revoked successfully. Please log in again.' });
    } catch (err) { 
        console.error('Revoke Tokens Error:', err.message); 
        res.status(500).json({ message: 'Server Error' }); 
    }
};

// ✅ FIXED: Verify email
const verifyEmail = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) { return res.status(400).json({ message: 'Email is required' }); }
        const sanitizedEmail = sanitizeEmail(email);
        const user = await User.findOne({ email: sanitizedEmail });
        if (!user) { return res.status(404).json({ message: 'Email not found.' }); }
        res.json({ success: true, message: 'Email verified' });
    } catch (err) { 
        console.error('Verify Email Error:', err.message); 
        res.status(500).json({ message: 'Server Error' }); 
    }
};

// ✅ FIXED: Verify username
const verifyUsername = async (req, res) => {
    try {
        const { email, username } = req.body;
        if (!email || !username) { return res.status(400).json({ message: 'Email and username are required' }); }
        const sanitizedEmail = sanitizeEmail(email);
        const sanitizedUsername = sanitizeUsername(username);
        const user = await User.findOne({ email: sanitizedEmail, username: sanitizedUsername });
        if (!user) { return res.status(400).json({ message: 'Username does not match.' }); }
        res.json({ success: true, message: 'Username verified' });
    } catch (err) { 
        console.error('Verify Username Error:', err.message); 
        res.status(500).json({ message: 'Server Error' }); 
    }
};

// ✅ FIXED: Reset password via email/username
const resetPasswordEmailUsername = async (req, res) => {
    try {
        const { email, username, newPassword } = req.body;
        if (!email || !username || !newPassword) { 
            return res.status(400).json({ message: 'Email, username, and new password are required' }); 
        }
        if (newPassword.length < 8) { 
            return res.status(400).json({ message: 'Password must be at least 8 characters' }); 
        }
        const sanitizedEmail = sanitizeEmail(email);
        const sanitizedUsername = sanitizeUsername(username);
        const query = sanitizeQuery({ email: sanitizedEmail, username: sanitizedUsername });
        const user = await User.findOne(query);
        if (!user) { return res.status(400).json({ message: 'Invalid email or username' }); }
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);
        user.password = hashedPassword;
        await user.revokeTokens();
        await user.save();
        res.json({ message: 'Password reset successfully.' });
    } catch (err) { 
        console.error('Reset Password Error:', err.message); 
        res.status(500).json({ message: 'Server Error' }); 
    }
};

// ✅ FIXED: Forgot password
const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) { return res.status(400).json({ message: 'Email is required' }); }
        const sanitizedEmail = sanitizeEmail(email);
        const user = await User.findOne({ email: sanitizedEmail });
        if (!user) { 
            return res.json({ message: 'If an account exists with this email, a reset link has been sent.' }); 
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
                    body: `You requested a password reset. Click the link below:\n\n${resetUrl}\n\nThis link expires in 1 hour.`, 
                    userId: user._id 
                });
            } else { 
                console.log(`Reset link for ${user.email}: ${resetUrl}`); 
            }
        } catch (emailErr) { 
            console.error('Email send error:', emailErr.message); 
        }
        res.json({ message: 'If an account exists with this email, a reset link has been sent.' });
    } catch (err) { 
        console.error('Forgot Password Error:', err.message); 
        res.status(500).json({ message: 'Server Error' }); 
    }
};

// ✅ FIXED: Reset password with token
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
        const query = sanitizeQuery({ resetToken: hashedToken, resetTokenExpiry: { $gt: new Date() } });
        const user = await User.findOne(query);
        if (!user) { return res.status(400).json({ message: 'Invalid or expired reset token' }); }
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);
        user.password = hashedPassword;
        user.resetToken = null;
        user.resetTokenExpiry = null;
        await user.revokeTokens();
        await user.save();
        res.json({ message: 'Password reset successfully.' });
    } catch (err) { 
        console.error('Reset Password Error:', err.message); 
        res.status(500).json({ message: 'Server Error' }); 
    }
};

// ✅ FIXED: Verify Layer 2 - WITH SECURITY ANSWERS VALIDATION
const verifyLayer2 = async (req, res) => {
    const { dish, pn, mum, dm } = req.body;
    
    // ✅ Validate ALL answers BEFORE any database access or bcrypt calls
    const validations = [
        validateSecurityAnswer(dish, 'Favorite dish'),
        validateSecurityAnswer(pn, 'Phone number'),
        validateSecurityAnswer(mum, "Mother's name"),
        validateSecurityAnswer(dm, 'Dream destination')
    ];
    
    const errors = validations.filter(v => v !== null);
    if (errors.length > 0) {
        return res.status(400).json({ message: errors[0] });
    }
    
    try {
        if (!isValidObjectId(req.userId)) { 
            return res.status(400).json({ message: 'Invalid user ID' }); 
        }
        
        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        
        // ✅ CRITICAL: Verify user is actually an admin
        if (!user.isAdmin) {
            console.warn(`⚠️ [Layer2] Non-admin user ${user.email} attempted Layer 2 verification`);
            return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
        }
        
        // ✅ CRITICAL: Check that security setup is complete
        if (!user.securitySetupComplete) {
            console.warn(`⚠️ [Layer2] Admin ${user.email} has not completed security setup`);
            return res.status(403).json({
                message: 'Admin security setup not completed',
                needsSetup: true,
                redirectTo: '/admin-setup-security.html'
            });
        }
        
        // ✅ CRITICAL: Check that ALL security answers exist and are non-empty
        const requiredAnswers = [
            { field: user.adminAns_dish, name: 'Favorite dish' },
            { field: user.adminAns_pn, name: 'Phone number' },
            { field: user.adminAns_mum, name: "Mother's name" },
            { field: user.adminAns_dm, name: 'Dream destination' }
        ];
        
        const missingAnswers = requiredAnswers.filter(a => !a.field || a.field.length < 3);
        if (missingAnswers.length > 0) {
            const missingNames = missingAnswers.map(a => a.name).join(', ');
            console.error(`❌ [Layer2] Admin ${user.email} has missing or short security answers: ${missingNames}`);
            return res.status(500).json({ 
                message: 'Admin security answers not configured. Please contact support.' 
            });
        }
        
        // ✅ Compare answers (all already validated as non-empty above)
        const d1 = await bcrypt.compare(dish.trim().toLowerCase(), user.adminAns_dish);
        const d2 = await bcrypt.compare(pn.trim().toLowerCase(), user.adminAns_pn);
        const d3 = await bcrypt.compare(mum.trim().toLowerCase(), user.adminAns_mum);
        const d4 = await bcrypt.compare(dm.trim().toLowerCase(), user.adminAns_dm);
        
        if (d1 && d2 && d3 && d4) {
            const secret = getJwtSecret();
            const layerToken = jwt.sign(
                { 
                    user: { id: user.id }, 
                    step: 'layer3',
                    nonce: crypto.randomBytes(16).toString('hex')
                }, 
                secret, 
                { expiresIn: '10m' }
            );
            return res.json({ 
                token: layerToken, 
                nextStep: 'admin-layer3.html',
                message: 'Layer 2 verification passed' 
            });
        }
        
        // ✅ Log failed attempts for security monitoring
        console.warn(`⚠️ [Layer2] Failed verification attempt for admin ${user.email}`);
        res.status(400).json({ message: 'Incorrect answers' });
        
    } catch (err) { 
        console.error('❌ Layer2 Error:', err); 
        res.status(500).json({ message: 'Server Error' }); 
    }
};

// ✅ FIXED: Verify Layer 3 - WITH SECURITY ANSWERS VALIDATION
const verifyLayer3 = async (req, res) => {
    const { dad, friend, enemy, app } = req.body;
    
    // ✅ Validate ALL answers BEFORE any database access or bcrypt calls
    const validations = [
        validateSecurityAnswer(dad, "Father's name"),
        validateSecurityAnswer(friend, "Best friend's name"),
        validateSecurityAnswer(enemy, 'Enemy name'),
        validateSecurityAnswer(app, 'Favorite app')
    ];
    
    const errors = validations.filter(v => v !== null);
    if (errors.length > 0) {
        return res.status(400).json({ message: errors[0] });
    }
    
    try {
        if (!isValidObjectId(req.userId)) { 
            return res.status(400).json({ message: 'Invalid user ID' }); 
        }
        
        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        
        // ✅ CRITICAL: Verify user is actually an admin
        if (!user.isAdmin) {
            console.warn(`⚠️ [Layer3] Non-admin user ${user.email} attempted Layer 3 verification`);
            return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
        }
        
        // ✅ CRITICAL: Check that security setup is complete
        if (!user.securitySetupComplete) {
            console.warn(`⚠️ [Layer3] Admin ${user.email} has not completed security setup`);
            return res.status(403).json({
                message: 'Admin security setup not completed',
                needsSetup: true,
                redirectTo: '/admin-setup-security.html'
            });
        }
        
        // ✅ CRITICAL: Check that ALL security answers exist and are non-empty
        const requiredAnswers = [
            { field: user.adminAns_dad, name: "Father's name" },
            { field: user.adminAns_friend, name: "Best friend's name" },
            { field: user.adminAns_enemy, name: 'Enemy name' },
            { field: user.adminAns_app, name: 'Favorite app' }
        ];
        
        const missingAnswers = requiredAnswers.filter(a => !a.field || a.field.length < 3);
        if (missingAnswers.length > 0) {
            const missingNames = missingAnswers.map(a => a.name).join(', ');
            console.error(`❌ [Layer3] Admin ${user.email} has missing or short security answers: ${missingNames}`);
            return res.status(500).json({ 
                message: 'Admin security answers not configured. Please contact support.' 
            });
        }
        
        // ✅ Compare answers (all already validated as non-empty above)
        const d1 = await bcrypt.compare(dad.trim().toLowerCase(), user.adminAns_dad);
        const d2 = await bcrypt.compare(friend.trim().toLowerCase(), user.adminAns_friend);
        const d3 = await bcrypt.compare(enemy.trim().toLowerCase(), user.adminAns_enemy);
        const d4 = await bcrypt.compare(app.trim().toLowerCase(), user.adminAns_app);
        
        if (d1 && d2 && d3 && d4) {
            const secret = getJwtSecret();
            const payload = { 
                user: { id: user.id }, 
                isAdmin: true,
                nonce: crypto.randomBytes(16).toString('hex')
            };
            const token = jwt.sign(payload, secret, { expiresIn: '7d' });
            return res.json({ 
                token, 
                message: 'Admin Access Granted', 
                nextStep: 'admin-dashboard.html' 
            });
        }
        
        // ✅ Log failed attempts for security monitoring
        console.warn(`⚠️ [Layer3] Failed verification attempt for admin ${user.email}`);
        res.status(400).json({ message: 'Incorrect answers' });
        
    } catch (err) { 
        console.error('❌ Layer3 Error:', err); 
        res.status(500).json({ message: 'Server Error' }); 
    }
};

// ✅ FIXED: Verify age
const verifyAge = async (req, res) => {
    const { day, month, year } = req.body;
    try {
        if (!isValidObjectId(req.userId)) { return res.status(400).json({ message: 'Invalid user ID' }); }
        let user = await User.findById(req.userId);
        if (!user) { return res.status(404).json({ message: 'User not found' }); }
        
        const birthDate = new Date(year, month - 1, day);
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        const m = today.getMonth() - birthDate.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) { age--; }
        
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

// ✅ FIXED: Change email
const changeEmail = async (req, res) => {
    const { currentPassword, newEmail } = req.body;
    try {
        if (!isValidObjectId(req.userId)) { return res.status(400).json({ message: 'Invalid user ID' }); }
        let user = await User.findById(req.userId);
        if (!user) { return res.status(404).json({ message: 'User not found' }); }
        
        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) { return res.status(400).json({ message: 'Current password is incorrect' }); }
        
        const sanitizedNewEmail = sanitizeEmail(newEmail);
        const existingUser = await User.findOne({ email: sanitizedNewEmail });
        if (existingUser && existingUser._id.toString() !== user._id.toString()) { 
            return res.status(400).json({ message: 'Email is already in use' }); 
        }
        
        user.email = sanitizedNewEmail;
        await user.save();
        res.json({ message: 'Email updated successfully' });
    } catch (err) { 
        console.error('Change email error:', err.message); 
        res.status(500).json({ message: 'Server Error' }); 
    }
};

// ✅ FIXED: Delete account - COMPLETE DATA PURGE (GDPR Compliance)
const deleteAccount = async (req, res) => {
    const { password } = req.body;
    try {
        // ─── VALIDATE USER ───
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        
        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        
        // ─── VERIFY PASSWORD ───
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Incorrect password. Account not deleted.' });
        }

        const userId = req.userId;

        console.log(`🗑️ [DELETE ACCOUNT] Starting deletion process for user: ${user.email} (${userId})`);

        // ─── ✅ DELETE ALL USER DATA ───

        // 1. Delete all ChatMessages
        const chatResult = await ChatMessage.deleteMany({ userId });
        console.log(`   📝 Deleted ${chatResult.deletedCount} chat messages`);

        // 2. ✅ DELETE ALL LEADS (CRITICAL for GDPR)
        const Lead = require('./Lead');
        const leadResult = await Lead.deleteMany({ userId });
        console.log(`   📋 Deleted ${leadResult.deletedCount} leads`);

        // 3. Delete all EmailAccounts
        const EmailAccount = require('./EmailAccount');
        const emailAccountResult = await EmailAccount.deleteMany({ userId });
        console.log(`   📧 Deleted ${emailAccountResult.deletedCount} email accounts`);

        // 4. Delete all Sessions
        const Session = require('./Session');
        const sessionResult = await Session.deleteMany({ userId });
        console.log(`   📂 Deleted ${sessionResult.deletedCount} sessions`);

        // 5. Delete all Notifications
        const notificationResult = await Notification.deleteMany({ userId });
        console.log(`   🔔 Deleted ${notificationResult.deletedCount} notifications`);

        // 6. Delete all Reports
        const reportResult = await Report.deleteMany({ userId });
        console.log(`   📊 Deleted ${reportResult.deletedCount} reports`);

        // 7. Delete all Data Exports
        const DataExport = require('./DataExport');
        const dataExportResult = await DataExport.deleteMany({ userId });
        console.log(`   📦 Deleted ${dataExportResult.deletedCount} data exports`);

        // 8. Delete all Search Caches
        const SearchCache = require('./SearchCache');
        const searchCacheResult = await SearchCache.deleteMany({ userId });
        console.log(`   🔍 Deleted ${searchCacheResult.deletedCount} search caches`);

        // 9. Delete all Follow-up schedules (if any)
        try {
            const FollowUpSchedule = require('./FollowUpSchedule');
            const followUpResult = await FollowUpSchedule.deleteMany({ userId });
            console.log(`   ⏰ Deleted ${followUpResult.deletedCount} follow-up schedules`);
        } catch (err) {
            // FollowUpSchedule might not exist, which is fine
            console.log(`   ⏰ No follow-up schedule model found, skipping`);
        }

        // 10. ✅ FINALLY: Delete the User account
        await User.findByIdAndDelete(userId);
        console.log(`   👤 Deleted user account: ${user.email}`);

        // ─── TOTAL SUMMARY ───
        const totalDeleted = 
            chatResult.deletedCount +
            leadResult.deletedCount +
            emailAccountResult.deletedCount +
            sessionResult.deletedCount +
            notificationResult.deletedCount +
            reportResult.deletedCount +
            dataExportResult.deletedCount +
            searchCacheResult.deletedCount +
            1; // User account

        console.log(`✅ [DELETE ACCOUNT] Account deletion complete. Total records deleted: ${totalDeleted}`);

        res.json({ 
            success: true,
            message: 'Account and all associated data permanently deleted.',
            deletedRecords: {
                chatMessages: chatResult.deletedCount,
                leads: leadResult.deletedCount,
                emailAccounts: emailAccountResult.deletedCount,
                sessions: sessionResult.deletedCount,
                notifications: notificationResult.deletedCount,
                reports: reportResult.deletedCount,
                dataExports: dataExportResult.deletedCount,
                searchCaches: searchCacheResult.deletedCount,
                userAccount: 1,
                total: totalDeleted
            }
        });

    } catch (err) {
        console.error('❌ [DELETE ACCOUNT] Error:', err.message);
        console.error('❌ [DELETE ACCOUNT] Stack:', err.stack);
        res.status(500).json({ 
            success: false,
            message: 'Server Error during account deletion',
            error: err.message 
        });
    }
};

// ─── ✅ NEW: Setup Admin Security Questions ───
const setupAdminSecurity = async (req, res) => {
    try {
        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        // ✅ Verify user is admin
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (!user.isAdmin) {
            console.warn(`⚠️ [SECURITY SETUP] Non-admin user ${user.email} attempted to setup security`);
            return res.status(403).json({ success: false, message: 'Admin privileges required' });
        }

        // ─── ✅ VALIDATE ALL 8 SECURITY ANSWERS ───
        const { 
            dish, pn, mum, dm,  // Layer 2 questions
            dad, friend, enemy, app  // Layer 3 questions
        } = req.body;

        // Validate all answers are present and meet minimum requirements
        const requiredFields = [
            { value: dish, name: 'Favorite dish' },
            { value: pn, name: 'Phone number' },
            { value: mum, name: "Mother's name" },
            { value: dm, name: 'Dream destination' },
            { value: dad, name: "Father's name" },
            { value: friend, name: "Best friend's name" },
            { value: enemy, name: 'Enemy name' },
            { value: app, name: 'Favorite app' }
        ];

        const errors = [];
        for (const field of requiredFields) {
            if (!field.value || typeof field.value !== 'string' || field.value.trim().length < 3) {
                errors.push(`${field.name} must be at least 3 characters long`);
            }
        }

        if (errors.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid security answers',
                errors: errors
            });
        }

        // ─── ✅ HASH ALL ANSWERS ───
        const saltRounds = 10;
        
        const hashedDish = await bcrypt.hash(dish.trim().toLowerCase(), saltRounds);
        const hashedPn = await bcrypt.hash(pn.trim().toLowerCase(), saltRounds);
        const hashedMum = await bcrypt.hash(mum.trim().toLowerCase(), saltRounds);
        const hashedDm = await bcrypt.hash(dm.trim().toLowerCase(), saltRounds);
        const hashedDad = await bcrypt.hash(dad.trim().toLowerCase(), saltRounds);
        const hashedFriend = await bcrypt.hash(friend.trim().toLowerCase(), saltRounds);
        const hashedEnemy = await bcrypt.hash(enemy.trim().toLowerCase(), saltRounds);
        const hashedApp = await bcrypt.hash(app.trim().toLowerCase(), saltRounds);

        // ─── ✅ SAVE TO USER ───
        user.adminAns_dish = hashedDish;
        user.adminAns_pn = hashedPn;
        user.adminAns_mum = hashedMum;
        user.adminAns_dm = hashedDm;
        user.adminAns_dad = hashedDad;
        user.adminAns_friend = hashedFriend;
        user.adminAns_enemy = hashedEnemy;
        user.adminAns_app = hashedApp;
        user.securitySetupComplete = true;
        user.securitySetupDate = new Date();

        await user.save();

        console.log(`✅ [SECURITY SETUP] Admin ${user.email} completed security setup`);

        res.json({
            success: true,
            message: 'Admin security questions set up successfully',
            securitySetupComplete: true,
            setupDate: user.securitySetupDate
        });

    } catch (error) {
        console.error('❌ [SECURITY SETUP] Error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Server error setting up security questions'
        });
    }
};

// ─── ✅ NEW: Check Admin Security Setup Status ───
const checkAdminSecurityStatus = async (req, res) => {
    try {
        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const user = await User.findById(userId).select('isAdmin securitySetupComplete securitySetupDate');
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        if (!user.isAdmin) {
            return res.status(403).json({ success: false, message: 'Admin privileges required' });
        }

        res.json({
            success: true,
            isAdmin: true,
            securitySetupComplete: user.securitySetupComplete || false,
            needsSetup: !user.securitySetupComplete,
            setupDate: user.securitySetupDate || null
        });

    } catch (error) {
        console.error('❌ [SECURITY STATUS] Error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Server error checking security status'
        });
    }
};

// ✅ NEW: Generate TOTP Secret for Admin Setup
const generateAdminTotp = async (req, res) => {
    try {
        const userId = req.userId;
        if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
        const user = await User.findById(userId);
        if (!user || !user.isAdmin) return res.status(403).json({ success: false, message: 'Admin privileges required' });
        const secret = speakeasy.generateSecret({ name: 'Skyline Admin' });
        user.adminTotpSecret = secret.base32;
        await user.save();
        res.json({ success: true, otpauth_url: secret.otpauth_url, secret: secret.base32 });
    } catch (error) {
        console.error('❌ [TOTP GENERATION] Error:', error.message);
        res.status(500).json({ success: false, message: 'Server error generating TOTP' });
    }
};

// ✅ NEW: Verify and Enable TOTP
const enableAdminTotp = async (req, res) => {
    try {
        const { token } = req.body;
        const userId = req.userId;
        if (!token) return res.status(400).json({ success: false, message: 'Token is required' });
        const user = await User.findById(userId);
        if (!user || !user.adminTotpSecret) return res.status(400).json({ success: false, message: 'Setup not initiated' });
        const verified = speakeasy.totp.verify({ secret: user.adminTotpSecret, encoding: 'base32', token, window: 1 });
        if (verified) {
            user.adminTotpEnabled = true;
            await user.save();
            res.json({ success: true, message: '2FA enabled successfully' });
        } else {
            res.status(400).json({ success: false, message: 'Invalid token' });
        }
    } catch (error) {
        console.error('❌ [TOTP ENABLE] Error:', error.message);
        res.status(500).json({ success: false, message: 'Server error enabling 2FA' });
    }
};

// ✅ NEW: Admin Login Step 2 (Verify TOTP)
const verifyAdminTotpLogin = async (req, res) => {
    try {
        const { token, tempToken } = req.body;
        if (!token || !tempToken) return res.status(400).json({ success: false, message: 'Token and tempToken required' });
        let decoded;
        try { decoded = jwt.verify(tempToken, process.env.JWT_SECRET); } catch (err) { return res.status(401).json({ success: false, message: 'Session expired' }); }
        const user = await User.findById(decoded.id);
        if (!user || !user.isAdmin || !user.adminTotpEnabled) return res.status(403).json({ success: false, message: '2FA not configured or invalid user' });
        const verified = speakeasy.totp.verify({ secret: user.adminTotpSecret, encoding: 'base32', token, window: 1 });
        if (verified) {
            const finalToken = jwt.sign(
                { id: user._id, role: 'admin', permissions: user.permissions || ['all'] },
                process.env.ADMIN_JWT_SECRET, { expiresIn: '30m' }
            );
            res.json({ success: true, token: finalToken });
        } else {
            res.status(401).json({ success: false, message: 'Invalid 2FA code' });
        }
    } catch (error) {
        console.error('❌ [TOTP LOGIN] Error:', error.message);
        res.status(500).json({ success: false, message: 'Server error during 2FA verification' });
    }
};

module.exports = {
    register, login, logout, revokeAllTokens, verifyEmail, verifyUsername, resetPasswordEmailUsername,
    forgotPassword, resetPassword, verifyAge, changeEmail, verifyLayer2, verifyLayer3, deleteAccount,
    setupAdminSecurity, checkAdminSecurityStatus,
    generateAdminTotp, enableAdminTotp, verifyAdminTotpLogin
};
