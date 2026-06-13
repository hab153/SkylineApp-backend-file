// SearchCache.js
const mongoose = require('mongoose');

const SearchCacheSchema = new mongoose.Schema({
    queryHash: { 
        type: String, 
        required: true, 
        unique: true, 
        index: true 
    },
    queryParams: { 
        type: Object, 
        required: true 
    },
    companyIds: [{ 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Company' 
    }],
    expiresAt: { 
        type: Date, 
        required: true, 
        index: true 
    },
    createdAt: { 
        type: Date, 
        default: Date.now 
    }
});

module.exports = mongoose.model('SearchCache', SearchCacheSchema);
