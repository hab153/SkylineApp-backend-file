const jwt = require('jsonwebtoken');

// ✅ NEW: Helper to get JWT secret (no fallback)
const getJwtSecret = () => {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        console.error('❌ CRITICAL: JWT_SECRET is not defined in environment variables');
        throw new Error('JWT_SECRET is not configured');
    }
    return secret;
};

const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    console.log('🔐 [AUTH] Authorization header:', authHeader ? 'present' : 'missing');
    
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        console.error('❌ [AUTH] No token provided');
        return res.status(403).json({ message: 'No token provided' });
    }
    
    try {
        // ✅ FIXED: No fallback secret
        const secret = getJwtSecret();
        const decoded = jwt.verify(token, secret);
        req.userId = decoded.user.id;
        console.log('✅ [AUTH] Token verified, userId =', req.userId);
        next();
    } catch (err) {
        console.error('❌ [AUTH] Invalid token:', err.message);
        return res.status(401).json({ message: 'Invalid token' });
    }
};

module.exports = { verifyToken };
