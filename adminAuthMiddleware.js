// adminAuthMiddleware.js
const jwt = require('jsonwebtoken');
const User = require('./User');

// ✅ SECURE: Strict JWT secret getter - NO FALLBACKS
const getAdminJwtSecret = () => {
    const secret = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET;
    if (!secret) {
        console.error('❌ CRITICAL: ADMIN_JWT_SECRET is not defined in environment variables');
        throw new Error('ADMIN_JWT_SECRET is not configured');
    }
    return secret;
};

const verifyAdminToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'Unauthorized: No admin token provided' });
        }

        const token = authHeader.split(' ')[1];
        if (!token) {
            return res.status(401).json({ message: 'Unauthorized: Invalid token format' });
        }

        // ✅ SECURE: Get secret with strict check
        const secret = getAdminJwtSecret();
        let decoded;
        
        try {
            decoded = jwt.verify(token, secret);
        } catch (err) {
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ message: 'Unauthorized: Admin token expired' });
            }
            if (err.name === 'JsonWebTokenError') {
                return res.status(401).json({ message: 'Unauthorized: Invalid admin token' });
            }
            console.error('❌ [ADMIN AUTH] JWT verification error:', err.message);
            return res.status(401).json({ message: 'Unauthorized: Token verification failed' });
        }

        // Ensure admin ID exists
        const adminId = decoded.id;
        if (!adminId) {
            return res.status(401).json({ message: 'Unauthorized: Invalid admin token payload' });
        }

        // Fetch admin from database
        let admin;
        try {
            admin = await User.findById(adminId).select('email isAdmin isSuspended');
        } catch (dbErr) {
            console.error('❌ [ADMIN AUTH] Database error:', dbErr.message);
            return res.status(500).json({ message: 'Server error during authentication' });
        }

        if (!admin) {
            return res.status(401).json({ message: 'Unauthorized: Admin not found' });
        }

        // ✅ Verify admin status
        if (!admin.isAdmin) {
            console.warn(`⚠️ [ADMIN AUTH] User ${admin.email} attempted admin access but is not admin`);
            return res.status(403).json({ message: 'Forbidden: Not an admin' });
        }

        // Check if admin is suspended
        if (admin.isSuspended) {
            return res.status(403).json({ 
                message: 'Account suspended', 
                suspensionEnds: admin.suspensionEnds 
            });
        }

        // ✅ Attach admin to request
        req.userId = admin._id;
        req.user = admin;
        req.isAdmin = true;
        next();

    } catch (error) {
        console.error('❌ [ADMIN AUTH] Unexpected error:', error.message);
        return res.status(500).json({ message: 'Authentication error' });
    }
};

module.exports = { verifyAdminToken };
