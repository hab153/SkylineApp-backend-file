const jwt = require('jsonwebtoken');
const User = require('./User');

// Helper to get JWT secret
const getJwtSecret = () => {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        console.error('❌ CRITICAL: JWT_SECRET is not defined in environment variables');
        throw new Error('JWT_SECRET is not configured');
    }
    console.log('🔐 [AUTH] JWT_SECRET is configured');
    return secret;
};

const verifyToken = async (req, res, next) => {
    console.log('🔐 [AUTH] verifyToken called');
    console.log('🔐 [AUTH] Request path:', req.path);
    console.log('🔐 [AUTH] Request method:', req.method);
    
    const authHeader = req.headers['authorization'];
    console.log('🔐 [AUTH] Authorization header:', authHeader ? 'present' : 'missing');
    
    if (authHeader) {
        console.log('🔐 [AUTH] Header value (first 30 chars):', authHeader.substring(0, 30) + '...');
    }
    
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        console.error('❌ [AUTH] No token provided');
        return res.status(403).json({ message: 'No token provided' });
    }
    
    console.log('🔐 [AUTH] Token received (first 20 chars):', token.substring(0, 20) + '...');
    
    try {
        const secret = getJwtSecret();
        console.log('🔐 [AUTH] Verifying token...');
        const decoded = jwt.verify(token, secret);
        console.log('✅ [AUTH] Token decoded successfully');
        console.log('✅ [AUTH] Decoded payload:', JSON.stringify(decoded, null, 2));
        
        const userId = decoded.user.id;
        console.log('✅ [AUTH] User ID from token:', userId);
        
        // ✅ Check if this is a special token (layer token or admin token)
        const isLayerToken = decoded.step && ['layer2', 'layer3'].includes(decoded.step);
        const isAdminToken = decoded.isAdmin === true;
        
        if (isLayerToken || isAdminToken) {
            // Special tokens: skip tokenVersion check
            if (isLayerToken) {
                console.log('🔑 [AUTH] Layer token verified (step:', decoded.step, ')');
                req.layerStep = decoded.step;
            } else {
                console.log('🔑 [AUTH] Admin token verified (isAdmin: true)');
            }
            req.userId = userId;
            console.log('✅ [AUTH] Special token accepted, userId:', userId);
            return next();
        }
        
        // Normal token: verify tokenVersion matches user's current version
        console.log('🔐 [AUTH] Fetching user from database to verify tokenVersion...');
        const user = await User.findById(userId).select('tokenVersion');
        if (!user) {
            console.error('❌ [AUTH] User not found for ID:', userId);
            return res.status(401).json({ message: 'User not found' });
        }
        
        console.log('🔐 [AUTH] User found. tokenVersion from DB:', user.tokenVersion);
        const tokenVersion = decoded.user.tokenVersion;
        console.log('🔐 [AUTH] tokenVersion from token:', tokenVersion);
        
        if (tokenVersion !== user.tokenVersion) {
            console.error('❌ [AUTH] Token revoked - version mismatch',
                'token:', tokenVersion,
                'user:', user.tokenVersion);
            return res.status(401).json({ message: 'Token revoked. Please log in again.' });
        }
        
        req.userId = userId;
        console.log('✅ [AUTH] Token fully verified, userId =', userId);
        next();
    } catch (err) {
        console.error('❌ [AUTH] Invalid token:', err.message);
        console.error('❌ [AUTH] Error details:', err);
        return res.status(401).json({ message: 'Invalid token' });
    }
};

module.exports = { verifyToken };
