import * as cron from 'node-cron';
import { PuppeteerService } from './puppeteer.service';
import { TelegramService } from './telegram/telegram.service';
import { retryWithBackoffAndJitter } from './utils/retry.util';

export class CronService {
  private readonly logger = {
    log: (message: string) => console.log(`[CronService] ${message}`),
    error: (message: string, error?: any) =>
      console.error(`[CronService] ${message}`, error),
  };
  private readonly cronJobs: cron.ScheduledTask[] = [];

  constructor(
    private puppeteerService: PuppeteerService,
    private telegramService: TelegramService,
  ) {}

  async start(): Promise<void> {
    const run = async () => {
      await this.startToolSession();
    };
    const options = { timezone: 'Asia/Ho_Chi_Minh' };

    this.cronJobs.push(
      cron.schedule('58 11-20 * * *', run, options),
      cron.schedule('28 12-21 * * *', run, options),
    );
    if (process.env.RUN_NOW) void run();
  }

  stop() {
    for (const job of this.cronJobs) job.stop();
    this.cronJobs.length = 0;
  }

  private async startToolSession() {
    try {
      // if (this.isRunning) {
      //   return;
      // }
      // this.isRunning = true;

      await retryWithBackoffAndJitter(
        async () => {
          await this.puppeteerService.runBaccaratAuto();
        },
        {
          maxRetries: 4,
          initialDelay: 8000,
          maxDelay: 45000,
          retryableErrors: [
            'timeout',
            'navigation',
            'network',
            'browser',
            'gate',
            'iframe',
          ],
          onRetry: (attempt, error, delay) => {
            this.logger.log(
              `🔄 Retry toàn phiên (đóng browser & chạy lại) lần ${attempt} sau ${Math.round(delay)}ms — ${error?.message ?? error}`,
            );
          },
        },
      );
      // Bỏ thống kê lời/lỗ theo ngày (DailySummaryService)
    } catch (error) {
      this.logger.log('🛑 Tool sẽ dừng do lỗi sau nhiều lần thử');
      this.logger.error('❌ Lỗi:', error);
      return;
    }
  }
}
