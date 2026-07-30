// adminAuthController.js
const jwt = require('jsonwebtoken');
const User = require('./User');
const bcrypt = require('bcryptjs');

/**
 * POST /api/admin/authenticate
 * Validates admin credentials and issues short-lived session
 */
async function authenticateAdmin(req, res) {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        // Find admin user
        const admin = await User.findOne({ 
            email: email.toLowerCase().trim(), 
            isAdmin: true 
        });

        // SECURITY: Always run bcrypt even if user not found to prevent timing attacks
        const dummyHash = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
        const validPassword = admin 
            ? await bcrypt.compare(password, admin.password)
            : await bcrypt.compare(password, dummyHash);

        if (!admin || !validPassword) {
            console.warn(`[ADMIN AUTH FAILED] Email: ${email}, IP: ${req.ip}`);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Issue SHORT-LIVED admin token (30 minutes max)
        const adminToken = jwt.sign(
            { 
                id: admin._id, 
                role: 'admin',
                permissions: admin.permissions || ['all']
            },
            process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET,
            { expiresIn: '30m' }
        );

        // Set HTTP-only cookie (more secure than localStorage)
        res.cookie('admin_session', adminToken, {
            httpOnly: true,
            secure: true,      // HTTPS only on Render
            sameSite: 'strict', // Prevent CSRF
            maxAge: 30 * 60 * 1000
        });

        console.log(`[ADMIN AUTH SUCCESS] User: ${admin.email}, IP: ${req.ip}`);
        res.json({ success: true, redirectUrl: '/admin/dashboard' });

    } catch (err) {
        console.error('[ADMIN AUTH ERROR]', err);
        res.status(500).json({ error: 'Authentication service unavailable' });
    }
}

module.exports = { authenticateAdmin };
