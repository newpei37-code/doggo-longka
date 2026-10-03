"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.retryWithBackoff = retryWithBackoff;
exports.retryWithBackoffAndJitter = retryWithBackoffAndJitter;
const DEFAULT_OPTIONS = {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
    retryableErrors: [],
};
async function retryWithBackoff(fn, options = {}) {
    const opts = {
        ...DEFAULT_OPTIONS,
        ...options,
        retryableErrors: options.retryableErrors || DEFAULT_OPTIONS.retryableErrors,
    };
    let lastError;
    let delay = opts.initialDelay;
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            if (attempt === opts.maxRetries) {
                throw error;
            }
            const errorMessage = error?.message || String(error);
            const errorName = error?.name || '';
            const isRetryable = opts.retryableErrors.length === 0 ||
                opts.retryableErrors.some((retryableError) => errorMessage.toLowerCase().includes(retryableError.toLowerCase()) ||
                    errorName.toLowerCase().includes(retryableError.toLowerCase()));
            if (!isRetryable) {
                throw error;
            }
            if (opts.onRetry) {
                opts.onRetry(attempt + 1, error, delay);
            }
            else {
                console.log(`🔄 Retry attempt ${attempt + 1}/${opts.maxRetries} sau ${delay}ms...`);
            }
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelay);
        }
    }
    throw lastError;
}
async function retryWithBackoffAndJitter(fn, options = {}) {
    const opts = {
        ...DEFAULT_OPTIONS,
        ...options,
        retryableErrors: options.retryableErrors || DEFAULT_OPTIONS.retryableErrors,
    };
    let lastError;
    let delay = opts.initialDelay;
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            if (attempt === opts.maxRetries) {
                throw error;
            }
            const errorMessage = error?.message || String(error);
            const errorName = error?.name || '';
            const isRetryable = opts.retryableErrors.length === 0 ||
                opts.retryableErrors.some((retryableError) => errorMessage.toLowerCase().includes(retryableError.toLowerCase()) ||
                    errorName.toLowerCase().includes(retryableError.toLowerCase()));
            if (!isRetryable) {
                throw error;
            }
            const jitter = delay * 0.3 * Math.random();
            const delayWithJitter = delay + jitter;
            if (opts.onRetry) {
                opts.onRetry(attempt + 1, error, delayWithJitter);
            }
            else {
                console.log(`🔄 Retry attempt ${attempt + 1}/${opts.maxRetries} sau ${Math.round(delayWithJitter)}ms...`);
            }
            await new Promise((resolve) => setTimeout(resolve, delayWithJitter));
            delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelay);
        }
    }
    throw lastError;
}
