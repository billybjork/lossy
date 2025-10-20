/**
 * GPU Job Queue Coordinator
 *
 * Sprint 07 - Task 2: Prevent concurrent GPU workloads
 *
 * Manages GPU job scheduling to prevent Whisper and future SigLIP
 * from running concurrently and causing errors or frame drops.
 *
 * Features:
 * - Simple FIFO queue for GPU tasks
 * - Priority support (high, normal, low)
 * - Automatic execution when GPU is idle
 * - Timeout support for stuck jobs
 */

const DEFAULT_TIMEOUT_MS = 30000; // 30 seconds

// Job priority levels
export const JobPriority = {
  HIGH: 'high',
  NORMAL: 'normal',
  LOW: 'low',
};

const PRIORITY_ORDER = {
  [JobPriority.HIGH]: 0,
  [JobPriority.NORMAL]: 1,
  [JobPriority.LOW]: 2,
};

class GPUJobQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.currentJob = null;
  }

  /**
   * Enqueue a GPU task for execution.
   *
   * @param {string} kind - Job type (e.g., 'whisper', 'siglip')
   * @param {Function} fn - Async function to execute
   * @param {Object} options - Options
   * @param {string} options.priority - Job priority (high, normal, low)
   * @param {number} options.timeout - Timeout in ms
   * @returns {Promise} Resolves with job result
   */
  enqueue(kind, fn, options = {}) {
    const { priority = JobPriority.NORMAL, timeout = DEFAULT_TIMEOUT_MS } = options;

    return new Promise((resolve, reject) => {
      const job = {
        id: crypto.randomUUID(),
        kind,
        fn,
        priority,
        timeout,
        resolve,
        reject,
        enqueuedAt: performance.now(),
      };

      // Insert into queue sorted by priority
      this.queue.push(job);
      this.queue.sort((a, b) => {
        const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
        if (priorityDiff !== 0) return priorityDiff;

        // If same priority, FIFO (earlier jobs first)
        return a.enqueuedAt - b.enqueuedAt;
      });

      console.log(
        `[GPUJobQueue] Enqueued ${kind} job (${priority} priority). Queue size: ${this.queue.length}`
      );

      // Start processing if idle
      if (!this.isProcessing) {
        this._processNext();
      }
    });
  }

  async _processNext() {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      return;
    }

    this.isProcessing = true;
    const job = this.queue.shift();
    this.currentJob = job;

    console.log(`[GPUJobQueue] Processing ${job.kind} job (${job.id})`);

    const startTime = performance.now();

    try {
      // Create timeout promise with cleanup
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`GPU job ${job.kind} timed out after ${job.timeout}ms`));
        }, job.timeout);
      });

      // Race job execution against timeout
      const result = await Promise.race([job.fn(), timeoutPromise]);

      // Clear timeout if job completed first (prevent memory leak)
      clearTimeout(timeoutId);

      const duration = performance.now() - startTime;
      console.log(`[GPUJobQueue] ${job.kind} job completed in ${duration.toFixed(0)}ms`);

      job.resolve(result);
    } catch (error) {
      const duration = performance.now() - startTime;
      console.error(
        `[GPUJobQueue] ${job.kind} job failed after ${duration.toFixed(0)}ms:`,
        error
      );

      job.reject(error);
    } finally {
      this.currentJob = null;

      // Process next job
      this._processNext();
    }
  }

  /**
   * Get current queue status.
   *
   * @returns {Object} Queue status
   */
  getStatus() {
    return {
      queueLength: this.queue.length,
      isProcessing: this.isProcessing,
      currentJob: this.currentJob
        ? {
            id: this.currentJob.id,
            kind: this.currentJob.kind,
            priority: this.currentJob.priority,
          }
        : null,
    };
  }

  /**
   * Clear all pending jobs.
   */
  clear() {
    console.log(`[GPUJobQueue] Clearing ${this.queue.length} pending jobs`);

    // Reject all pending jobs
    this.queue.forEach((job) => {
      job.reject(new Error('Job queue cleared'));
    });

    this.queue = [];
  }
}

// Singleton instance
const gpuJobQueue = new GPUJobQueue();

/**
 * Enqueue a GPU task for execution.
 *
 * @param {string} kind - Job type (e.g., 'whisper', 'siglip')
 * @param {Function} fn - Async function to execute
 * @param {Object} options - Options
 * @returns {Promise} Resolves with job result
 */
export function enqueueGpuTask(kind, fn, options = {}) {
  return gpuJobQueue.enqueue(kind, fn, options);
}

/**
 * Get current GPU queue status.
 */
export function getGpuQueueStatus() {
  return gpuJobQueue.getStatus();
}

/**
 * Clear all pending GPU jobs.
 */
export function clearGpuQueue() {
  gpuJobQueue.clear();
}
