const jwt = require('jsonwebtoken');
const User = require('./User');

// Helper to get JWT secret
const getJwtSecret = () => {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        console.error('❌ CRITICAL: JWT_SECRET is not defined in environment variables');
        throw new Error('JWT_SECRET is not configured');
    }
    return secret;
};

const verifyToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    console.log('🔐 [AUTH] Authorization header:', authHeader ? 'present' : 'missing');
    
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        console.error('❌ [AUTH] No token provided');
        return res.status(403).json({ message: 'No token provided' });
    }
    
    try {
        const secret = getJwtSecret();
        const decoded = jwt.verify(token, secret);
        
        const userId = decoded.user.id;
        
        // ✅ Check if this is a layer token (admin verification steps)
        const isLayerToken = decoded.step && ['layer2', 'layer3'].includes(decoded.step);
        
        if (isLayerToken) {
            // Layer tokens: skip tokenVersion check
            console.log('🔑 [AUTH] Layer token verified (step:', decoded.step, ')');
            req.userId = userId;
            req.layerStep = decoded.step;
            return next();
        }
        
        // Normal token: verify tokenVersion matches user's current version
        const user = await User.findById(userId).select('tokenVersion');
        if (!user) {
            console.error('❌ [AUTH] User not found');
            return res.status(401).json({ message: 'User not found' });
        }
        
        const tokenVersion = decoded.user.tokenVersion;
        
        if (tokenVersion !== user.tokenVersion) {
            console.error('❌ [AUTH] Token revoked - version mismatch',
                'token:', tokenVersion,
                'user:', user.tokenVersion);
            return res.status(401).json({ message: 'Token revoked. Please log in again.' });
        }
        
        req.userId = userId;
        console.log('✅ [AUTH] Token verified, userId =', userId);
        next();
    } catch (err) {
        console.error('❌ [AUTH] Invalid token:', err.message);
        return res.status(401).json({ message: 'Invalid token' });
    }
};

module.exports = { verifyToken };
