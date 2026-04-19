// requestQueue.js

class RequestQueue {
    constructor(maxConcurrent = 2) {
        this.maxConcurrent = maxConcurrent; // How many AI calls can run at once
        this.activeCount = 0;
        this.queue = [];
    }

    /**
     * Adds a task to the queue and returns a Promise that resolves when the task is done.
     * @param {Function} taskFunction - The async function to execute (e.g., calling OpenAI).
     */
    enqueue(taskFunction) {
        return new Promise((resolve, reject) => {
            // Add the task to the line
            this.queue.push({ taskFunction, resolve, reject });
            
            // Try to process the queue immediately
            this.processQueue();
        });
    }

    /**
     * Processes the next item in the queue if there are available slots.
     */
    async processQueue() {
        // If we are at max capacity or the queue is empty, do nothing
        if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) {
            return;
        }

        // Take the next task from the front of the line
        const { taskFunction, resolve, reject } = this.queue.shift();
        
        // Increment active count
        this.activeCount++;

        try {
            // Execute the actual AI call
            const result = await taskFunction();
            resolve(result);
        } catch (error) {
            reject(error);
        } finally {
            // Decrement active count and try to process the next waiting task
            this.activeCount--;
            this.processQueue();
        }
    }
}

// Export a single shared instance so all routes use the same queue
// We set it to 2 concurrent requests to be safe for standard OpenAI tiers.
// You can increase this if you have higher limits.
module.exports = new RequestQueue(2);
