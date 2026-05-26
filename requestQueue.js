// requestQueue.js

class RequestQueue {
    constructor(maxConcurrent = 2, maxQueueSize = 150, taskTimeoutMs = 240000) { // 4 minutes
        this.maxConcurrent = maxConcurrent;
        this.maxQueueSize = maxQueueSize;
        this.taskTimeoutMs = taskTimeoutMs;
        this.activeCount = 0;
        this.queue = [];
    }

    /**
     * Adds a task to the queue.
     * Returns a Promise that resolves with the task result.
     * Rejects with friendly messages if queue is full or task times out.
     */
    enqueue(taskFunction) {
        return new Promise((resolve, reject) => {
            // Friendly rejection when queue is full
            if (this.queue.length >= this.maxQueueSize) {
                return reject(new Error('Our AI assistant is very busy right now. Please wait a moment and try again.'));
            }

            this.queue.push({ taskFunction, resolve, reject });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) {
            return;
        }

        const { taskFunction, resolve, reject } = this.queue.shift();
        this.activeCount++;

        // Timeout promise with friendly error
        const timeoutPromise = new Promise((_, rejectTimeout) => {
            setTimeout(() => {
                rejectTimeout(new Error('This request is taking longer than expected. Our AI is still working on it, but please try again in a few moments.'));
            }, this.taskTimeoutMs);
        });

        try {
            const result = await Promise.race([taskFunction(), timeoutPromise]);
            resolve(result);
        } catch (error) {
            reject(error);
        } finally {
            this.activeCount--;
            this.processQueue();
        }
    }

    // Optional: get queue stats for monitoring (admin use only)
    getStats() {
        return {
            activeCount: this.activeCount,
            queueLength: this.queue.length,
            maxConcurrent: this.maxConcurrent,
            maxQueueSize: this.maxQueueSize
        };
    }
}

// Three queues with different concurrency limits and 4‑minute timeout
const freeQueue = new RequestQueue(2, 150, 240000);   // Free: 2 concurrent, 150 waiting
const goQueue   = new RequestQueue(5, 200, 240000);   // Go:   5 concurrent, 200 waiting
const proQueue  = new RequestQueue(10, 300, 240000);  // Pro: 10 concurrent, 300 waiting

module.exports = { freeQueue, goQueue, proQueue };
