// ────────────────────────────────────────────────────────────────
// Stream.js — Thin wrapper around Free.js
// ────────────────────────────────────────────────────────────────
'use strict';

const { generateFreeResponse } = require('./Free');

// ────────────────────────────────────────────────────────────────
// STREAM PIPELINE
// ────────────────────────────────────────────────────────────────

// Runs the full pipeline by calling Free.js, which fires all
// stage events (s1, s2, s3, done, error) through the onStage
// callback that Stream.js passes in.
//
// Stream.js adds nothing else — it just wraps Free.js and
// forwards the caller's onStage callback.

async function streamPipeline(message, options, onStage) {
    console.log('[Stream] Pipeline started');
    console.log('[Stream] Message:', message);

    // ── Guard: onStage must be a function ──
    if (typeof onStage !== 'function') {
        throw new Error('[Stream] onStage callback must be a function');
    }

    // ── Guard: message must be a non-empty string ──
    if (typeof message !== 'string' || message.trim().length === 0) {
        throw new Error('[Stream] message must be a non-empty string');
    }

    const safeOptions = options && typeof options === 'object' ? options : {};

    // ── Wrap the caller's onStage so we can log locally ──
    const stagePassThrough = (stageId, payload) => {
        try {
            console.log(`[Stream] Stage event — ${stageId}:`, payload);

            onStage(stageId, payload);
        } catch (callbackError) {
            console.error(
                '[Stream] onStage callback threw:',
                callbackError && callbackError.message
                    ? callbackError.message
                    : callbackError
            );
        }
    };

    try {
        // ── Delegate to Free.js, passing the stage callback ──
        const result = await generateFreeResponse(
            message,
            safeOptions.history || [],
            safeOptions.userProfile || null,
            safeOptions.onProgress || null,
            safeOptions,
            stagePassThrough
        );

        console.log('[Stream] Free.js returned:', result);

        console.log('[Stream] Pipeline finished');

        return result;
    } catch (error) {
        console.error(
            '[Stream] Pipeline failed:',
            error && error.message ? error.message : error
        );

        throw error;
    }
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    streamPipeline,
};
