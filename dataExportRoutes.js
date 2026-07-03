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
const { createExport, getExport, listExports, deleteExport } = require('./dataExport');
const path = require('path');
const fs = require('fs-extra');
const { EXPORT_DIR } = require('./dataExport');

/**
 * POST /api/data/export
 * Initiate a new data export
 * 
 * Body: { format: 'json' | 'csv' }
 */
router.post('/export', verifyToken, csrfProtection, async (req, res) => {
    try {
        const { format = 'json' } = req.body;
        
        // Validate format
        if (!['json', 'csv'].includes(format)) {
            return res.status(400).json({ 
                error: 'Invalid format. Supported formats: json, csv' 
            });
        }

        // Get IP for logging
        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const userAgent = req.headers['user-agent'];

        const result = await createExport(req.userId, format, ip, userAgent);

        res.json({
            success: true,
            message: `Export started successfully. Your ${format.toUpperCase()} export will be ready shortly.`,
            data: result
        });

    } catch (error) {
        console.error('[DataExport] Export error:', error);
        
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
        console.error('[DataExport] List exports error:', error);
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
        
        // Get export record
        const exportRecord = await getExport(req.userId, exportId);
        
        if (!exportRecord || !exportRecord.fileExists) {
            return res.status(404).json({ 
                error: 'Export not found or expired' 
            });
        }

        // Check if file is expired
        if (new Date(exportRecord.expiresAt) < new Date()) {
            return res.status(410).json({ 
                error: 'Export has expired. Please request a new one.' 
            });
        }

        // Get file path
        const fileName = exportRecord.fileName || `${exportId}.json`;
        const filePath = path.join(EXPORT_DIR, fileName);

        // Check if file exists
        if (!await fs.pathExists(filePath)) {
            return res.status(404).json({ 
                error: 'Export file not found' 
            });
        }

        // Determine content type
        let contentType;
        if (fileName.endsWith('.zip')) {
            contentType = 'application/zip';
        } else if (fileName.endsWith('.json')) {
            contentType = 'application/json';
        } else if (fileName.endsWith('.csv')) {
            contentType = 'text/csv';
        } else {
            contentType = 'application/octet-stream';
        }

        // Send file
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Length', exportRecord.fileSize || 0);

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);

    } catch (error) {
        console.error('[DataExport] Download error:', error);
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
        await deleteExport(req.userId, exportId);
        
        res.json({
            success: true,
            message: 'Export deleted successfully'
        });

    } catch (error) {
        console.error('[DataExport] Delete error:', error);
        if (error.message === 'Export not found') {
            return res.status(404).json({ error: error.message });
        }
        res.status(500).json({ 
            error: 'Failed to delete export' 
        });
    }
});

module.exports = router;
