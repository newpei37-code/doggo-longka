import { PuppeteerService } from './puppeteer.service';
import { TelegramService } from './telegram/telegram.service';
export declare class CronService {
    private puppeteerService;
    private telegramService;
    private readonly logger;
    private readonly cronJobs;
    constructor(puppeteerService: PuppeteerService, telegramService: TelegramService);
    start(): Promise<void>;
    stop(): void;
    private startToolSession;
}
