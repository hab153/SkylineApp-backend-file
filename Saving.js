'use strict';

// ────────────────────────────────────────────────────────────────
// ACCUMULATED RESULTS STORE
// ────────────────────────────────────────────────────────────────

// Module-level array — holds every entry for this run.
// Each entry is { search, response }, appended once per search.
// Cleared when the future layer calls getAll().
//
// Flow:
//   SearchSystem.js  →  saving({ search, response })   ← appends
//   Future layer     →  getAll()                        ← returns all, then clears
//
// The array is in-memory. It does not persist across runs.

let storedResults = [];

// ────────────────────────────────────────────────────────────────
// SAVE
// ────────────────────────────────────────────────────────────────

// Called by SearchSystem.js once per search.
// Appends the incoming entry to the internal array.
// The entry shape is: { search: <phrase>, response: <tavilyResponse> }

function saving({ search, response }) {
    storedResults.push({ search, response });
}

// ────────────────────────────────────────────────────────────────
// GET ALL
// ────────────────────────────────────────────────────────────────

// Called by the future layer, once.
// Returns the full accumulated array of entries.
// Immediately clears the internal slot — the values disappear
// after this call. Nobody calls it a second time.

function getAll() {
    const value = storedResults;
    storedResults = [];
    return value;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    saving,
    getAll,
};
