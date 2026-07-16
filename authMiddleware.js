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
        
        // ✅ FIX: Try multiple ways to get userId
        let userId = decoded.userId || decoded.id || decoded.user?.id || decoded.user?.userId;
        
        // If userId is still not found, try decoded._id or decoded.sub
        if (!userId) {
            userId = decoded._id || decoded.sub;
        }
        
        if (!userId) {
            console.error('❌ [AUTH] No userId found in token:', Object.keys(decoded));
            return res.status(401).json({ message: 'Invalid token: no user ID' });
        }
        
        // ✅ Check if this is a special token (layer token or admin token)
        const isLayerToken = decoded.step && ['layer2', 'layer3'].includes(decoded.step);
        const isAdminToken = decoded.isAdmin === true;
        
        if (isLayerToken || isAdminToken) {
            if (isLayerToken) {
                console.log('🔑 [AUTH] Layer token verified (step:', decoded.step, ')');
                req.layerStep = decoded.step;
            } else {
                console.log('🔑 [AUTH] Admin token verified (isAdmin: true)');
            }
            req.userId = userId;
            return next();
        }
        
        // Normal token: verify tokenVersion matches user's current version
        const user = await User.findById(userId).select('tokenVersion');
        if (!user) {
            console.error('❌ [AUTH] User not found:', userId);
            return res.status(401).json({ message: 'User not found' });
        }
        
        // Get tokenVersion from decoded token (handle different structures)
        let tokenVersion = decoded.user?.tokenVersion || decoded.tokenVersion || decoded.version;
        
        if (tokenVersion !== undefined && tokenVersion !== user.tokenVersion) {
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
