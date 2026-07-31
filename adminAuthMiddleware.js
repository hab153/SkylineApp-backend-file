// adminAuthMiddleware.js - ADMIN AUTHENTICATION ONLY
const jwt = require('jsonwebtoken');
const User = require('./User');

const verifyAdminToken = async (req, res, next) => {
    console.log('🛡️ [ADMIN AUTH] verifyAdminToken called');
    console.log('🛡️ [ADMIN AUTH] Request path:', req.path);
    
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(403).json({ message: 'No admin token provided' });
    }
    
    try {
        // ✅ STRICTLY USE ADMIN_JWT_SECRET FOR ADMINS
        const secret = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET;
        if (!secret) throw new Error('ADMIN_JWT_SECRET is not configured');
        
        const decoded = jwt.verify(token, secret);
        console.log('✅ [ADMIN AUTH] Admin token verified successfully');
        
        const adminId = decoded.id;
        if (!adminId) {
            return res.status(401).json({ message: 'Invalid admin token structure' });
        }

        // Verify the token actually belongs to an admin
        const admin = await User.findById(adminId).select('isAdmin permissions');
        if (!admin || !admin.isAdmin) {
            return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
        }
        
        req.userId = adminId;
        req.userRole = 'admin';
        req.adminPermissions = admin.permissions || ['all'];
        next();
        
    } catch (err) {
        console.error('❌ [ADMIN AUTH] Invalid admin token:', err.message);
        return res.status(401).json({ message: 'Invalid or expired admin token' });
    }
};

module.exports = { verifyAdminToken };
