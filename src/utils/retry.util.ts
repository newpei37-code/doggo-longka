export interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  retryableErrors?: string[];
  onRetry?: (attempt: number, error: any, delay: number) => void;
}

const DEFAULT_OPTIONS: Required<
  Omit<RetryOptions, 'onRetry' | 'retryableErrors'>
> & {
  retryableErrors: string[];
} = {
  maxRetries: 3,
  initialDelay: 1000, // 1 giây
  maxDelay: 30000, // 30 giây
  backoffMultiplier: 2,
  retryableErrors: [],
};

/**
 * Retry function với exponential backoff
 * @param fn Function cần retry
 * @param options Retry options
 * @returns Kết quả của function
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = {
    ...DEFAULT_OPTIONS,
    ...options,
    retryableErrors: options.retryableErrors || DEFAULT_OPTIONS.retryableErrors,
  };

  let lastError: any;
  let delay = opts.initialDelay;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Nếu đã hết số lần retry, throw error
      if (attempt === opts.maxRetries) {
        throw error;
      }

      // Kiểm tra xem error có thể retry không
      const errorMessage = error?.message || String(error);
      const errorName = error?.name || '';
      const isRetryable =
        opts.retryableErrors.length === 0 ||
        opts.retryableErrors.some(
          (retryableError) =>
            errorMessage.toLowerCase().includes(retryableError.toLowerCase()) ||
            errorName.toLowerCase().includes(retryableError.toLowerCase()),
        );

      if (!isRetryable) {
        throw error;
      }

      // Log retry attempt
      if (opts.onRetry) {
        opts.onRetry(attempt + 1, error, delay);
      } else {
        console.log(
          `🔄 Retry attempt ${attempt + 1}/${opts.maxRetries} sau ${delay}ms...`,
        );
      }

      // Đợi với exponential backoff
      await new Promise((resolve) => setTimeout(resolve, delay));

      // Tăng delay cho lần retry tiếp theo (exponential backoff)
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelay);
    }
  }

  throw lastError;
}

/**
 * Retry với jitter (random delay) để tránh thundering herd
 */
export async function retryWithBackoffAndJitter<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = {
    ...DEFAULT_OPTIONS,
    ...options,
    retryableErrors: options.retryableErrors || DEFAULT_OPTIONS.retryableErrors,
  };

  let lastError: any;
  let delay = opts.initialDelay;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      if (attempt === opts.maxRetries) {
        throw error;
      }

      const errorMessage = error?.message || String(error);
      const errorName = error?.name || '';
      const isRetryable =
        opts.retryableErrors.length === 0 ||
        opts.retryableErrors.some(
          (retryableError) =>
            errorMessage.toLowerCase().includes(retryableError.toLowerCase()) ||
            errorName.toLowerCase().includes(retryableError.toLowerCase()),
        );

      if (!isRetryable) {
        throw error;
      }

      // Thêm jitter (random 0-30% của delay)
      const jitter = delay * 0.3 * Math.random();
      const delayWithJitter = delay + jitter;

      if (opts.onRetry) {
        opts.onRetry(attempt + 1, error, delayWithJitter);
      } else {
        console.log(
          `🔄 Retry attempt ${attempt + 1}/${opts.maxRetries} sau ${Math.round(delayWithJitter)}ms...`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, delayWithJitter));

      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelay);
    }
  }

  throw lastError;
}
