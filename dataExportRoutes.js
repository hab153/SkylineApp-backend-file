/**
 * Data Export Routes
 * GDPR Article 20 – Right to Data Portability
 * 
 * @module dataExportRoutes
 */

const express = require('express');
const router = express.Router();
const { verifyToken } = require('./authMiddleware');
const { csrfProtection } = require('./csrf');
const { createExport, getExport, listExports, deleteExport, EXPORT_DIR } = require('./dataExport');
const path = require('path');
const fs = require('fs-extra');

// Resolved once at startup — never changes
const SAFE_EXPORT_DIR = path.resolve(EXPORT_DIR);

/**
 * ✅ Validate exportId against the strict pattern used by dataExport.js.
 * Only accepts: export_<digits>_<16 hex chars>
 * Returns null if invalid — no fallback.
 */
function validateExportId(exportId) {
    if (!exportId || typeof exportId !== 'string') return null;
    if (!/^export_\d+_[a-fA-F0-9]{16}$/.test(exportId)) return null;
    return exportId;
}

/**
 * ✅ Build a safe file path within EXPORT_DIR from an exportId and extension.
 * Uses path.basename() to strip any directory components.
 * Verifies the resolved path starts with SAFE_EXPORT_DIR + separator.
 * Returns null if anything is wrong.
 */
function buildSafeFilePath(exportId, extension) {
    const validId = validateExportId(exportId);
    if (!validId) return null;

    const allowedExt = ['json', 'zip', 'csv'];
    const ext = String(extension).replace(/^\./, '').toLowerCase();
    if (!allowedExt.includes(ext)) return null;

    const fileName = `${validId}.${ext}`;

    // path.basename strips any ../ or / components
    const baseName = path.basename(fileName);
    if (!baseName || baseName !== fileName) return null;

    const resolved = path.resolve(SAFE_EXPORT_DIR, baseName);

    // Must be inside SAFE_EXPORT_DIR
    if (!resolved.startsWith(SAFE_EXPORT_DIR + path.sep)) return null;

    return resolved;
}

/**
 * POST /api/data/export
 * Initiate a new data export
 */
router.post('/export', verifyToken, csrfProtection, async (req, res) => {
    try {
        const { format = 'json' } = req.body;

        if (!['json', 'csv'].includes(format)) {
            return res.status(400).json({
                error: 'Invalid format. Supported formats: json, csv'
            });
        }

        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const userAgent = req.headers['user-agent'];

        const result = await createExport(req.userId, format, ip, userAgent);

        res.json({
            success: true,
            message: `Export started successfully. Your ${format.toUpperCase()} export will be ready shortly.`,
            data: result
        });

    } catch (error) {
        console.error('[DataExport] Export error:', error.message);

        if (error.message === 'Rate limit exceeded. Please wait 1 hour before requesting another export.') {
            return res.status(429).json({ error: error.message });
        }
        if (error.message === 'User not found') {
            return res.status(404).json({ error: error.message });
        }

        res.status(500).json({
            error: 'Failed to create export. Please try again later.'
        });
    }
});

/**
 * GET /api/data/exports
 * List all exports for the user
 */
router.get('/exports', verifyToken, async (req, res) => {
    try {
        const exports = await listExports(req.userId);
        res.json({
            success: true,
            count: exports.length,
            data: exports
        });
    } catch (error) {
        console.error('[DataExport] List exports error:', error.message);
        if (error.message === 'User not found') {
            return res.status(404).json({ error: error.message });
        }
        res.status(500).json({
            error: 'Failed to list exports'
        });
    }
});

/**
 * GET /api/data/export/:exportId
 * Download an export file
 */
router.get('/export/:exportId', verifyToken, async (req, res) => {
    try {
        const { exportId } = req.params;

        // ✅ FIX #2/#3: Validate exportId against strict pattern
        const validExportId = validateExportId(exportId);
        if (!validExportId) {
            return res.status(400).json({
                error: 'Invalid export ID format'
            });
        }

        // Get export record from DB
        const exportRecord = await getExport(req.userId, validExportId);

        if (!exportRecord || !exportRecord.fileExists) {
            return res.status(404).json({
                error: 'Export not found or expired'
            });
        }

        if (new Date(exportRecord.expiresAt) < new Date()) {
            return res.status(410).json({
                error: 'Export has expired. Please request a new one.'
            });
        }

        // ✅ FIX #2/#3: Build safe file path using buildSafeFilePath().
        // This function uses path.basename() + prefix verification.
        // No raw path.join() with user-controlled input anywhere.
        const ext = exportRecord.format === 'csv' ? 'zip' : 'json';
        const filePath = buildSafeFilePath(validExportId, ext);

        if (!filePath) {
            console.warn(`⚠️ [DataExport] Blocked unsafe path for exportId: ${validExportId}`);
            return res.status(400).json({
                error: 'Invalid file path'
            });
        }

        if (!await fs.pathExists(filePath)) {
            return res.status(404).json({
                error: 'Export file not found'
            });
        }

        // Determine content type from the safe extension
        let contentType;
        if (ext === 'zip') {
            contentType = 'application/zip';
        } else if (ext === 'json') {
            contentType = 'application/json';
        } else if (ext === 'csv') {
            contentType = 'text/csv';
        } else {
            contentType = 'application/octet-stream';
        }

        const fileName = path.basename(filePath);

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Length', exportRecord.fileSize || 0);

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);

    } catch (error) {
        console.error('[DataExport] Download error:', error.message);
        if (error.message === 'Export not found') {
            return res.status(404).json({ error: error.message });
        }
        res.status(500).json({
            error: 'Failed to download export'
        });
    }
});

/**
 * DELETE /api/data/export/:exportId
 * Delete an export
 */
router.delete('/export/:exportId', verifyToken, csrfProtection, async (req, res) => {
    try {
        const { exportId } = req.params;

        const validExportId = validateExportId(exportId);
        if (!validExportId) {
            return res.status(400).json({
                error: 'Invalid export ID format'
            });
        }

        await deleteExport(req.userId, validExportId);

        res.json({
            success: true,
            message: 'Export deleted successfully'
        });

    } catch (error) {
        console.error('[DataExport] Delete error:', error.message);
        if (error.message === 'Export not found') {
            return res.status(404).json({ error: error.message });
        }
        res.status(500).json({
            error: 'Failed to delete export'
        });
    }
});

module.exports = router;
