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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PuppeteerService = void 0;
const puppeteer = __importStar(require("puppeteer"));
const sharp_1 = __importDefault(require("sharp"));
const path = __importStar(require("path"));
const telegram_config_1 = require("../config/telegram.config");
const fs = __importStar(require("fs"));
const retry_util_1 = require("./utils/retry.util");
const google_sheets_service_1 = require("./google-sheets.service");
const session_ca_util_1 = require("./session-ca.util");
const browser_path_util_1 = require("./browser-path.util");
const ca_profit_util_1 = require("./ca-profit.util");
class PuppeteerService {
    logger = {
        log: (message) => console.log(`[PuppeteerService] ${message}`),
        error: (message, error) => console.error(`[PuppeteerService] ${message}`, error),
    };
    browser = null;
    telegramService;
    selectedTableName = '';
    screenshotLock = Promise.resolve();
    lastRunProfit = 0;
    lastGameResult_that = null;
    lastRunProfit_ao = 0;
    lastGameResult_ao = null;
    currentSessionCa = null;
    constructor(telegramService) {
        this.telegramService = telegramService;
    }
    chiGuiNhomAo() {
        return Boolean(telegram_config_1.telegramConfig.chi_gui_nhom_ao);
    }
    shouldSendToNhomThat() {
        return !this.chiGuiNhomAo();
    }
    formatSignedAmount(amount) {
        if (amount === 0)
            return '0';
        const abs = Math.abs(Math.round(amount)).toLocaleString('de-DE');
        return amount > 0 ? `+${abs}` : `-${abs}`;
    }
    formatCaAmountForGroup(amount, group) {
        if (amount === 0) {
            return group === 'ao' ? '+0.000' : '+0.000';
        }
        return this.formatSignedAmount(amount);
    }
    insertBeforeLastEmoji(line, textToInsert) {
        const trailingSpacesMatch = line.match(/\s*$/);
        const trailingSpaces = trailingSpacesMatch?.[0] ?? '';
        const core = trailingSpaces ? line.slice(0, -trailingSpaces.length) : line;
        const chars = Array.from(core);
        if (chars.length === 0)
            return `${line} ${textToInsert}`;
        const emojiLike = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;
        for (let i = chars.length - 1; i >= 0; i--) {
            if (emojiLike.test(chars[i])) {
                const before = chars.slice(0, i).join('');
                const fromLastEmoji = chars.slice(i).join('');
                return `${before} ${textToInsert}${fromLastEmoji}${trailingSpaces}`;
            }
        }
        return `${core} ${textToInsert}${trailingSpaces}`;
    }
    parseCaIndexFromTongKetLine(line) {
        const caMatch = line
            .normalize('NFKC')
            .match(/\bCA\b\s*((?:\d\p{M}*){1,2})(?!\d|\s*h\s*\d)/iu);
        if (caMatch) {
            const n = Number.parseInt(caMatch[1].replace(/\D/g, ''), 10);
            if (n >= 1 && n <= 30)
                return n;
        }
        const hourMatch = line.match(/(\d{1,2})\s*h\s*\d{2}/i);
        if (hourMatch) {
            const caFromHour = Number.parseInt(hourMatch[1], 10) - 6;
            if (caFromHour >= 1 && caFromHour <= 30)
                return caFromHour;
        }
        return null;
    }
    isTongKetCaLine(line) {
        const normalized = line.normalize('NFKC');
        return (/\bCA\b/i.test(normalized) &&
            (/\d{1,2}\s*h\s*\d{2}/i.test(normalized) || /📣/.test(normalized)));
    }
    editTongKetCaLines(text, group) {
        const caProfits = (0, ca_profit_util_1.getCaProfitsToday)(group);
        const { today, month } = (0, ca_profit_util_1.getTotalsForMonth)(group);
        const cfgLink = String(telegram_config_1.telegramConfig.dang_ky_link ?? '').trim();
        const foundUser = text.match(/@([a-zA-Z0-9_]{4,})/);
        const inferredLink = foundUser ? `https://t.me/${foundUser[1]}` : '';
        const dangKyLink = cfgLink || inferredLink || 'https://gk881.sbs/?f=1138433';
        let caCursor = 0;
        const filledCas = [];
        const result = text
            .split('\n')
            .map((line) => {
            if (this.isTongKetCaLine(line)) {
                const caIndex = this.parseCaIndexFromTongKetLine(line);
                if (caIndex && typeof caProfits[caIndex] === 'number') {
                    filledCas.push(caIndex);
                    const amount = this.formatCaAmountForGroup(caProfits[caIndex], group);
                    if (/:\s*[+-]?\s*$/.test(line)) {
                        return line.replace(/:\s*[+-]?\s*$/, `: ${amount}`);
                    }
                    return this.insertBeforeLastEmoji(line, amount);
                }
                return line;
            }
            if (line.includes('H30') || line.includes('H00')) {
                caCursor += 1;
                const caMatch = line.match(/Ca\s*0?(\d+)/i);
                const caIndex = caMatch
                    ? Number.parseInt(caMatch[1], 10)
                    : caCursor;
                if (typeof caProfits[caIndex] === 'number') {
                    filledCas.push(caIndex);
                    return this.insertBeforeLastEmoji(line, this.formatCaAmountForGroup(caProfits[caIndex], group));
                }
                return line;
            }
            const hourSlot = line.match(/-(\d{1,2})H\d{2}/i);
            if (hourSlot) {
                const hour = Number.parseInt(hourSlot[1], 10);
                const caFromHour = hour - 6;
                if (caFromHour >= 1 && typeof caProfits[caFromHour] === 'number') {
                    filledCas.push(caFromHour);
                    return this.insertBeforeLastEmoji(line, this.formatCaAmountForGroup(caProfits[caFromHour], group));
                }
                return line;
            }
            if (/TỔNG\s+NGÀY/i.test(line) || /\bNGÀY\s*:/i.test(line)) {
                return this.insertBeforeLastEmoji(line, this.formatSignedAmount(today));
            }
            if (/TỔNG\s+THÁNG/i.test(line) || /\bTHÁNG\s*\d*\s*:/i.test(line)) {
                return this.insertBeforeLastEmoji(line, this.formatSignedAmount(month));
            }
            if (/ĐĂNG\s*KÝ/i.test(line) && !/https?:\/\//i.test(line)) {
                return `${line} ${dangKyLink}`;
            }
            return line;
        })
            .join('\n');
        this.logger.log(`📊 Tổng kết (${group}): điền ${filledCas.length} ca [${filledCas.join(',')}], ngày=${this.formatSignedAmount(today)}, tháng=${this.formatSignedAmount(month)}`);
        return result;
    }
    getChromeLaunchOptions() {
        const opts = {
            headless: !process.env.RUN_NOW,
            env: { ...process.env, LANGUAGE: 'vi' },
            protocolTimeout: 120000,
            args: [
                '--lang=vi-VN',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--no-first-run',
                '--no-zygote',
                '--start-maximized',
                '--enable-gpu',
                '--enable-gpu-rasterization',
                '--enable-accelerated-2d-canvas',
                '--enable-accelerated-mjpeg-decode',
                '--enable-accelerated-video-decode',
                '--enable-native-gpu-memory-buffers',
                '--enable-gpu-compositing',
                '--enable-webgl',
                '--enable-webgl2',
                '--enable-accelerated-video',
                '--enable-zero-copy',
                '--enable-gpu-memory-buffer-video-frames',
                '--enable-gpu-sandbox',
                '--enable-hardware-overlays',
                '--enable-oop-rasterization',
                '--enable-raw-draw',
                '--enable-skia-graphite',
                '--enable-vulkan',
                '--enable-vulkan-validation',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=VizDisplayCompositor',
                '--disable-web-security',
                '--disable-features=TranslateUI',
                '--disable-client-side-phishing-detection',
                '--disable-sync',
                '--disable-default-apps',
                '--disable-extensions',
                '--disable-plugins',
                '--no-default-browser-check',
                '--disable-background-timer-throttling',
                '--disable-background-networking',
                '--disable-breakpad',
                '--disable-component-update',
                '--disable-domain-reliability',
                '--disable-popup-blocking',
                '--disable-hang-monitor',
                '--disable-prompt-on-repost',
                '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows',
                '--disable-ipc-flooding-protection',
                '--password-store=basic',
                '--use-mock-keychain',
                '--no-pings',
                '--disable-features=TranslateUI,BlinkGenPropertyTrees',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
            ],
        };
        const systemChrome = (0, browser_path_util_1.resolveChromeExecutablePath)();
        if (systemChrome) {
            opts.executablePath = systemChrome;
            this.logger.log(`🌐 Dùng Chrome hệ thống: ${systemChrome}`);
            return opts;
        }
        try {
            const bundled = puppeteer.executablePath();
            if (bundled && fs.existsSync(bundled)) {
                opts.executablePath = bundled;
                this.logger.log(`🌐 Dùng Chrome cache Puppeteer: ${bundled}`);
                return opts;
            }
        }
        catch {
        }
        this.logger.log('⚠️ Chưa tìm thấy Chrome. Trên VPS: thêm chrome_executable_path vào config.json hoặc chạy: npx puppeteer browsers install chrome');
        return opts;
    }
    async launchBrowser() {
        return (0, retry_util_1.retryWithBackoffAndJitter)(async () => {
            this.browser = await puppeteer.launch(this.getChromeLaunchOptions());
        }, {
            maxRetries: 3,
            initialDelay: 2000,
            maxDelay: 10000,
            retryableErrors: ['browser', 'launch', 'timeout', 'network'],
            onRetry: (attempt, error, delay) => {
                this.logger.log(`🔄 Retry khởi tạo browser lần ${attempt} sau ${Math.round(delay)}ms...`);
            },
        }).catch((error) => {
            this.logger.error('❌ Lỗi khi khởi tạo trình duyệt:', error);
            throw error;
        });
    }
    async openPage(url) {
        return (0, retry_util_1.retryWithBackoffAndJitter)(async () => {
            if (!this.browser) {
                await this.launchBrowser();
            }
            const page = await this.browser.newPage();
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined,
                });
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5],
                });
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en'],
                });
                window.chrome = {
                    runtime: {},
                };
                Object.defineProperty(navigator, 'getParameter', {
                    get: () => () => null,
                });
            });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36');
            await page.setViewport({
                width: 1920,
                height: 1080,
                deviceScaleFactor: 1,
                hasTouch: false,
                isLandscape: true,
                isMobile: false,
            });
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'Upgrade-Insecure-Requests': '1',
                'Cache-Control': 'max-age=0',
            });
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 2000 + 1000));
            await page.goto(url, {
                waitUntil: 'networkidle2',
                timeout: 30000,
            });
            return page;
        }, {
            maxRetries: 3,
            initialDelay: 2000,
            maxDelay: 10000,
            retryableErrors: ['timeout', 'navigation', 'network', 'net::'],
            onRetry: (attempt, error, delay) => {
                this.logger.log(`🔄 Retry mở trang lần ${attempt} sau ${Math.round(delay)}ms...`);
            },
        }).catch((error) => {
            this.logger.error('❌ Lỗi khi mở trang:', error);
            throw error;
        });
    }
    async closeBrowser() {
        try {
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
                this.logger.log('🛑 Đã đóng toàn bộ trình duyệt. 🛑 KẾT THÚC CA');
                return;
            }
        }
        catch (error) {
            this.logger.error('❌ Lỗi khi đóng page:', error);
            throw error;
        }
    }
    async login(page, username, password) {
        try {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            this.logger.log('🔐 Bắt đầu đăng nhập...');
            await page.waitForSelector('#login', { timeout: 15000 });
            await page.type('#login', username);
            this.logger.log('✅ Đã nhập username');
            await page.waitForSelector('#password', { timeout: 15000 });
            await page.type('#password', password);
            this.logger.log('✅ Đã nhập password');
            this.logger.log('🔍 Đang tìm nút đăng nhập...');
            const navigationPromise = page
                .waitForNavigation({
                waitUntil: 'networkidle2',
                timeout: 30000,
            })
                .catch(() => {
                this.logger.log('⚠️ Không có navigation sau khi đăng nhập');
                return null;
            });
            const clicked = await page.waitForFunction(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const loginButton = buttons.find((btn) => btn.textContent?.includes('Đăng Nhập'));
                if (loginButton) {
                    loginButton.click();
                    return true;
                }
                return false;
            }, { timeout: 10000 });
            if (!clicked) {
                throw new Error('Không tìm thấy nút Đăng Nhập');
            }
            this.logger.log('✅ Đã click nút đăng nhập');
            await navigationPromise;
            this.logger.log('⏳ Đợi page ổn định sau đăng nhập...');
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const currentUrl = page.url();
            this.logger.log(`📄 URL sau khi đăng nhập: ${currentUrl}`);
            try {
                await page.waitForFunction(() => {
                    return (document.querySelector('[data-provider="SEXYBCRT"]') !== null);
                }, { timeout: 10000 });
                this.logger.log('✅ Đăng nhập thành công - Đã tìm thấy SEXYBCRT');
            }
            catch (checkError) {
                this.logger.log('⚠️ Không tìm thấy SEXYBCRT ngay sau login, có thể cần đợi thêm');
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
        }
        catch (error) {
            this.logger.error('❌ Lỗi khi đăng nhập:', error);
            try {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                await page.screenshot({
                    path: `screenshots-debug/login-error-${timestamp}.png`,
                    fullPage: true,
                });
                this.logger.log('📸 Đã chụp screenshot lỗi đăng nhập');
            }
            catch (screenshotError) {
            }
            throw error;
        }
    }
    async navigateToSexyBaccarat(page) {
        this.logger.log('🚀 [navigateToSexyBaccarat] BẮT ĐẦU');
        try {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const newPagePromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.logger.error('❌ TIMEOUT: Không có page mới sau 30 giây');
                    reject(new Error('Timeout: Không có page mới sau 30 giây'));
                }, 30000);
                page.browser()?.on('targetcreated', async (target) => {
                    try {
                        if (target.type() === 'page') {
                            const newPage = await target.page();
                            if (newPage) {
                                clearTimeout(timeout);
                                this.logger.log(`✅ [Event] Đã tìm thấy page mới: ${newPage.url()}`);
                                resolve(newPage);
                            }
                        }
                    }
                    catch (error) {
                        this.logger.error('❌ [Event] Lỗi trong targetcreated:', error);
                        clearTimeout(timeout);
                        reject(error);
                    }
                });
            });
            const found = await page.waitForFunction(() => {
                const selectors = [
                    'a[data-provider="SEXYBCRT"]',
                    'li[data-provider="sexybcrt"] a[data-provider="SEXYBCRT"]',
                    '[data-provider="SEXYBCRT"]',
                    '*[data-provider="SEXYBCRT"]',
                ];
                for (const selector of selectors) {
                    try {
                        const element = document.querySelector(selector);
                        if (element && element.offsetParent !== null) {
                            element.click();
                            return true;
                        }
                    }
                    catch (e) {
                        continue;
                    }
                }
                return false;
            }, { timeout: 15000 });
            if (!found) {
                throw new Error('Không tìm thấy sảnh SEXYBCRT');
            }
            const newPage = await newPagePromise;
            try {
                await newPage.waitForNavigation({
                    waitUntil: 'networkidle2',
                    timeout: 30000,
                });
            }
            catch (navError) {
                this.logger.log('⚠️ [5/6] Navigation timeout hoặc không cần thiết');
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
            const finalUrl = newPage.url();
            this.logger.log('🎉 [navigateToSexyBaccarat] HOÀN THÀNH');
            return newPage;
        }
        catch (error) {
            this.logger.error('❌ [navigateToSexyBaccarat] LỖI:', error);
            this.logger.error('Stack:', error?.stack);
            try {
                if (!fs.existsSync('screenshots-debug')) {
                    fs.mkdirSync('screenshots-debug', { recursive: true });
                }
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                await page.screenshot({
                    path: `screenshots-debug/navigate-error-${timestamp}.png`,
                    fullPage: true,
                });
                this.logger.log('📸 Đã chụp screenshot lỗi');
            }
            catch (screenshotError) {
            }
            throw error;
        }
    }
    async replaceGameMessage(frame, isWin, amount) {
        try {
            console.log('win', isWin);
            console.log('amt', amount);
            await frame.evaluate((win, amt) => {
                const oldElement = document.getElementById('gameMessage');
                if (oldElement) {
                    oldElement.remove();
                }
                const newElement = document.createElement('div');
                newElement.id = 'gameMessage';
                newElement.className = win ? 'message_win' : 'message_lose';
                newElement.style.cssText = 'right: 48px;';
                newElement.style.animation = 'none';
                const p = document.createElement('p');
                p.textContent = amt;
                newElement.appendChild(p);
                document.body.appendChild(newElement);
            }, isWin, amount);
            this.logger.log(`✅ Đã thay thế #gameMessage: ${amount}`);
        }
        catch (error) {
            this.logger.error('❌ Lỗi thay thế gameMessage:', error);
        }
    }
    getGameBetConfig(useAo) {
        const defaultConfig = {
            betAmount: 200,
            bankerOdds: 0.95,
            playerOdds: 1.0,
        };
        const main = telegram_config_1.telegramConfig.gameBetConfig || defaultConfig;
        if (useAo && telegram_config_1.telegramConfig.gameBetConfigAo) {
            const ao = telegram_config_1.telegramConfig.gameBetConfigAo;
            return {
                betAmount: ao.betAmount ?? main.betAmount ?? 2000,
                bankerOdds: ao.bankerOdds ?? main.bankerOdds ?? 0.95,
                playerOdds: ao.playerOdds ?? main.playerOdds ?? 1.0,
            };
        }
        return {
            betAmount: main.betAmount ?? 2000,
            bankerOdds: main.bankerOdds ?? 0.95,
            playerOdds: main.playerOdds ?? 1.0,
        };
    }
    getBetAmount(useAo) {
        const config = this.getGameBetConfig(useAo ?? false);
        return config.betAmount;
    }
    getPredictionLink(prediction) {
        return ((prediction.toUpperCase().includes('CÁI')
            ? telegram_config_1.telegramConfig.link_forward_du_doan_cai
            : telegram_config_1.telegramConfig.link_forward_du_doan_con) || '');
    }
    getResultLink(isDraw, isWin) {
        return ((isDraw
            ? telegram_config_1.telegramConfig.link_forward_lenh_ket_thuc_draw
            : isWin
                ? telegram_config_1.telegramConfig.link_forward_lenh_ket_thuc_win
                : telegram_config_1.telegramConfig.link_forward_lenh_ket_thuc_lose) || '');
    }
    calculateWinAmount(winner, useAo) {
        const config = this.getGameBetConfig(useAo ?? false);
        const { betAmount, bankerOdds, playerOdds } = config;
        if (winner?.toUpperCase() === 'NHÀ CÁI') {
            return betAmount * bankerOdds;
        }
        else {
            return betAmount * playerOdds;
        }
    }
    calculateAmount(isDraw, isWin, winner, useAo) {
        const config = this.getGameBetConfig(useAo ?? false);
        const { betAmount, bankerOdds, playerOdds } = config;
        if (isDraw) {
            return '+0';
        }
        if (isWin) {
            let winAmount;
            if (winner?.toUpperCase() === 'NHÀ CÁI') {
                winAmount = betAmount * bankerOdds;
            }
            else {
                winAmount = betAmount * playerOdds;
            }
            return `+${winAmount.toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
            })}`;
        }
        return `-${betAmount.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        })}`;
    }
    async waitForGameIframeReady(page) {
        this.logger.log('⏳ Gate: Đang chờ iframe game xuất hiện...');
        const maxAttempts = 50;
        const checkInterval = 2000;
        const reloadEveryAttempts = 12;
        const selectors = [
            '#iframeGameHall',
            'iframe#iframeGameHall',
            'iframe[id="iframeGameHall"]',
            '#iframeGame',
            'iframe#iframeGame',
        ];
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            for (const selector of selectors) {
                try {
                    const found = await page.$(selector);
                    if (found) {
                        this.logger.log(`✅ Gate: Đã thấy iframe (${selector})`);
                        return;
                    }
                }
                catch {
                }
            }
            const allIframes = await page.$$('iframe');
            if (allIframes.length > 0) {
                this.logger.log(`✅ Gate: Đã thấy ${allIframes.length} iframe`);
                return;
            }
            if (attempt < maxAttempts - 1) {
                if (attempt > 0 &&
                    attempt % reloadEveryAttempts === 0) {
                    this.logger.log('🔄 Gate: Chưa thấy iframe — reload trang game rồi chờ tiếp...');
                    try {
                        await page.reload({
                            waitUntil: 'domcontentloaded',
                            timeout: 60000,
                        });
                        await new Promise((resolve) => setTimeout(resolve, 3000));
                    }
                    catch (reloadErr) {
                        this.logger.log(`⚠️ Gate: Reload lỗi, tiếp tục chờ: ${reloadErr}`);
                    }
                }
                await new Promise((resolve) => setTimeout(resolve, checkInterval));
            }
        }
        throw new Error('Gate fail: Không tìm thấy iframe game sau nhiều lần chờ và reload');
    }
    getGroupAoIds() {
        const config = telegram_config_1.telegramConfig.gui_tin_nhan_vao_group_ao;
        if (Array.isArray(config)) {
            return config;
        }
        return [config];
    }
    cleanupAllScreenshotFolders() {
        const path = require('path');
        try {
            if (fs.existsSync('screenshots-result')) {
                const files = fs.readdirSync('screenshots-result');
                for (const f of files) {
                    const full = path.join('screenshots-result', f);
                    if (fs.statSync(full).isFile())
                        fs.unlinkSync(full);
                }
                this.logger.log('✅ Đã xóa ảnh trong screenshots-result');
            }
            if (fs.existsSync('screenshots-table')) {
                const files = fs.readdirSync('screenshots-table');
                for (const f of files) {
                    const full = path.join('screenshots-table', f);
                    if (fs.statSync(full).isFile())
                        fs.unlinkSync(full);
                }
                this.logger.log('✅ Đã xóa ảnh trong screenshots-table');
            }
            if (fs.existsSync('screenshots-tables')) {
                const subs = fs.readdirSync('screenshots-tables');
                for (const sub of subs) {
                    const full = path.join('screenshots-tables', sub);
                    if (fs.statSync(full).isDirectory()) {
                        fs.rmSync(full, { recursive: true });
                    }
                    else {
                        fs.unlinkSync(full);
                    }
                }
                this.logger.log('✅ Đã xóa ảnh và folder trong screenshots-tables');
            }
        }
        catch (err) {
            this.logger.error('❌ Lỗi xóa ảnh/folder:', err);
        }
    }
    async sendMessageToGroupAo(message, delay = 500) {
        const groupIds = this.getGroupAoIds();
        for (let i = 0; i < groupIds.length; i++) {
            try {
                await this.telegramService.sendMessage(groupIds[i], message);
                this.logger.log(`✅ Đã gửi tin nhắn đến group ảo ${i + 1}/${groupIds.length}`);
                if (i < groupIds.length - 1) {
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
            catch (error) {
                this.logger.error(`❌ Lỗi gửi tin nhắn đến group ảo ${i + 1}:`, error);
            }
        }
    }
    async sendPhotoToGroupAo(photoPath, caption, delay = 500) {
        const groupIds = this.getGroupAoIds();
        for (let i = 0; i < groupIds.length; i++) {
            try {
                await this.telegramService.sendPhoto(groupIds[i], photoPath, caption);
                this.logger.log(`✅ Đã gửi ảnh đến group ảo ${i + 1}/${groupIds.length}`);
                if (i < groupIds.length - 1) {
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
            catch (error) {
                this.logger.error(`❌ Lỗi gửi ảnh đến group ảo ${i + 1}:`, error);
            }
        }
    }
    async forwardMessageToGroupAo(link, delay = 500) {
        const groupIds = this.getGroupAoIds();
        for (let i = 0; i < groupIds.length; i++) {
            try {
                await this.telegramService.forwardMessageFromLink(link, groupIds[i]);
                this.logger.log(`✅ Đã forward message đến group ảo ${i + 1}/${groupIds.length}`);
                if (i < groupIds.length - 1) {
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
            catch (error) {
                this.logger.error(`❌ Lỗi forward message đến group ảo ${i + 1}:`, error);
            }
        }
    }
    async findBaccaratActive(page) {
        try {
            this.logger.log(`📄 Bắt đầu findBaccaratActive với URL: ${page.url()}`);
            await new Promise((resolve) => setTimeout(resolve, 10000));
            this.logger.log('🔍 Đang tìm các bàn Baccarat đang hoạt động...');
            try {
                await page.waitForFunction(() => document.readyState === 'complete', {
                    timeout: 10000,
                });
                this.logger.log('✅ Page readyState = complete');
            }
            catch {
                this.logger.log('⏳ Đợi thêm 5 giây...');
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
            this.logger.log('⏳ Đang đợi iframe xuất hiện (có thể load động)...');
            let iframe = null;
            const maxWaitTime = 60000;
            const checkInterval = 2000;
            const maxAttempts = maxWaitTime / checkInterval;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const allIframes = await page.$$('iframe');
                if (allIframes.length > 0) {
                    for (let i = 0; i < allIframes.length; i++) {
                        try {
                            await Promise.all([
                                page.evaluate((el) => el.id, allIframes[i]),
                                page.evaluate((el) => el.src, allIframes[i]),
                            ]);
                        }
                        catch (e) {
                            continue;
                        }
                    }
                    const selectors = [
                        '#iframeGameHall',
                        'iframe#iframeGameHall',
                        'iframe[id="iframeGameHall"]',
                    ];
                    for (const selector of selectors) {
                        try {
                            const found = await page.$(selector);
                            if (found) {
                                iframe = found;
                                this.logger.log(`✅ Tìm thấy iframe với selector: ${selector}`);
                                break;
                            }
                        }
                        catch (error) {
                            continue;
                        }
                    }
                    if (!iframe && allIframes.length > 0) {
                        this.logger.log('⚠️ Không tìm thấy #iframeGameHall, thử dùng iframe đầu tiên...');
                        iframe =
                            allIframes[0];
                    }
                    if (iframe) {
                        break;
                    }
                }
                if (!iframe && attempt < maxAttempts - 1) {
                    this.logger.log(`⏳ Chưa tìm thấy iframe, đợi thêm ${checkInterval / 1000} giây...`);
                    await new Promise((resolve) => setTimeout(resolve, checkInterval));
                }
            }
            if (!iframe) {
                const pageContent = await page.content();
                const pageTitle = await page.title();
                this.logger.error(`❌ URL page: ${page.url()}`);
                this.logger.error(`❌ Title page: ${pageTitle}`);
                this.logger.error(`❌ Page content length: ${pageContent.length} characters`);
                throw new Error('Không tìm thấy iframe iframeGameHall sau 60 giây.');
            }
            const frame = await iframe.contentFrame();
            if (!frame) {
                throw new Error('Không thể truy cập vào iframe');
            }
            const baccaratElements = await frame.evaluate(() => {
                const spans = document.querySelectorAll('span');
                const baccaratSpans = Array.from(spans).filter((span) => span.textContent &&
                    span.textContent.toLowerCase().includes('baccarat'));
                return baccaratSpans.slice(0, 5).map((span, index) => ({
                    index: index + 1,
                    text: span.textContent?.trim() || '',
                    element: span,
                }));
            });
            if (baccaratElements.length === 0) {
                throw new Error('Không tìm thấy bàn baccarat nào');
            }
            const randomIndex = Math.floor(Math.random() * Math.min(5, baccaratElements.length));
            const selectedTable = baccaratElements[randomIndex];
            this.logger.log(`🎯 Đã chọn bàn: ${selectedTable.text}`);
            this.selectedTableName = selectedTable.text;
            await frame.evaluate((index) => {
                const spans = document.querySelectorAll('span');
                const baccaratSpans = Array.from(spans).filter((span) => span.textContent &&
                    span.textContent.toLowerCase().includes('baccarat'));
                if (baccaratSpans[index]) {
                    baccaratSpans[index].click();
                }
            }, randomIndex);
            this.logger.log('⏳ Đợi 15 giây để hoàn thành tải dữ liệu bàn...');
            await new Promise((resolve) => setTimeout(resolve, 45000));
            this.logger.log('📤 Đang gửi tin nhắn Telegram...');
            try {
                if (telegram_config_1.telegramConfig.link_forward_tin_nhan_vao_sanh) {
                    const tasks = [];
                    tasks.push(this.forwardMessageToGroupAo(telegram_config_1.telegramConfig.link_forward_tin_nhan_vao_sanh).catch((err) => {
                        this.logger.log(`⚠️ Lỗi gửi Telegram vào sảnh (ảo) - Bỏ qua: ${err}`);
                    }));
                    if (this.shouldSendToNhomThat()) {
                        tasks.push(this.telegramService
                            .forwardMessageFromLink(telegram_config_1.telegramConfig.link_forward_tin_nhan_vao_sanh, telegram_config_1.telegramConfig.gui_tin_nhan_vao_group_that)
                            .catch((err) => {
                            this.logger.log(`⚠️ Lỗi gửi Telegram vào sảnh (thật) - Bỏ qua: ${err}`);
                        }));
                    }
                    else {
                        this.logger.log('⏭️ Bỏ gửi nhóm thật (chi_gui_nhom_ao=true)');
                    }
                    await Promise.all(tasks);
                }
            }
            catch (err) {
                this.logger.log(`⚠️ Lỗi gửi Telegram vào sảnh - Bỏ qua: ${err}`);
            }
            try {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const tableScreenshotPath = `screenshots-table/${timestamp}.png`;
                if (!fs.existsSync('screenshots-table')) {
                    fs.mkdirSync('screenshots-table', { recursive: true });
                }
                this.logger.log('🔧 Set viewport cho chụp bàn...');
                const CAPTURE_WIDTH = 1600;
                const CAPTURE_HEIGHT = 900;
                await page.setViewport({
                    width: CAPTURE_WIDTH,
                    height: CAPTURE_HEIGHT,
                    deviceScaleFactor: 1,
                });
                await new Promise((resolve) => setTimeout(resolve, 500));
                await page.evaluate((w, h) => {
                    const iframe = document.querySelector('iframe');
                    if (iframe) {
                        iframe.style.width = `${w}px`;
                        iframe.style.height = `${h}px`;
                        iframe.style.position = 'fixed';
                        iframe.style.top = '0';
                        iframe.style.left = '0';
                    }
                }, CAPTURE_WIDTH, CAPTURE_HEIGHT);
                await new Promise((resolve) => setTimeout(resolve, 300));
                await frame.evaluate(() => {
                    window.scrollTo(0, 0);
                    document.body.style.zoom = '1';
                    document.body.style.transform = 'scale(1)';
                });
                await new Promise((resolve) => setTimeout(resolve, 500));
                const tableBox = await frame.evaluate(() => {
                    const gameContainer = document.querySelector('#game-container') ||
                        document.querySelector('.game-container') ||
                        document.querySelector('body > div:first-child') ||
                        document.body;
                    const rect = gameContainer.getBoundingClientRect();
                    return {
                        x: Math.max(0, rect.left),
                        y: Math.max(0, rect.top),
                        width: rect.width,
                        height: rect.height,
                    };
                });
                const dpr = await frame.evaluate(() => window.devicePixelRatio || 1);
                const tableClipW = Math.floor(tableBox.width * dpr);
                const tableClipH = Math.floor(tableBox.height * dpr);
                this.logger.log(`📐 Chụp bàn: x=${tableBox.x}, y=${tableBox.y}, w=${tableBox.width}, h=${tableBox.height}, dpr=${dpr}`);
                if (tableClipW <= 0 || tableClipH <= 0) {
                    this.logger.log('⚠️ Kích thước bàn không hợp lệ (<=0), chụp toàn bộ iframe');
                    await iframe.screenshot({
                        path: tableScreenshotPath,
                        type: 'png',
                    });
                }
                else {
                    await iframe.screenshot({
                        path: tableScreenshotPath,
                        type: 'png',
                        clip: {
                            x: Math.floor(tableBox.x * dpr),
                            y: Math.floor(tableBox.y * dpr),
                            width: tableClipW,
                            height: tableClipH,
                        },
                    });
                }
                try {
                    if (fs.existsSync(tableScreenshotPath)) {
                        const croppedImagePath = tableScreenshotPath.replace('.png', '_cropped.png');
                        const imageInfo = await (0, sharp_1.default)(tableScreenshotPath).metadata();
                        const originalHeight = imageInfo.height || 0;
                        await (0, sharp_1.default)(tableScreenshotPath)
                            .extract({
                            left: 0,
                            top: 75,
                            width: imageInfo.width || 0,
                            height: originalHeight - 75,
                        })
                            .png()
                            .toFile(croppedImagePath);
                        const tableCaption = `BÀN ${selectedTable.text.toUpperCase()}`;
                        let sendSuccess = false;
                        try {
                            if (this.shouldSendToNhomThat()) {
                                await this.telegramService
                                    .sendPhoto(telegram_config_1.telegramConfig.gui_tin_nhan_vao_group_that, croppedImagePath, tableCaption)
                                    .then(() => {
                                    sendSuccess = true;
                                    this.logger.log('✅ Đã gửi ảnh bàn cho group thật');
                                })
                                    .catch((err) => {
                                    this.logger.log(`⚠️ Lỗi gửi ảnh bàn (thật) - Bỏ qua: ${err}`);
                                });
                            }
                            else {
                                this.logger.log('⏭️ Bỏ gửi ảnh bàn nhóm thật (chi_gui_nhom_ao=true)');
                            }
                            this.logger.log(`📤 Đã gửi ảnh qua Telegram: ${sendSuccess}`);
                        }
                        catch (telegramError) {
                            this.logger.log(`⚠️ Lỗi gửi ảnh - Tiếp tục: ${telegramError}`);
                        }
                        if (sendSuccess) {
                            try {
                                if (fs.existsSync(tableScreenshotPath)) {
                                    fs.unlinkSync(tableScreenshotPath);
                                }
                                if (fs.existsSync(croppedImagePath)) {
                                    fs.unlinkSync(croppedImagePath);
                                }
                                this.logger.log('🗑️ Đã xóa ảnh bàn sau khi gửi thành công');
                            }
                            catch (deleteError) {
                                this.logger.error('❌ Lỗi xóa ảnh bàn:', deleteError);
                            }
                        }
                        this.logger.log('📤 Đang gửi tin nhắn vào sảnh...');
                        try {
                            const baoBanLink = String(telegram_config_1.telegramConfig.link_forward_tin_nhan_bao_ban ?? '').trim();
                            if (baoBanLink) {
                                await this.forwardMessageToGroupAo(baoBanLink).catch((err) => {
                                    this.logger.log(`⚠️ Lỗi forward báo bàn (ảo) - Bỏ qua: ${err}`);
                                });
                            }
                            if (telegram_config_1.telegramConfig.link_forward_tin_nhan_cho_lenh) {
                                const tasks = [];
                                tasks.push(this.forwardMessageToGroupAo(telegram_config_1.telegramConfig.link_forward_tin_nhan_cho_lenh).catch((err) => {
                                    this.logger.log(`⚠️ Lỗi gửi Telegram vào cho lenh (ảo) - Bỏ qua: ${err}`);
                                }));
                                if (this.shouldSendToNhomThat()) {
                                    tasks.push(this.telegramService
                                        .forwardMessageFromLink(telegram_config_1.telegramConfig.link_forward_tin_nhan_cho_lenh, telegram_config_1.telegramConfig.gui_tin_nhan_vao_group_that)
                                        .catch((err) => {
                                        this.logger.log(`⚠️ Lỗi gửi Telegram vào cho lenh (thật) - Bỏ qua: ${err}`);
                                    }));
                                }
                                else {
                                    this.logger.log('⏭️ Bỏ gửi tin chờ lệnh nhóm thật (chi_gui_nhom_ao=true)');
                                }
                                await Promise.all(tasks);
                            }
                        }
                        catch (telegramError) {
                            this.logger.log('⚠️ Lỗi gửi tin nhắn vào sảnh - Tiếp tục chạy:');
                        }
                    }
                }
                catch (deleteError) {
                    this.logger.error('❌ Lỗi xử lý ảnh bàn:', deleteError);
                }
            }
            catch (screenshotError) {
                this.logger.error('❌ Lỗi khi chụp ảnh bàn:', screenshotError);
            }
            this.logger.log('✅ findBaccaratActive hoàn thành (bỏ qua lỗi Telegram nếu có)');
        }
        catch (error) {
            this.logger.error('❌ Lỗi khi chọn bàn baccarat:', error);
            throw error;
        }
    }
    async waitForGameResult_that(page) {
        try {
            await new Promise((resolve) => setTimeout(resolve, 10000));
            this.logger.log('🎮 Bắt đầu theo dõi kết quả...');
            const iframe = await page.waitForSelector('#iframeGame', {
                timeout: 30000,
            });
            if (!iframe) {
                throw new Error('Không tìm thấy iframe iframeGame');
            }
            const frame = await iframe.contentFrame();
            if (!frame) {
                throw new Error('Không thể truy cập vào iframe');
            }
            let hasFirstResult = false;
            let prediction = '';
            let lastResult = '';
            while (true) {
                try {
                    const currentResult = await frame.evaluate(() => {
                        const gameWinnerPlayer = document.querySelector('#gameWinnerPlayer');
                        const gameWinnerBanker = document.querySelector('#gameWinnerBanker');
                        if (!gameWinnerBanker || !gameWinnerPlayer) {
                            throw new Error('Chưa vào được bàn Baccarat');
                        }
                        if (gameWinnerPlayer &&
                            gameWinnerPlayer.classList.contains('result_win_blue')) {
                            const playerHandValue = document.querySelector('#playerHandValue')?.textContent || '0';
                            const bankerHandValue = document.querySelector('#bankerHandValue')?.textContent || '0';
                            return {
                                hasResult: true,
                                playerValue: playerHandValue,
                                bankerValue: bankerHandValue,
                                winner: 'Tay Con',
                            };
                        }
                        if (gameWinnerBanker &&
                            gameWinnerBanker.classList.contains('result_win_red')) {
                            const playerHandValue = document.querySelector('#playerHandValue')?.textContent || '0';
                            const bankerHandValue = document.querySelector('#bankerHandValue')?.textContent || '0';
                            return {
                                hasResult: true,
                                playerValue: playerHandValue,
                                bankerValue: bankerHandValue,
                                winner: 'Nhà Cái',
                            };
                        }
                        if (gameWinnerBanker &&
                            gameWinnerBanker.classList.contains('result_tie_green')) {
                            const playerHandValue = document.querySelector('#playerHandValue')?.textContent || '0';
                            const bankerHandValue = document.querySelector('#bankerHandValue')?.textContent || '0';
                            return {
                                hasResult: true,
                                playerValue: playerHandValue,
                                bankerValue: bankerHandValue,
                                winner: 'Hòa',
                            };
                        }
                        return { hasResult: false };
                    });
                    if (currentResult.hasResult && !hasFirstResult) {
                        hasFirstResult = true;
                        lastResult = `${currentResult.winner}_${currentResult.playerValue}_${currentResult.bankerValue}`;
                        await new Promise((resolve) => setTimeout(resolve, 2000));
                        const randomValue = Math.random();
                        if (randomValue <= 0.493) {
                            prediction = 'TAY CON';
                        }
                        else {
                            prediction = 'NHÀ CÁI';
                        }
                        if (this.shouldSendToNhomThat()) {
                            const link = this.getPredictionLink(prediction);
                            if (link) {
                                await this.telegramService.forwardMessageFromLink(link, telegram_config_1.telegramConfig.gui_tin_nhan_vao_group_that);
                            }
                            else {
                                this.logger.log('⏭️ Thiếu link dự đoán, bỏ gửi nhóm thật');
                            }
                        }
                        else {
                            this.logger.log('⏭️ Bỏ gửi dự đoán nhóm thật (chi_gui_nhom_ao=true)');
                        }
                    }
                    else if (currentResult.hasResult && hasFirstResult) {
                        const currentResultString = `${currentResult.winner}_${currentResult.playerValue}_${currentResult.bankerValue}`;
                        if (currentResultString !== lastResult) {
                            lastResult = currentResultString;
                            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                            const resultImagePath = `screenshots-result/that_${timestamp}.png`;
                            try {
                                if (!fs.existsSync('screenshots-result')) {
                                    fs.mkdirSync('screenshots-result', { recursive: true });
                                }
                                const isDrawResult = currentResult.winner?.toUpperCase() === 'HÒA';
                                let isWin = false;
                                if (isDrawResult) {
                                    isWin = false;
                                }
                                else {
                                    isWin =
                                        prediction.toLowerCase() ===
                                            currentResult.winner?.toLowerCase();
                                }
                                const amountText = this.calculateAmount(isDrawResult, isWin, currentResult.winner);
                                const RESULT_WIDTH = 1600;
                                const RESULT_HEIGHT = 900;
                                await page.setViewport({
                                    width: RESULT_WIDTH,
                                    height: RESULT_HEIGHT,
                                    deviceScaleFactor: 1,
                                });
                                await page.evaluate((w, h) => {
                                    const iframe = document.querySelector('iframe');
                                    if (iframe) {
                                        iframe.style.width = `${w}px`;
                                        iframe.style.height = `${h}px`;
                                        iframe.style.position = 'fixed';
                                        iframe.style.top = '0';
                                        iframe.style.left = '0';
                                    }
                                }, RESULT_WIDTH, RESULT_HEIGHT);
                                await frame.evaluate(() => {
                                    window.scrollTo(0, 0);
                                    document.body.style.zoom = '1';
                                    document.body.style.transform = 'scale(1)';
                                });
                                await new Promise((resolve) => setTimeout(resolve, 500));
                                const canvasBox = await frame.evaluate(() => {
                                    const canvas = document.querySelector('#canvasElement');
                                    if (!canvas) {
                                        return null;
                                    }
                                    const rect = canvas.getBoundingClientRect();
                                    return {
                                        x: Math.max(0, rect.left),
                                        y: Math.max(0, rect.top),
                                        width: rect.width,
                                        height: rect.height,
                                    };
                                });
                                this.screenshotLock = this.screenshotLock.then(async () => {
                                    await this.replaceGameMessage(frame, isWin || isDrawResult, amountText);
                                    await frame.evaluate(() => {
                                        void document.body.offsetHeight;
                                        return new Promise((resolve) => {
                                            requestAnimationFrame(() => resolve());
                                        });
                                    });
                                    await new Promise((resolve) => setTimeout(resolve, 200));
                                    if (!canvasBox) {
                                        this.logger.log('⚠️ Không tìm thấy canvasElement, chụp toàn bộ iframe');
                                        await iframe.screenshot({
                                            path: resultImagePath,
                                            type: 'png',
                                        });
                                    }
                                    else {
                                        const dpr = await frame.evaluate(() => window.devicePixelRatio || 1);
                                        const clipW = Math.floor(canvasBox.width * dpr);
                                        const clipH = Math.floor(canvasBox.height * dpr);
                                        this.logger.log(`📐 Chụp canvas: x=${canvasBox.x}, y=${canvasBox.y}, w=${canvasBox.width}, h=${canvasBox.height}, dpr=${dpr}`);
                                        if (clipW <= 0 || clipH <= 0) {
                                            this.logger.log('⚠️ Kích thước canvas không hợp lệ (<=0), chụp toàn bộ iframe');
                                            await iframe.screenshot({
                                                path: resultImagePath,
                                                type: 'png',
                                            });
                                        }
                                        else {
                                            await iframe.screenshot({
                                                path: resultImagePath,
                                                type: 'png',
                                                clip: {
                                                    x: Math.floor(canvasBox.x * dpr),
                                                    y: Math.floor(canvasBox.y * dpr),
                                                    width: clipW,
                                                    height: clipH,
                                                },
                                            });
                                        }
                                    }
                                });
                                await this.screenshotLock;
                                try {
                                    const resultLink = this.getResultLink(isDrawResult, isWin);
                                    await new Promise((resolve) => setTimeout(resolve, 2000));
                                    if (this.shouldSendToNhomThat()) {
                                        await this.telegramService.sendPhoto(telegram_config_1.telegramConfig.gui_tin_nhan_vao_group_that, resultImagePath);
                                        if (resultLink) {
                                            await this.telegramService.forwardMessageFromLink(resultLink, telegram_config_1.telegramConfig.gui_tin_nhan_vao_group_that);
                                        }
                                        this.logger.log('📤 Đã gửi ảnh kết quả qua Telegram');
                                    }
                                    else {
                                        this.logger.log('⏭️ Bỏ gửi ảnh kết quả nhóm thật (chi_gui_nhom_ao=true)');
                                    }
                                    let gameResult = 'HOA';
                                    if (isDrawResult) {
                                        gameResult = 'HOA';
                                    }
                                    else {
                                        gameResult = isWin ? 'WIN' : 'LOSE';
                                    }
                                    this.lastRunProfit = isDrawResult
                                        ? 0
                                        : isWin
                                            ? this.calculateWinAmount(currentResult.winner)
                                            : -this.getBetAmount();
                                    try {
                                        if (fs.existsSync(resultImagePath)) {
                                            fs.unlinkSync(resultImagePath);
                                        }
                                        this.logger.log('🗑️ Đã xóa ảnh kết quả sau khi gửi thành công');
                                    }
                                    catch (deleteError) {
                                        this.logger.error('❌ Lỗi xóa ảnh kết quả:', deleteError);
                                    }
                                    return gameResult;
                                }
                                catch (telegramError) {
                                    this.logger.error('❌ Lỗi gửi Telegram:', telegramError);
                                    try {
                                        if (fs.existsSync(resultImagePath)) {
                                            fs.unlinkSync(resultImagePath);
                                        }
                                    }
                                    catch (deleteError) {
                                    }
                                    return 'LOSE';
                                }
                            }
                            catch (screenshotError) {
                                this.logger.error('❌ Lỗi khi chụp ảnh:', screenshotError);
                                try {
                                    if (resultImagePath && fs.existsSync(resultImagePath)) {
                                        fs.unlinkSync(resultImagePath);
                                    }
                                }
                                catch (deleteError) {
                                }
                                return 'LOSE';
                            }
                            return 'LOSE';
                        }
                    }
                }
                catch (error) {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
            }
            return 'LOSE';
        }
        catch (error) {
            this.logger.error('❌ Lỗi khi lắng nghe kết quả game:', error);
            try {
                await this.closeBrowser();
            }
            catch (closeError) {
                this.logger.error('❌ Lỗi khi đóng browser:', closeError);
            }
            return 'LOSE';
        }
    }
    async waitForGameResult_ao(page) {
        try {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            this.logger.log('🎮 Bắt đầu theo dõi kết quả (group ảo)...');
            const iframe = await page.waitForSelector('#iframeGame', {
                timeout: 30000,
            });
            if (!iframe) {
                throw new Error('Không tìm thấy iframe iframeGame');
            }
            const frame = await iframe.contentFrame();
            if (!frame) {
                throw new Error('Không thể truy cập vào iframe');
            }
            let hasFirstResult = false;
            let lastResult = '';
            while (true) {
                try {
                    const currentResult = await frame.evaluate(() => {
                        const gameWinnerPlayer = document.querySelector('#gameWinnerPlayer');
                        const gameWinnerBanker = document.querySelector('#gameWinnerBanker');
                        if (!gameWinnerBanker || !gameWinnerPlayer) {
                            throw new Error('Chưa vào được bàn Baccarat');
                        }
                        if (gameWinnerPlayer &&
                            gameWinnerPlayer.classList.contains('result_win_blue')) {
                            const playerHandValue = document.querySelector('#playerHandValue')?.textContent || '0';
                            const bankerHandValue = document.querySelector('#bankerHandValue')?.textContent || '0';
                            return {
                                hasResult: true,
                                playerValue: playerHandValue,
                                bankerValue: bankerHandValue,
                                winner: 'Tay Con',
                            };
                        }
                        if (gameWinnerBanker &&
                            gameWinnerBanker.classList.contains('result_win_red')) {
                            const playerHandValue = document.querySelector('#playerHandValue')?.textContent || '0';
                            const bankerHandValue = document.querySelector('#bankerHandValue')?.textContent || '0';
                            return {
                                hasResult: true,
                                playerValue: playerHandValue,
                                bankerValue: bankerHandValue,
                                winner: 'Nhà Cái',
                            };
                        }
                        if (gameWinnerBanker &&
                            gameWinnerBanker.classList.contains('result_tie_green')) {
                            const playerHandValue = document.querySelector('#playerHandValue')?.textContent || '0';
                            const bankerHandValue = document.querySelector('#bankerHandValue')?.textContent || '0';
                            return {
                                hasResult: true,
                                playerValue: playerHandValue,
                                bankerValue: bankerHandValue,
                                winner: 'Hòa',
                            };
                        }
                        return { hasResult: false };
                    });
                    if (currentResult.hasResult && !hasFirstResult) {
                        hasFirstResult = true;
                        lastResult = `${currentResult.winner}_${currentResult.playerValue}_${currentResult.bankerValue}`;
                        await new Promise((resolve) => setTimeout(resolve, 2000));
                    }
                    else if (currentResult.hasResult && hasFirstResult) {
                        const currentResultString = `${currentResult.winner}_${currentResult.playerValue}_${currentResult.bankerValue}`;
                        if (currentResultString !== lastResult) {
                            lastResult = currentResultString;
                            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                            const resultImagePath = `screenshots-result/ao_${timestamp}.png`;
                            let isDrawResult = false;
                            let isWin = false;
                            try {
                                if (!fs.existsSync('screenshots-result')) {
                                    fs.mkdirSync('screenshots-result', { recursive: true });
                                }
                                isDrawResult =
                                    currentResult.winner?.toUpperCase() === 'HÒA';
                                let prediction = '';
                                isWin = false;
                                if (isDrawResult) {
                                    this.logger.log('🤝 Group ảo: Kết quả HÒA - không thắng không thua');
                                    prediction = Math.random() < 0.5 ? 'NHÀ CÁI' : 'TAY CON';
                                    isWin = false;
                                }
                                else {
                                    this.logger.log('🎲 Group ảo: Tính toán prediction (tỉ lệ win 85%)...');
                                    const randomValue = Math.random();
                                    const shouldWin = randomValue < 0.85;
                                    if (shouldWin) {
                                        if (currentResult.winner?.toUpperCase() === 'NHÀ CÁI') {
                                            prediction = 'NHÀ CÁI';
                                        }
                                        else {
                                            prediction = 'TAY CON';
                                        }
                                        this.logger.log('✅ Group ảo: Sẽ dự đoán đúng (85%)');
                                    }
                                    else {
                                        if (currentResult.winner?.toUpperCase() === 'NHÀ CÁI') {
                                            prediction = 'TAY CON';
                                        }
                                        else {
                                            prediction = 'NHÀ CÁI';
                                        }
                                        this.logger.log('❌ Group ảo: Sẽ dự đoán sai (15%)');
                                    }
                                    isWin =
                                        prediction.toUpperCase() ===
                                            currentResult.winner?.toUpperCase();
                                }
                                const amountText = this.calculateAmount(isDrawResult, isWin, currentResult.winner, true);
                                this.logger.log(`🎯 Group ảo: prediction="${prediction}", #gameMessage ${isDrawResult ? 'HÒA' : isWin ? 'WIN' : 'LOSE'} ${amountText}`);
                                this.lastRunProfit_ao = isDrawResult
                                    ? 0
                                    : isWin
                                        ? this.calculateWinAmount(currentResult.winner, true)
                                        : -this.getBetAmount(true);
                                this.lastGameResult_ao = isDrawResult
                                    ? 'HOA'
                                    : isWin
                                        ? 'WIN'
                                        : 'LOSE';
                                this.logger.log('📸 Group ảo: Chụp ảnh kết quả trước...');
                                const RESULT_WIDTH = 1600;
                                const RESULT_HEIGHT = 900;
                                await page.setViewport({
                                    width: RESULT_WIDTH,
                                    height: RESULT_HEIGHT,
                                    deviceScaleFactor: 1,
                                });
                                await page.evaluate((w, h) => {
                                    const iframe = document.querySelector('iframe');
                                    if (iframe) {
                                        iframe.style.width = `${w}px`;
                                        iframe.style.height = `${h}px`;
                                        iframe.style.position = 'fixed';
                                        iframe.style.top = '0';
                                        iframe.style.left = '0';
                                    }
                                }, RESULT_WIDTH, RESULT_HEIGHT);
                                await frame.evaluate(() => {
                                    window.scrollTo(0, 0);
                                    document.body.style.zoom = '1';
                                    document.body.style.transform = 'scale(1)';
                                });
                                await new Promise((resolve) => setTimeout(resolve, 500));
                                const canvasBox = await frame.evaluate(() => {
                                    const canvas = document.querySelector('#canvasElement');
                                    if (!canvas) {
                                        return null;
                                    }
                                    const rect = canvas.getBoundingClientRect();
                                    return {
                                        x: Math.max(0, rect.left),
                                        y: Math.max(0, rect.top),
                                        width: rect.width,
                                        height: rect.height,
                                    };
                                });
                                this.screenshotLock = this.screenshotLock.then(async () => {
                                    await this.replaceGameMessage(frame, isWin || isDrawResult, amountText);
                                    await frame.evaluate(() => {
                                        void document.body.offsetHeight;
                                        return new Promise((resolve) => {
                                            requestAnimationFrame(() => resolve());
                                        });
                                    });
                                    await new Promise((resolve) => setTimeout(resolve, 200));
                                    if (!canvasBox) {
                                        this.logger.log('⚠️ Không tìm thấy canvasElement, chụp toàn bộ iframe');
                                        await iframe.screenshot({
                                            path: resultImagePath,
                                            type: 'png',
                                        });
                                    }
                                    else {
                                        const dpr = await frame.evaluate(() => window.devicePixelRatio || 1);
                                        const clipW = Math.floor(canvasBox.width * dpr);
                                        const clipH = Math.floor(canvasBox.height * dpr);
                                        this.logger.log(`📐 Chụp canvas (ảo): x=${canvasBox.x}, y=${canvasBox.y}, w=${canvasBox.width}, h=${canvasBox.height}, dpr=${dpr}`);
                                        if (clipW <= 0 || clipH <= 0) {
                                            this.logger.log('⚠️ Kích thước canvas không hợp lệ (<=0), chụp toàn bộ iframe');
                                            await iframe.screenshot({
                                                path: resultImagePath,
                                                type: 'png',
                                            });
                                        }
                                        else {
                                            await iframe.screenshot({
                                                path: resultImagePath,
                                                type: 'png',
                                                clip: {
                                                    x: Math.floor(canvasBox.x * dpr),
                                                    y: Math.floor(canvasBox.y * dpr),
                                                    width: clipW,
                                                    height: clipH,
                                                },
                                            });
                                        }
                                    }
                                });
                                await this.screenshotLock;
                                this.logger.log('🎭 Group ảo: Gửi tin nhắn dự đoán...');
                                let aoPrediction = prediction.toUpperCase();
                                if (!aoPrediction.includes('CÁI') && !aoPrediction.includes('CON')) {
                                    aoPrediction = Math.random() < 0.5 ? 'CÁI' : 'CON';
                                    this.logger.log(`⚠️ Group ảo: Prediction không rõ ràng (${prediction}), dùng fallback`);
                                }
                                try {
                                    const link = this.getPredictionLink(aoPrediction);
                                    if (link) {
                                        await this.forwardMessageToGroupAo(link);
                                        this.logger.log('✅ Group ảo: Đã gửi tin nhắn dự đoán');
                                    }
                                    else {
                                        this.logger.log('⏭️ Group ảo: Thiếu link dự đoán, bỏ gửi');
                                    }
                                }
                                catch (predictionError) {
                                    this.logger.error('❌ Lỗi gửi dự đoán (ảo):', predictionError);
                                }
                                this.logger.log('⏳ Group ảo: Đợi 15 giây trước khi gửi kết quả...');
                                await new Promise((resolve) => setTimeout(resolve, 15000));
                                const resultLink = this.getResultLink(isDrawResult, isWin);
                                try {
                                    await this.sendPhotoToGroupAo(resultImagePath);
                                    if (resultLink) {
                                        await this.forwardMessageToGroupAo(resultLink);
                                    }
                                    else {
                                        this.logger.log('⏭️ Group ảo: Thiếu link kết quả, bỏ gửi');
                                    }
                                    this.logger.log('📤 Group ảo: Đã gửi ảnh kết quả (sau 20s)');
                                    try {
                                        if (fs.existsSync(resultImagePath)) {
                                            fs.unlinkSync(resultImagePath);
                                        }
                                        this.logger.log('🗑️ Đã xóa ảnh kết quả sau khi gửi thành công');
                                    }
                                    catch (deleteError) {
                                        this.logger.error('❌ Lỗi xóa ảnh kết quả:', deleteError);
                                    }
                                }
                                catch (telegramError) {
                                    this.logger.error('❌ Lỗi gửi Telegram:', telegramError);
                                    try {
                                        if (fs.existsSync(resultImagePath)) {
                                            fs.unlinkSync(resultImagePath);
                                        }
                                    }
                                    catch (deleteError) {
                                    }
                                }
                            }
                            catch (screenshotError) {
                                this.logger.error('❌ Lỗi khi chụp ảnh:', screenshotError);
                                try {
                                    if (resultImagePath && fs.existsSync(resultImagePath)) {
                                        fs.unlinkSync(resultImagePath);
                                    }
                                }
                                catch (deleteError) {
                                }
                            }
                            if (isDrawResult)
                                return 'HOA';
                            return isWin ? 'WIN' : 'LOSE';
                        }
                    }
                }
                catch (error) {
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }
            }
        }
        catch (error) {
            this.logger.error('❌ Lỗi khi lắng nghe kết quả game (group ảo):', error);
            try {
                await this.closeBrowser();
            }
            catch (closeError) {
                this.logger.error('❌ Lỗi khi đóng browser:', closeError);
            }
            throw error;
        }
    }
    getLastRunProfit() {
        return this.lastRunProfit;
    }
    getLastGameResult_that() {
        return this.lastGameResult_that;
    }
    getLastRunProfit_ao() {
        return this.lastRunProfit_ao;
    }
    getLastGameResult_ao() {
        return this.lastGameResult_ao;
    }
    async runBaccaratAuto() {
        try {
            this.logger.log('🎯 Bắt đầu chạy Baccarat auto...');
            this.lastRunProfit = 0;
            this.lastGameResult_that = null;
            this.lastRunProfit_ao = 0;
            this.lastGameResult_ao = null;
            this.currentSessionCa = null;
            await this.closeBrowser();
            this.logger.log('✅ STEP 1: Đã đóng browser cũ');
            const page = await this.openPage(telegram_config_1.telegramConfig.url_site);
            this.logger.log('✅ STEP 2: Đã mở page');
            await this.login(page, telegram_config_1.telegramConfig.username_site, telegram_config_1.telegramConfig.password_site);
            this.logger.log('✅ STEP 3: Đã đăng nhập xong - Chuẩn bị tìm SEXYBCRT');
            this.logger.log('⏳ STEP 4: Đợi 2 giây trước khi tìm SEXYBCRT...');
            await new Promise((resolve) => setTimeout(resolve, 2000));
            this.logger.log('🔍 STEP 5: Bắt đầu gọi navigateToSexyBaccarat()...');
            const newPage = await this.navigateToSexyBaccarat(page);
            this.logger.log(`✅ STEP 6: Đã lấy được page mới: ${newPage.url()}`);
            await this.waitForGameIframeReady(newPage);
            this.logger.log('✅ STEP 6.5: Đã thấy iframe game, bắt đầu gửi tin');
            this.logger.log('📤 STEP 7: Gửi tin nhắn bắt đầu...');
            try {
                if (telegram_config_1.telegramConfig.link_forward_tin_nhan_bat_dau) {
                    const tasks = [];
                    tasks.push(this.forwardMessageToGroupAo(telegram_config_1.telegramConfig.link_forward_tin_nhan_bat_dau_ao).catch((err) => {
                        this.logger.log(`⚠️ Lỗi gửi Telegram bắt đầu (group ảo) - Bỏ qua: ${err}`);
                    }));
                    if (this.shouldSendToNhomThat()) {
                        tasks.push(this.telegramService
                            .forwardMessageFromLink(telegram_config_1.telegramConfig.link_forward_tin_nhan_bat_dau, telegram_config_1.telegramConfig.gui_tin_nhan_vao_group_that)
                            .catch((err) => {
                            this.logger.log(`⚠️ Lỗi gửi Telegram bắt đầu (group thật) - Bỏ qua: ${err}`);
                        }));
                    }
                    else {
                        this.logger.log('⏭️ Bỏ gửi tin bắt đầu nhóm thật (chi_gui_nhom_ao=true)');
                    }
                    await Promise.all(tasks);
                }
                const cfg = telegram_config_1.telegramConfig;
                const soCaCfg = Math.max(0, Math.floor(Number(cfg.so_ca) || 0));
                const lenCaLinks = cfg.link_forward_tin_nhan_len_ca;
                if (soCaCfg > 0 &&
                    Array.isArray(lenCaLinks) &&
                    lenCaLinks.length > 0) {
                    const effectiveSoCa = Math.min(soCaCfg, lenCaLinks.length);
                    if (effectiveSoCa < soCaCfg) {
                        this.logger.log(`⚠️ link_forward_tin_nhan_len_ca chỉ có ${lenCaLinks.length} phần tử — dùng tối đa ${effectiveSoCa} ca`);
                    }
                    const overrideCa = (0, session_ca_util_1.readSessionCaOverrideFromConfigFile)();
                    const sessionCa = overrideCa > 0
                        ? Math.min(Math.max(1, overrideCa), effectiveSoCa)
                        : (0, session_ca_util_1.getSessionCa)(effectiveSoCa);
                    this.currentSessionCa = sessionCa;
                    if (overrideCa > 0) {
                        this.logger.log(`📌 session_ca_override=${overrideCa} (từ config.json) → ca ${sessionCa}/${effectiveSoCa}; sau OK về 0`);
                    }
                    const linkRaw = lenCaLinks[sessionCa - 1];
                    const linkLen = typeof linkRaw === 'string' ? linkRaw.trim() : String(linkRaw ?? '').trim();
                    if (linkLen) {
                        this.logger.log(`📤 Forward tin lệnh ca ${sessionCa}/${effectiveSoCa} (index ${sessionCa - 1})...`);
                        const tasks = [];
                        tasks.push(this.forwardMessageToGroupAo(linkLen).catch((err) => {
                            this.logger.log(`⚠️ Lỗi forward lệnh ca (group ảo) - Bỏ qua: ${err}`);
                        }));
                        if (this.shouldSendToNhomThat()) {
                            tasks.push(this.telegramService
                                .forwardMessageFromLink(linkLen, telegram_config_1.telegramConfig.gui_tin_nhan_vao_group_that)
                                .catch((err) => {
                                this.logger.log(`⚠️ Lỗi forward lệnh ca (group thật) - Bỏ qua: ${err}`);
                            }));
                        }
                        else {
                            this.logger.log('⏭️ Bỏ forward lệnh ca nhóm thật (chi_gui_nhom_ao=true)');
                        }
                        await Promise.all(tasks);
                        if (overrideCa > 0) {
                            (0, session_ca_util_1.resetSessionCaOverrideInConfig)();
                            this.logger.log('✅ Đã đặt session_ca_override về 0 trong config.json');
                        }
                        this.logger.log(`✅ Đã gửi tin lệnh ca ${sessionCa}/${effectiveSoCa}`);
                    }
                    else {
                        this.logger.log(`⚠️ link_forward_tin_nhan_len_ca[${sessionCa - 1}] trống — bỏ qua`);
                    }
                }
            }
            catch (telegramError) {
                this.logger.log('⚠️ Lỗi gửi tin nhắn bắt đầu - Tiếp tục chạy:');
            }
            this.logger.log('🎰 STEP 8: Bắt đầu tìm bàn Baccarat...');
            await this.findBaccaratActive(newPage);
            this.logger.log('✅ STEP 9: Đã tìm và vào bàn Baccarat');
            this.logger.log('👀 STEP 10: Bắt đầu theo dõi kết quả game...');
            const [gameResult_that, gameResult_ao] = await Promise.all([
                this.waitForGameResult_that(newPage),
                this.waitForGameResult_ao(newPage),
            ]);
            this.lastGameResult_that = gameResult_that;
            this.lastGameResult_ao = gameResult_ao;
            const caForSheet = this.currentSessionCa ?? undefined;
            if (typeof caForSheet === 'number' && caForSheet >= 1) {
                (0, ca_profit_util_1.upsertCaProfitToday)('that', caForSheet, this.lastRunProfit);
                (0, ca_profit_util_1.upsertCaProfitToday)('ao', caForSheet, this.lastRunProfit_ao);
            }
            if ((0, google_sheets_service_1.isGoogleSheetConfigured)()) {
                try {
                    await Promise.all([
                        (0, google_sheets_service_1.appendCaProfitToGoogleSheet)('that', this.lastRunProfit, caForSheet),
                        (0, google_sheets_service_1.appendCaProfitToGoogleSheet)('ao', this.lastRunProfit_ao, caForSheet),
                    ]);
                    this.logger.log(`✅ Đã ghi số tiền ca lên Google Sheet (tab Thật + Ảo)${caForSheet ? ` - CA ${caForSheet}` : ''}`);
                }
                catch (e) {
                    this.logger.log(`⚠️ Lỗi ghi Google Sheet - bỏ qua: ${e}`);
                }
            }
            this.logger.log('✅ STEP 11: Đã hoàn thành theo dõi game');
            await this.closeBrowser();
            this.logger.log('📤 STEP 12: Gửi tin nhắn kết thúc ca...');
            if (telegram_config_1.telegramConfig.link_forward_lenh_ket_thuc) {
                const tasks = [];
                tasks.push(this.forwardMessageToGroupAo(telegram_config_1.telegramConfig.link_forward_lenh_ket_thuc));
                if (this.shouldSendToNhomThat()) {
                    tasks.push(this.telegramService.forwardMessageFromLink(telegram_config_1.telegramConfig.link_forward_lenh_ket_thuc, telegram_config_1.telegramConfig.gui_tin_nhan_vao_group_that));
                }
                else {
                    this.logger.log('⏭️ Bỏ gửi lệnh kết thúc nhóm thật (chi_gui_nhom_ao=true)');
                }
                void Promise.all(tasks);
            }
            if (telegram_config_1.telegramConfig.link_forward_tin_nhan_ket_thuc_ca) {
                const endLinkThat = gameResult_that === 'LOSE'
                    ? (telegram_config_1.telegramConfig.link_forward_tin_nhan_ket_thuc_ca_2 ||
                        telegram_config_1.telegramConfig.link_forward_tin_nhan_ket_thuc_ca)
                    : telegram_config_1.telegramConfig.link_forward_tin_nhan_ket_thuc_ca;
                const endLinkAo = gameResult_ao === 'LOSE'
                    ? (telegram_config_1.telegramConfig.link_forward_tin_nhan_ket_thuc_ca_2 ||
                        telegram_config_1.telegramConfig.link_forward_tin_nhan_ket_thuc_ca)
                    : telegram_config_1.telegramConfig.link_forward_tin_nhan_ket_thuc_ca;
                this.logger.log(`📤 Kết quả: ${gameResult_that} → Forward link: ${endLinkThat === 'LOSE' ? 'ket_thuc_ca_2' : 'ket_thuc_ca'}`);
                const tasks = [];
                tasks.push(this.forwardMessageToGroupAo(endLinkAo));
                if (this.shouldSendToNhomThat()) {
                    tasks.push(this.telegramService.forwardMessageFromLink(endLinkThat, telegram_config_1.telegramConfig.gui_tin_nhan_vao_group_that));
                }
                else {
                    this.logger.log('⏭️ Bỏ gửi kết thúc ca nhóm thật (chi_gui_nhom_ao=true)');
                }
                await Promise.all(tasks);
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
            if (telegram_config_1.telegramConfig.link_forward_tin_nhan_tong_ket) {
                const tongKetLink = telegram_config_1.telegramConfig.link_forward_tin_nhan_tong_ket.trim();
                const tongKetLinkThat = telegram_config_1.telegramConfig.link_forward_tin_nhan_tong_ket_that.trim();
                if (tongKetLink !== '') {
                    const mediaRaw = String(telegram_config_1.telegramConfig.tong_ket_media_path ?? '').trim();
                    const mediaPath = mediaRaw
                        ? path.isAbsolute(mediaRaw)
                            ? mediaRaw
                            : path.join(process.cwd(), mediaRaw)
                        : '';
                    if (this.shouldSendToNhomThat()) {
                        await this.telegramService.forwardMessageFromLink(tongKetLinkThat, telegram_config_1.telegramConfig.gui_tin_nhan_vao_group_that);
                    }
                    else {
                        this.logger.log('⏭️ Bỏ gửi tổng kết nhóm thật (chi_gui_nhom_ao=true)');
                    }
                    for (const gid of this.getGroupAoIds()) {
                        if (mediaPath && fs.existsSync(mediaPath)) {
                            try {
                                await this.telegramService.sendEditedPhotoCaptionFromLink(tongKetLink, gid, mediaPath, (text) => this.editTongKetCaLines(text, 'ao'));
                            }
                            catch (e) {
                                this.logger.log(`⚠️ Gửi tổng kết dạng ảnh lỗi — fallback sang text: ${e}`);
                                await this.telegramService.sendEditedMessageFromLink(tongKetLink, gid, (text) => this.editTongKetCaLines(text, 'ao'));
                            }
                        }
                        else {
                            await this.telegramService.sendEditedMessageFromLink(tongKetLink, gid, (text) => this.editTongKetCaLines(text, 'ao'));
                        }
                    }
                }
            }
            if (telegram_config_1.telegramConfig.link_forward_tin_nhan_phu &&
                Array.isArray(telegram_config_1.telegramConfig.link_forward_tin_nhan_phu) &&
                telegram_config_1.telegramConfig.link_forward_tin_nhan_phu.length > 0) {
                this.logger.log(`📤 Gửi ${telegram_config_1.telegramConfig.link_forward_tin_nhan_phu.length} tin nhắn phụ...`);
                for (const phuLink of telegram_config_1.telegramConfig.link_forward_tin_nhan_phu) {
                    if (phuLink && phuLink.trim() !== '') {
                        const tasks = [];
                        tasks.push(this.forwardMessageToGroupAo(phuLink));
                        if (this.shouldSendToNhomThat()) {
                            tasks.push(this.telegramService.forwardMessageFromLink(phuLink, telegram_config_1.telegramConfig.gui_tin_nhan_vao_group_that));
                        }
                        else {
                            this.logger.log('⏭️ Bỏ gửi tin phụ nhóm thật (chi_gui_nhom_ao=true)');
                        }
                        await Promise.all(tasks);
                        await new Promise((resolve) => setTimeout(resolve, 1000));
                    }
                }
                this.logger.log('✅ Đã gửi xong tất cả tin nhắn phụ');
            }
            if (telegram_config_1.telegramConfig.link_forward_tin_nhan_lich_ca) {
                const tasks = [];
                tasks.push(this.forwardMessageToGroupAo(telegram_config_1.telegramConfig.link_forward_tin_nhan_lich_ca));
                if (this.shouldSendToNhomThat()) {
                    tasks.push(this.telegramService.forwardMessageFromLink(telegram_config_1.telegramConfig.link_forward_tin_nhan_lich_ca, telegram_config_1.telegramConfig.gui_tin_nhan_vao_group_that));
                }
                else {
                    this.logger.log('⏭️ Bỏ gửi lịch ca nhóm thật (chi_gui_nhom_ao=true)');
                }
                await Promise.all(tasks);
            }
            this.logger.log('🎉 HOÀN THÀNH TẤT CẢ!');
        }
        catch (error) {
            this.logger.error('❌ LỖI tại một step nào đó:', error);
            this.logger.error('Stack trace:', error?.stack);
            this.logger.error('Error message:', error?.message);
            try {
                await this.closeBrowser();
            }
            catch (closeError) {
                this.logger.error('❌ Lỗi khi đóng browser sau lỗi:', closeError);
            }
            throw error;
        }
    }
}
exports.PuppeteerService = PuppeteerService;
