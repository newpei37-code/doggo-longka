import { TelegramService } from './telegram/telegram.service';
import { PuppeteerService } from './puppeteer.service';
import { CronService } from './cron.service';
import { retryWithBackoffAndJitter } from './utils/retry.util';

async function bootstrap() {
  console.log('🚀 Bắt đầu tool Baccarat...');

  // Khởi tạo các service
  const telegramService = new TelegramService();
  const puppeteerService = new PuppeteerService(telegramService);
  const cronService = new CronService(
    puppeteerService,
    telegramService,
  );

  try {
    console.log('📱 Đang kết nối Telegram...'); 
    await retryWithBackoffAndJitter(
      async () => {
        await telegramService.connect();
      },
      {
        maxRetries: 5,
        initialDelay: 3000,
        maxDelay: 30000,
        retryableErrors: ['connection', 'timeout', 'network'],
        onRetry: (attempt, error, delay) => {
          console.log(  
            `🔄 Retry kết nối Telegram lần ${attempt} sau ${Math.round(delay)}ms...`,
          );
        },
      },
    );

    console.log('✅ Telegram đã kết nối thành công!');
  } catch (error) {
    console.error('❌ Lỗi khi kết nối Telegram sau nhiều lần thử:', error);
    process.exit(1);
  }

  // Khởi động cron service
  const a = await cronService.start();
  console.log(a);
  console.log(`✅ Tool Baccarat đã sẵn sàng`);
}

bootstrap().catch((error) => {
  console.error('❌ Lỗi khi khởi động ứng dụng:', error);
  process.exit(1);
});
