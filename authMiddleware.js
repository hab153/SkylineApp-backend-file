// authMiddleware.js - USER AUTHENTICATION ONLY
const jwt = require('jsonwebtoken');
const User = require('./User');

const verifyToken = async (req, res, next) => {
    console.log(' [USER AUTH] verifyToken called');
    console.log('🔐 [USER AUTH] Request path:', req.path);
    
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(403).json({ message: 'No token provided' });
    }
    
    try {
        // ✅ STRICTLY USE JWT_SECRET FOR USERS
        const secret = process.env.JWT_SECRET;
        if (!secret) throw new Error('JWT_SECRET is not configured');
        
        const decoded = jwt.verify(token, secret);
        console.log('✅ [USER AUTH] Token verified successfully');
        
        // Handle standard user token payload structure
        const userId = decoded.user?.id || decoded.id;
        if (!userId) {
            return res.status(401).json({ message: 'Invalid token structure' });
        }

        // Normal user token: verify tokenVersion matches DB
        const user = await User.findById(userId).select('tokenVersion isAdmin');
        if (!user) {
            return res.status(401).json({ message: 'User not found' });
        }
        
        // Prevent admin tokens from being used on user routes
        if (user.isAdmin) {
            return res.status(403).json({ message: 'Admin tokens cannot access user routes' });
        }
        
        const tokenVersion = decoded.user?.tokenVersion || decoded.tokenVersion;
        if (tokenVersion !== user.tokenVersion) {
            return res.status(401).json({ message: 'Token revoked. Please log in again.' });
        }
        
        req.userId = userId;
        req.userRole = 'user';
        next();
        
    } catch (err) {
        console.error('❌ [USER AUTH] Invalid token:', err.message);
        return res.status(401).json({ message: 'Invalid or expired token' });
    }
};

module.exports = { verifyToken };
