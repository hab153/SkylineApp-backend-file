// encryption.js
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT = 'skyline-encryption-salt-2024';

function getEncryptionKey() {
    let masterKey = process.env.ENCRYPTION_KEY;
    if (!masterKey) {
        console.warn('⚠️ ENCRYPTION_KEY not set. Generating a random key.');
        masterKey = crypto.randomBytes(KEY_LENGTH).toString('hex');
        console.warn('⚠️ Temporary key (save this in .env):', masterKey);
    }
    return crypto.pbkdf2Sync(masterKey, SALT, 100000, KEY_LENGTH, 'sha256');
}

function encrypt(plaintext) {
    if (!plaintext) return null;
    try {
        const key = getEncryptionKey();
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
        let encrypted = cipher.update(plaintext, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        const authTag = cipher.getAuthTag();
        const combined = Buffer.concat([iv, authTag, Buffer.from(encrypted, 'base64')]);
        return combined.toString('base64');
    } catch (err) {
        console.error('Encryption error:', err);
        return null;
    }
}

function decrypt(ciphertext) {
    if (!ciphertext) return null;
    try {
        const key = getEncryptionKey();
        const buffer = Buffer.from(ciphertext, 'base64');
        const iv = buffer.subarray(0, IV_LENGTH);
        const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
        const encrypted = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(encrypted, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) {
        console.error('Decryption error:', err);
        return null;
    }
}

module.exports = { encrypt, decrypt };
