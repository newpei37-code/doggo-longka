"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CronService = void 0;
const cron = __importStar(require("node-cron"));
const retry_util_1 = require("./utils/retry.util");
class CronService {
    puppeteerService;
    telegramService;
    logger = {
        log: (message) => console.log(`[CronService] ${message}`),
        error: (message, error) => console.error(`[CronService] ${message}`, error),
    };
    cronJobs = [];
    constructor(puppeteerService, telegramService) {
        this.puppeteerService = puppeteerService;
        this.telegramService = telegramService;
    }
    async start() {
        const run = async () => {
            await this.startToolSession();
        };
        const options = { timezone: 'Asia/Ho_Chi_Minh' };
        this.cronJobs.push(cron.schedule('58 11-20 * * *', run, options), cron.schedule('28 12-21 * * *', run, options));
        if (process.env.RUN_NOW)
            void run();
    }
    stop() {
        for (const job of this.cronJobs)
            job.stop();
        this.cronJobs.length = 0;
    }
    async startToolSession() {
        try {
            await (0, retry_util_1.retryWithBackoffAndJitter)(async () => {
                await this.puppeteerService.runBaccaratAuto();
            }, {
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
                    this.logger.log(`🔄 Retry toàn phiên (đóng browser & chạy lại) lần ${attempt} sau ${Math.round(delay)}ms — ${error?.message ?? error}`);
                },
            });
        }
        catch (error) {
            this.logger.log('🛑 Tool sẽ dừng do lỗi sau nhiều lần thử');
            this.logger.error('❌ Lỗi:', error);
            return;
        }
    }
}
exports.CronService = CronService;
