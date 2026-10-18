'use strict';

// ────────────────────────────────────────────────────────────────
// ACCUMULATED RESULTS STORE
// ────────────────────────────────────────────────────────────────

// Module-level array — holds every entry for this run.
// Each entry is { search, response }, appended once per search.
// Cleared when the future layer calls getAll().
//
// Flow:
//   SearchHandler.js  →  handling({ search, response })   ← appends
//   Future layer      →  getAll()                         ← returns all, then clears
//
// The array is in-memory. It does not persist across runs.
//
// Mirrors Saving.js — same pattern, different source.

let storedResults = [];

// ────────────────────────────────────────────────────────────────
// SAVE
// ────────────────────────────────────────────────────────────────

// Called by SearchHandler.js once per search.
// Appends the incoming entry to the internal array.
// The entry shape is: { search: <phrase>, response: <tavilyResponse> }

function handling({ search, response }) {
    storedResults.push({ search, response });
}

// ────────────────────────────────────────────────────────────────
// GET ALL
// ────────────────────────────────────────────────────────────────

// Called by the future layer, once.
// Returns the full accumulated array of entries.
// Immediately clears the internal slot — the values disappear
// after this call.

function getAll() {
    const value = storedResults;
    storedResults = [];
    return value;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    handling,
    getAll,
};
