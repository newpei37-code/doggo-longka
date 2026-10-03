export interface RetryOptions {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    backoffMultiplier?: number;
    retryableErrors?: string[];
    onRetry?: (attempt: number, error: any, delay: number) => void;
}
export declare function retryWithBackoff<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>;
export declare function retryWithBackoffAndJitter<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>;
