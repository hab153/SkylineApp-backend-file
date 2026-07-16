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
        
        console.log('🔍 [AUTH] Decoded token:', JSON.stringify(decoded, null, 2));
        
        // ✅ Extract userId from the nested user object
        let userId = null;
        if (decoded.user && decoded.user.id) {
            userId = decoded.user.id;
        } else if (decoded.userId) {
            userId = decoded.userId;
        } else if (decoded.id) {
            userId = decoded.id;
        }
        
        if (!userId) {
            console.error('❌ [AUTH] No userId found in token');
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
        
        // ✅ Normal token: verify user exists and token version matches
        const user = await User.findById(userId).select('tokenVersion');
        if (!user) {
            console.error('❌ [AUTH] User not found:', userId);
            return res.status(401).json({ message: 'User not found. Please log in again.' });
        }
        
        // ✅ Get tokenVersion from decoded token
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
        return res.status(401).json({ message: 'Invalid token. Please log in again.' });
    }
};

module.exports = { verifyToken };
