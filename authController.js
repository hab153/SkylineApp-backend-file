const User = require('./User');
const ChatMessage = require('./ChatMessage');
const Notification = require('./Notification');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Report = require('./Report');
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

// ✅ SECURE: Strict ADMIN JWT secret getter
const getAdminJwtSecret = () => {
    const secret = process.env.ADMIN_JWT_SECRET;
    if (!secret) {
        console.error('❌ CRITICAL: ADMIN_JWT_SECRET is not defined in environment variables');
        throw new Error('ADMIN_JWT_SECRET is not configured');
    }
    return secret;
};

// ════════════════════════════════════════════
// ✅ SECURE: Initial Admin Setup (NO HARCODED CREDENTIALS)
// ════════════════════════════════════════════
const setupInitialAdmin = async () => {
    try {
        // Check if any admin exists
        const existingAdmin = await User.findOne({ isAdmin: true });
        if (existingAdmin) {
            console.log(`✅ [ADMIN SETUP] Admin already exists: ${existingAdmin.email}`);
            return;
        }

        // ✅ SECURE: Generate a one-time setup token (NOT hardcoded)
        const setupToken = crypto.randomBytes(32).toString('hex');
        
        console.log('═══════════════════════════════════════════════════════════');
        console.log('🔐 [ADMIN SETUP] No admin user found!');
        console.log('📋 [ADMIN SETUP] To create the first admin, use the setup endpoint:');
        console.log(`   POST /api/admin/setup`);
        console.log(`   Body: { email, password, username, setupToken: "${setupToken}" }`);
        console.log('═══════════════════════════════════════════════════════════');

        // Store setup token in a secure location (in-memory for now)
        // In production, store in Redis or a secure database
        if (!global._adminSetupTokens) {
            global._adminSetupTokens = new Map();
        }
        global._adminSetupTokens.set(setupToken, {
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000) // 1 hour expiry
        });

        return setupToken;
    } catch (error) {
        console.error('❌ [ADMIN SETUP] Error:', error.message);
    }
};

// ════════════════════════════════════════════
// ✅ SECURE: Register function
// ════════════════════════════════════════════
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

// ════════════════════════════════════════════
// ✅ SECURE: Login function (NO HARDCODED BACKDOOR)
// ════════════════════════════════════════════
const login = async (req, res) => {
    let { identifier, password } = req.body;
    identifier = identifier ? identifier.trim() : '';
    
    try {
        // ❌ REMOVED: Hardcoded admin backdoor
        // ✅ Now uses proper database authentication

        const query = sanitizeQuery({
            $or: [
                { email: identifier },
                { username: identifier }
            ]
        });
        let user = await User.findOne(query);
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
        
        // ─── REGULAR USER LOGIN ───
        const secret = getJwtSecret();
        const payload = { user: { id: user.id, tokenVersion: user.tokenVersion } };
        
        jwt.sign(payload, secret, { expiresIn: '7d' }, async (err, token) => {
            if (err) { 
                console.error("JWT Error:", err); 
                return res.status(500).json({ message: 'Token generation failed' }); 
            }
            const csrfToken = await generateCsrfToken(user.id);
            
            // ✅ If user is admin, include flag
            const response = { 
                token, 
                csrfToken, 
                message: 'Login successful',
                user: {
                    id: user.id,
                    email: user.email,
                    username: user.username,
                    isAdmin: user.isAdmin || false
                }
            };
            
            // ✅ If admin, they need to use /api/admin/login endpoint
            // This is a regular user login - admins should use admin login
            if (user.isAdmin) {
                response.message = 'Admin users please use the admin login endpoint';
                response.adminLoginRequired = true;
                response.adminLoginUrl = '/api/admin/login';
            }
            
            res.json(response);
        });
        
    } catch (err) { 
        console.error("Login Error:", err.message); 
        res.status(500).json({ message: 'Server Error during login' }); 
    }
};

