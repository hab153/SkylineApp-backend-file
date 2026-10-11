'use strict';

// ────────────────────────────────────────────────────────────────
// ALLOCATION STORE
// ────────────────────────────────────────────────────────────────

// Module-level slot — holds the allocation for this run only.
// Cleared after the first read.
//
// Flow:
//   Controlling.js  →  saveAllocation(allocation)
//   Future layer    →  getAllocation()   ← returns the value, then clears
//
// The slot is in-memory. It does not persist across runs.

let storedAllocation = null;

// ────────────────────────────────────────────────────────────────
// SAVE
// ────────────────────────────────────────────────────────────────

// Stores the allocation into the slot.
// If called more than once before a read, the latest call overwrites
// the previous value — only the last saved allocation is kept.

function saveAllocation(allocation) {
    storedAllocation = allocation;
}

// ────────────────────────────────────────────────────────────────
// GET
// ────────────────────────────────────────────────────────────────

// Returns the stored allocation and clears the slot.
// After the read, storedAllocation is null.
// A subsequent call to getAllocation() returns null.
// If nothing was saved this run, returns null.

function getAllocation() {
    const value = storedAllocation;
    storedAllocation = null;
    return value;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    saveAllocation,
    getAllocation,
};
