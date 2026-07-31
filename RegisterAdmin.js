// registerAdmin.js
const User = require('./User');
const bcrypt = require('bcryptjs');

/**
 * POST /api/admin/setup
 * One-time admin account creation with setup key validation
 */
async function setupAdmin(req, res) {
    try {
        const { setupKey, email, password } = req.body;
        
        // Validate setup key
        const VALID_SETUP_KEY = process.env.ADMIN_SETUP_KEY || 'SKYLINE-SETUP-2026-SECURE';
        if (setupKey !== VALID_SETUP_KEY) {
            return res.status(403).json({ error: 'Invalid setup key' });
        }

        // Prevent duplicate registration
        const existingAdmin = await User.findOne({ isAdmin: true });
        if (existingAdmin) {
            return res.status(409).json({ error: 'Admin account already exists. Portal is now login-only.' });
        }

        // Validate password strength
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        // Hash password securely
        const salt = await bcrypt.genSalt(12);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Create admin user
        const admin = new User({
            username: 'admin',
            email: email.toLowerCase().trim(),
            password: hashedPassword,
            isAdmin: true,
            tokenVersion: 0,
            permissions: ['all']
        });

        await admin.save();
        console.log(`[ADMIN SETUP] ✅ Admin account created: ${email}`);
        
        res.json({ success: true, message: 'Admin account created successfully' });

    } catch (err) {
        console.error('[ADMIN SETUP ERROR]', err);
        if (err.code === 11000) {
            return res.status(409).json({ error: 'Email already registered' });
        }
        res.status(500).json({ error: 'Setup service unavailable' });
    }
}

module.exports = { setupAdmin };
