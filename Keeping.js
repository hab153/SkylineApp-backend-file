'use strict';

// ────────────────────────────────────────────────────────────────
// ACCUMULATED RESULTS STORE
// ────────────────────────────────────────────────────────────────

// Module-level array — holds every entry for this run.
// Each entry is the per-company block produced by SearchingCompany.js:
//
//   {
//     name,
//     domain,
//     map,             // raw Tavily Map response or null
//     extract,         // raw Tavily Extract response or null
//     skipped,         // true if domain was null
//     mapFailed,       // true if Map call failed
//     extractFailed    // true if Extract call failed
//   }
//
// Cleared when the future layer calls getAll().
//
// Flow:
//   SearchingCompany.js  →  keeping({ ... })   ← appends
//   Future layer         →  getAll()           ← returns all, then clears
//
// The array is in-memory. It does not persist across runs.
//
// Mirrors Saving.js and Handling.js — same pattern, different phase.

let storedResults = [];

// ────────────────────────────────────────────────────────────────
// SAVE
// ────────────────────────────────────────────────────────────────

// Called by SearchingCompany.js once per company.
// Appends the incoming entry to the internal array.

function keeping(entry) {
    storedResults.push(entry);
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
    keeping,
    getAll,
};