// ════════════════════════════════════════════
// ✅ SECURE: Admin Setup Endpoint
// ════════════════════════════════════════════
const setupAdmin = async (req, res) => {
    try {
        const { email, password, username, setupToken } = req.body;

        // ─── VALIDATE INPUT ───
        if (!email || !password || !username || !setupToken) {
            return res.status(400).json({ 
                success: false, 
                message: 'Email, password, username, and setup token are required' 
            });
        }

        // ─── VALIDATE SETUP TOKEN ───
        if (!global._adminSetupTokens || !global._adminSetupTokens.has(setupToken)) {
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid or expired setup token' 
            });
        }

        const tokenData = global._adminSetupTokens.get(setupToken);
        if (new Date() > tokenData.expiresAt) {
            global._adminSetupTokens.delete(setupToken);
            return res.status(401).json({ 
                success: false, 
                message: 'Setup token has expired. Please restart the server to generate a new one.' 
            });
        }

        // ─── CHECK IF ADMIN ALREADY EXISTS ───
        const existingAdmin = await User.findOne({ isAdmin: true });
        if (existingAdmin) {
            return res.status(400).json({ 
                success: false, 
                message: 'Admin already exists. This setup endpoint is only for initial admin creation.' 
            });
        }

        // ─── VALIDATE EMAIL ───
        const emailExists = await User.findOne({ email: email.toLowerCase().trim() });
        if (emailExists) {
            return res.status(400).json({ 
                success: false, 
                message: 'Email already registered' 
            });
        }

        // ─── VALIDATE USERNAME ───
        const usernameExists = await User.findOne({ username: username.trim() });
        if (usernameExists) {
            return res.status(400).json({ 
                success: false, 
                message: 'Username already taken' 
            });
        }

        // ─── VALIDATE PASSWORD STRENGTH ───
        if (password.length < 8) {
            return res.status(400).json({ 
                success: false, 
                message: 'Password must be at least 8 characters' 
            });
        }

        // ─── CREATE ADMIN USER ───
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const adminUser = new User({
            username: username.trim(),
            email: email.toLowerCase().trim(),
            password: hashedPassword,
            isAdmin: true,
            tokenVersion: 0,
            securitySetupComplete: true,
            permissions: ['all'],
            fullName: username.trim()
        });

        await adminUser.save();

        // ─── CLEANUP SETUP TOKEN ───
        global._adminSetupTokens.delete(setupToken);

        console.log(`✅ [ADMIN SETUP] Admin user created: ${adminUser.email}`);

        // ─── GENERATE ADMIN TOKEN ───
        const secret = getAdminJwtSecret();
        const adminToken = jwt.sign(
            { 
                id: adminUser._id, 
                role: 'admin',
                permissions: adminUser.permissions || ['all']
            },
            secret,
            { expiresIn: '30m' }
        );

        res.json({
            success: true,
            message: 'Admin user created successfully',
            token: adminToken,
            admin: {
                id: adminUser._id,
                email: adminUser.email,
                username: adminUser.username
            }
        });

    } catch (error) {
        console.error('❌ [ADMIN SETUP] Error:', error.message);
        res.status(500).json({ 
            success: false, 
            message: 'Server error during admin setup' 
        });
    }
};

// ════════════════════════════════════════════
// ✅ SECURE: Get Admin Setup Status
// ════════════════════════════════════════════
const getAdminSetupStatus = async (req, res) => {
    try {
        const existingAdmin = await User.findOne({ isAdmin: true });
        
        if (existingAdmin) {
            return res.json({
                adminExists: true,
                adminEmail: existingAdmin.email,
                adminCreatedAt: existingAdmin.createdAt,
                needsSetup: false
            });
        }

        // Generate a new setup token if none exists
        if (!global._adminSetupTokens || global._adminSetupTokens.size === 0) {
            const setupToken = crypto.randomBytes(32).toString('hex');
            if (!global._adminSetupTokens) {
                global._adminSetupTokens = new Map();
            }
            global._adminSetupTokens.set(setupToken, {
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 60 * 60 * 1000)
            });
            console.log(`🔐 [ADMIN] New setup token generated: ${setupToken}`);
        }

        res.json({
            adminExists: false,
            needsSetup: true,
            message: 'No admin exists. Please use the setup endpoint with a valid token.',
            setupEndpoint: '/api/admin/setup'
        });

    } catch (error) {
        console.error('❌ [ADMIN STATUS] Error:', error.message);
        res.status(500).json({ 
            success: false, 
            message: 'Server error checking admin status' 
        });
    }
};

// ════════════════════════════════════════════
// ✅ SECURE: Admin Login (Separate from regular login)
// ════════════════════════════════════════════
const adminLogin = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ 
                success: false, 
                message: 'Email and password required' 
            });
        }

        // ✅ Find admin by email
        const admin = await User.findOne({ 
            email: email.toLowerCase().trim(), 
            isAdmin: true 
        });

        // ✅ Constant-time comparison to prevent timing attacks
        const dummyHash = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
        const validPassword = admin 
            ? await bcrypt.compare(password, admin.password)
            : await bcrypt.compare(password, dummyHash);

        if (!admin || !validPassword) {
            console.warn(`[ADMIN AUTH FAILED] Email: ${email}, IP: ${req.ip}`);
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid credentials' 
            });
        }

        // ✅ Check if admin is suspended
        if (admin.isSuspended) {
            return res.status(403).json({
                success: false,
                message: 'Account suspended',
                suspensionEnds: admin.suspensionEnds
            });
        }

        // ✅ Generate admin token
        const secret = getAdminJwtSecret();
        const adminToken = jwt.sign(
            { 
                id: admin._id, 
                role: 'admin',
                permissions: admin.permissions || ['all']
            },
            secret,
            { expiresIn: '30m' }
        );

        console.log(`[ADMIN AUTH SUCCESS] User: ${admin.email}, IP: ${req.ip}`);

        res.json({
            success: true,
            message: 'Admin login successful',
            token: adminToken,
            admin: {
                id: admin._id,
                email: admin.email,
                username: admin.username,
                permissions: admin.permissions || ['all']
            }
        });

    } catch (error) {
        console.error('[ADMIN LOGIN ERROR]', error.message);
        res.status(500).json({ 
            success: false, 
            message: 'Authentication service unavailable' 
        });
    }
};

