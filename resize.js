// resize.js
const sharp = require('sharp');

/**
 * Resizes and compresses an image buffer.
 * @param {Buffer} imageBuffer - The original image buffer from multer.
 * @returns {Promise<Buffer>} - The resized and compressed image buffer.
 */
async function resizeImage(imageBuffer) {
    try {
        // Resize to max 1024px width/height while maintaining aspect ratio
        // Compress to JPEG with 80% quality
        const resizedBuffer = await sharp(imageBuffer)
            .resize(1024, 1024, {
                fit: 'inside',
                withoutEnlargement: true
            })
            .jpeg({ quality: 80 })
            .toBuffer();

        return resizedBuffer;
    } catch (error) {
        console.error("❌ Error resizing image:", error);
        throw new Error("Failed to process image");
    }
}

module.exports = { resizeImage };
