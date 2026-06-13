// refreshCompanyJob.js
const cron = require('node-cron');
const Company = require('./Company');
// You may also need to import your Tavily search function here

// This job runs once a week (Sunday at 3 AM)
// It finds companies not updated in the last 30 days and re-enriches them
async function refreshOldCompanies() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const oldCompanies = await Company.find({ lastUpdated: { $lt: thirtyDaysAgo } });
    console.log(`🔄 [REFRESH] Found ${oldCompanies.length} companies older than 30 days`);
    
    for (const company of oldCompanies) {
        try {
            // Here you would call your enrichment function (e.g., Tavily search for this specific company)
            // For now, just log and update the timestamp
            console.log(`   Refreshing ${company.name} (${company.domain})`);
            
            // Example: await enrichCompany(company);
            // After successful enrichment, update lastUpdated
            company.lastUpdated = new Date();
            await company.save();
            
            // Add a small delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (err) {
            console.error(`   Failed to refresh ${company.domain}:`, err.message);
        }
    }
    console.log(`✅ [REFRESH] Completed`);
}

function startRefreshJob() {
    // Schedule to run every Sunday at 3 AM
    cron.schedule('0 3 * * 0', () => {
        refreshOldCompanies();
    });
    console.log(`⏰ [REFRESH JOB] Scheduled to run weekly on Sunday at 3 AM`);
    
    // Optional: run once on startup (can be commented out)
    // setTimeout(() => refreshOldCompanies(), 5000);
}

module.exports = { startRefreshJob, refreshOldCompanies };
