// authMiddleware.js
const jwt = require('jsonwebtoken');
const User = require('./User');

const verifyToken = async (req, res, next) => {
    console.log(' [AUTH] verifyToken called');
    console.log('🔐 [AUTH] Request path:', req.path);
    
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(403).json({ message: 'No token provided' });
    }
    
    try {
        let decoded;
        let usedSecret = '';

        // 1. Try ADMIN_JWT_SECRET first (for admin tokens)
        if (process.env.ADMIN_JWT_SECRET) {
            try {
                decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
                usedSecret = 'ADMIN_JWT_SECRET';
            } catch (e) {
                // Not an admin token, continue to check JWT_SECRET
            }
        }

        // 2. If not verified as admin, try standard JWT_SECRET (for user tokens)
        if (!decoded) {
            const userSecret = process.env.JWT_SECRET;
            if (!userSecret) throw new Error('JWT_SECRET is not configured');
            
            decoded = jwt.verify(token, userSecret);
            usedSecret = 'JWT_SECRET';
        }

        console.log(`✅ [AUTH] Token verified successfully using ${usedSecret}`);
        
        // Handle both admin and user token payload structures
        const userId = decoded.id || decoded.user?.id;
        if (!userId) {
            return res.status(401).json({ message: 'Invalid token structure' });
        }

        // Check for special tokens (layer/admin) that skip version checks
        const isLayerToken = decoded.step && ['layer2', 'layer3'].includes(decoded.step);
        const isAdminToken = decoded.role === 'admin' || decoded.isAdmin === true;
        
        if (isLayerToken || isAdminToken) {
            req.userId = userId;
            req.userRole = decoded.role || 'admin';
            return next();
        }
        
        // Normal user token: verify tokenVersion matches DB
        const user = await User.findById(userId).select('tokenVersion');
        if (!user) {
            return res.status(401).json({ message: 'User not found' });
        }
        
        const tokenVersion = decoded.user?.tokenVersion || decoded.tokenVersion;
        if (tokenVersion !== user.tokenVersion) {
            return res.status(401).json({ message: 'Token revoked. Please log in again.' });
        }
        
        req.userId = userId;
        req.userRole = 'user';
        next();
        
    } catch (err) {
        console.error('❌ [AUTH] Invalid token:', err.message);
        return res.status(401).json({ message: 'Invalid or expired token' });
    }
};

module.exports = { verifyToken };