// ════════════════════════════════════════════
// ✅ FIXED: Logout function
// ════════════════════════════════════════════
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

// ════════════════════════════════════════════
// ✅ FIXED: Revoke all tokens
// ════════════════════════════════════════════
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

// ════════════════════════════════════════════
// ✅ FIXED: Verify email
// ════════════════════════════════════════════
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

// ════════════════════════════════════════════
// ✅ FIXED: Verify username
// ════════════════════════════════════════════
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

// ════════════════════════════════════════════
// ✅ FIXED: Reset password via email/username
// ════════════════════════════════════════════
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

// ════════════════════════════════════════════
// ✅ FIXED: Forgot password
// ════════════════════════════════════════════
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

// ════════════════════════════════════════════
// ✅ FIXED: Reset password with token
// ════════════════════════════════════════════
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

// ════════════════════════════════════════════
// ✅ FIXED: Verify age
// ════════════════════════════════════════════
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

// ════════════════════════════════════════════
// ✅ FIXED: Change email
// ════════════════════════════════════════════
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

// ════════════════════════════════════════════
// ✅ FIXED: Delete account - COMPLETE DATA PURGE (GDPR Compliance)
// ════════════════════════════════════════════
const deleteAccount = async (req, res) => {
    const { password } = req.body;
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        
        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Incorrect password. Account not deleted.' });
        }

        const userId = req.userId;

        console.log(`🗑️ [DELETE ACCOUNT] Starting deletion process for user: ${user.email} (${userId})`);

        // Delete all user data
        const ChatMessage = require('./ChatMessage');
        const chatResult = await ChatMessage.deleteMany({ userId });
        console.log(`   📝 Deleted ${chatResult.deletedCount} chat messages`);

        const Lead = require('./Lead');
        const leadResult = await Lead.deleteMany({ userId });
        console.log(`   📋 Deleted ${leadResult.deletedCount} leads`);

        const EmailAccount = require('./EmailAccount');
        const emailAccountResult = await EmailAccount.deleteMany({ userId });
        console.log(`   📧 Deleted ${emailAccountResult.deletedCount} email accounts`);

        const Session = require('./Session');
        const sessionResult = await Session.deleteMany({ userId });
        console.log(`   📂 Deleted ${sessionResult.deletedCount} sessions`);

        const notificationResult = await Notification.deleteMany({ userId });
        console.log(`   🔔 Deleted ${notificationResult.deletedCount} notifications`);

        const reportResult = await Report.deleteMany({ userId });
        console.log(`   📊 Deleted ${reportResult.deletedCount} reports`);

        const DataExport = require('./DataExport');
        const dataExportResult = await DataExport.deleteMany({ userId });
        console.log(`   📦 Deleted ${dataExportResult.deletedCount} data exports`);

        const SearchCache = require('./SearchCache');
        const searchCacheResult = await SearchCache.deleteMany({ userId });
        console.log(`   🔍 Deleted ${searchCacheResult.deletedCount} search caches`);

        await User.findByIdAndDelete(userId);
        console.log(`   👤 Deleted user account: ${user.email}`);

        const totalDeleted = 
            chatResult.deletedCount +
            leadResult.deletedCount +
            emailAccountResult.deletedCount +
            sessionResult.deletedCount +
            notificationResult.deletedCount +
            reportResult.deletedCount +
            dataExportResult.deletedCount +
            searchCacheResult.deletedCount +
            1;

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
        res.status(500).json({ 
            success: false,
            message: 'Server Error during account deletion',
            error: err.message 
        });
    }
};

// ════════════════════════════════════════════
// ✅ EXPORTS
// ════════════════════════════════════════════
module.exports = {
    register,
    login,
    adminLogin,
    setupAdmin,
    getAdminSetupStatus,
    setupInitialAdmin,
    logout,
    revokeAllTokens,
    verifyEmail,
    verifyUsername,
    resetPasswordEmailUsername,
    forgotPassword,
    resetPassword,
    verifyAge,
    changeEmail,
    deleteAccount
};
