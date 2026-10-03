"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const telegram_service_1 = require("./telegram/telegram.service");
const puppeteer_service_1 = require("./puppeteer.service");
const cron_service_1 = require("./cron.service");
const retry_util_1 = require("./utils/retry.util");
async function bootstrap() {
    console.log('🚀 Bắt đầu tool Baccarat...');
    const telegramService = new telegram_service_1.TelegramService();
    const puppeteerService = new puppeteer_service_1.PuppeteerService(telegramService);
    const cronService = new cron_service_1.CronService(puppeteerService, telegramService);
    try {
        console.log('📱 Đang kết nối Telegram...');
        await (0, retry_util_1.retryWithBackoffAndJitter)(async () => {
            await telegramService.connect();
        }, {
            maxRetries: 5,
            initialDelay: 3000,
            maxDelay: 30000,
            retryableErrors: ['connection', 'timeout', 'network'],
            onRetry: (attempt, error, delay) => {
                console.log(`🔄 Retry kết nối Telegram lần ${attempt} sau ${Math.round(delay)}ms...`);
            },
        });
        console.log('✅ Telegram đã kết nối thành công!');
    }
    catch (error) {
        console.error('❌ Lỗi khi kết nối Telegram sau nhiều lần thử:', error);
        process.exit(1);
    }
    const a = await cronService.start();
    console.log(a);
    console.log(`✅ Tool Baccarat đã sẵn sàng`);
}
bootstrap().catch((error) => {
    console.error('❌ Lỗi khi khởi động ứng dụng:', error);
    process.exit(1);
});
