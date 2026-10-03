import * as puppeteer from 'puppeteer';
import sharp from 'sharp';
import * as path from 'path';
import { TelegramService } from './telegram/telegram.service';
import { telegramConfig } from '../config/telegram.config';
import * as fs from 'fs';
import { retryWithBackoffAndJitter } from './utils/retry.util';
import {
  appendCaProfitToGoogleSheet,
  isGoogleSheetConfigured,
} from './google-sheets.service';
import {
  getSessionCa,
  readSessionCaOverrideFromConfigFile,
  resetSessionCaOverrideInConfig,
} from './session-ca.util';
import { resolveChromeExecutablePath } from './browser-path.util';
import {
  getCaProfitsToday,
  getTotalsForMonth,
  upsertCaProfitToday,
} from './ca-profit.util';

export type GameResult = 'WIN' | 'LOSE' | 'HOA';

export class PuppeteerService {
  private readonly logger = {
    log: (message: string) => console.log(`[PuppeteerService] ${message}`),
    error: (message: string, error?: any) =>
      console.error(`[PuppeteerService] ${message}`, error),
  };
  private browser: puppeteer.Browser | null = null;
  private telegramService: TelegramService;
  private selectedTableName: string = ''; // Lưu tên bàn đã chọn
  private screenshotLock: Promise<void> = Promise.resolve(); // Lock để đảm bảo chỉ 1 nhóm chụp ảnh tại một thời điểm
  private lastRunProfit: number = 0; // Lời/lỗ phiên vừa chạy (group thật)
  private lastGameResult_that: GameResult | null = null;
  private lastRunProfit_ao: number = 0; // Lời/lỗ phiên vừa chạy (group ảo)
  private lastGameResult_ao: GameResult | null = null;
  private currentSessionCa: number | null = null; // Ca đang chạy (để ghi đúng cột CA trên Google Sheet)

  constructor(telegramService: TelegramService) {
    this.telegramService = telegramService;
  }

  private chiGuiNhomAo(): boolean {
    return Boolean((telegramConfig as any).chi_gui_nhom_ao);
  }

  private shouldSendToNhomThat(): boolean {
    return !this.chiGuiNhomAo();
  }

  private formatSignedAmount(amount: number): string {
    if (amount === 0) return '0';
    const abs = Math.abs(Math.round(amount)).toLocaleString('de-DE');
    return amount > 0 ? `+${abs}` : `-${abs}`;
  }

  private formatCaAmountForGroup(amount: number, group: 'that' | 'ao'): string {
    if (amount === 0) {
      return group === 'ao' ? '+0.000' : '+0.000';
    }
    return this.formatSignedAmount(amount);
  }

  private insertBeforeLastEmoji(line: string, textToInsert: string): string {
    const trailingSpacesMatch = line.match(/\s*$/);
    const trailingSpaces = trailingSpacesMatch?.[0] ?? '';
    const core = trailingSpaces ? line.slice(0, -trailingSpaces.length) : line;
    const chars = Array.from(core);
    if (chars.length === 0) return `${line} ${textToInsert}`;

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

  /** Ca từ dòng mẫu tổng kết: ưu tiên số sau "CA" (CA 01 … 12h00→ca1); không có số thì theo giờ 07h30→ca1. */
  private parseCaIndexFromTongKetLine(line: string): number | null {
    const caMatch = line
      .normalize('NFKC')
      .match(/\bCA\b\s*((?:\d\p{M}*){1,2})(?!\d|\s*h\s*\d)/iu);
    if (caMatch) {
      const n = Number.parseInt(caMatch[1].replace(/\D/g, ''), 10);
      if (n >= 1 && n <= 30) return n;
    }
    const hourMatch = line.match(/(\d{1,2})\s*h\s*\d{2}/i);
    if (hourMatch) {
      const caFromHour = Number.parseInt(hourMatch[1], 10) - 6;
      if (caFromHour >= 1 && caFromHour <= 30) return caFromHour;
    }
    return null;
  }

  private isTongKetCaLine(line: string): boolean {
    const normalized = line.normalize('NFKC');
    return (
      /\bCA\b/i.test(normalized) &&
      (/\d{1,2}\s*h\s*\d{2}/i.test(normalized) || /📣/.test(normalized))
    );
  }

  // Điền lời/lỗ theo từng ca đã chạy; ca chưa chạy để trống.
  private editTongKetCaLines(text: string, group: 'that' | 'ao'): string {
    const caProfits = getCaProfitsToday(group);
    const { today, month } = getTotalsForMonth(group);
    const cfgLink = String((telegramConfig as any).dang_ky_link ?? '').trim();
    const foundUser = text.match(/@([a-zA-Z0-9_]{4,})/);
    const inferredLink = foundUser ? `https://t.me/${foundUser[1]}` : '';
    const dangKyLink = cfgLink || inferredLink || 'https://gk881.sbs/?f=1138433';
    let caCursor = 0;
    const filledCas: number[] = [];
    const result = text
      .split('\n')
      .map((line) => {
        // Mẫu mới: ✔️ CA 0️⃣1️⃣ — 07h30📣
        if (this.isTongKetCaLine(line)) {
          const caIndex = this.parseCaIndexFromTongKetLine(line);
          if (caIndex && typeof caProfits[caIndex] === 'number') {
            filledCas.push(caIndex);
            const amount = this.formatCaAmountForGroup(
              caProfits[caIndex],
              group,
            );
            if (/:\s*[+-]?\s*$/.test(line)) {
              return line.replace(/:\s*[+-]?\s*$/, `: ${amount}`);
            }
            return this.insertBeforeLastEmoji(line, amount);
          }
          return line;
        }
        // Dòng Ca cũ: Ca 01 - 07H30 / H30
        if (line.includes('H30') || line.includes('H00')) {
          caCursor += 1;
          const caMatch = line.match(/Ca\s*0?(\d+)/i);
          const caIndex = caMatch
            ? Number.parseInt(caMatch[1], 10)
            : caCursor;
          if (typeof caProfits[caIndex] === 'number') {
            filledCas.push(caIndex);
            return this.insertBeforeLastEmoji(
              line,
              this.formatCaAmountForGroup(caProfits[caIndex], group),
            );
          }
          return line;
        }
        // Dòng theo giờ (vd. -07H00 … -23H00): ca 1 = 7h, ca 17 = 23h
        const hourSlot = line.match(/-(\d{1,2})H\d{2}/i);
        if (hourSlot) {
          const hour = Number.parseInt(hourSlot[1], 10);
          const caFromHour = hour - 6;
          if (caFromHour >= 1 && typeof caProfits[caFromHour] === 'number') {
            filledCas.push(caFromHour);
            return this.insertBeforeLastEmoji(
              line,
              this.formatCaAmountForGroup(caProfits[caFromHour], group),
            );
          }
          return line;
        }
        // Tổng ngày (TỔNG NGÀY hoặc 📊 NGÀY :)
        if (/TỔNG\s+NGÀY/i.test(line) || /\bNGÀY\s*:/i.test(line)) {
          return this.insertBeforeLastEmoji(line, this.formatSignedAmount(today));
        }
        // Tổng tháng (TỔNG THÁNG hoặc THÁNG 6 :)
        if (/TỔNG\s+THÁNG/i.test(line) || /\bTHÁNG\s*\d*\s*:/i.test(line)) {
          return this.insertBeforeLastEmoji(line, this.formatSignedAmount(month));
        }
        if (/ĐĂNG\s*KÝ/i.test(line) && !/https?:\/\//i.test(line)) {
          return `${line} ${dangKyLink}`;
        }
        return line;
      })
      .join('\n');
    this.logger.log(
      `📊 Tổng kết (${group}): điền ${filledCas.length} ca [${filledCas.join(',')}], ngày=${this.formatSignedAmount(today)}, tháng=${this.formatSignedAmount(month)}`,
    );
    return result;
  }

  private getChromeLaunchOptions(): puppeteer.LaunchOptions {
    const opts: puppeteer.LaunchOptions = {
      headless: !process.env.RUN_NOW,
      env: { ...process.env, LANGUAGE: 'vi' },
      protocolTimeout: 120000, // 2 phút — tránh Runtime.callFunctionOn timed out khi evaluate trong iframe chậm
      args: [
	    '--lang=vi-VN',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-zygote',
            '--start-maximized',
            // Enable WebGL and hardware acceleration
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
            // Anti-detection
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

    const systemChrome = resolveChromeExecutablePath();
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
    } catch {
      // puppeteer chưa tải browser — sẽ lỗi rõ khi launch
    }

    this.logger.log(
      '⚠️ Chưa tìm thấy Chrome. Trên VPS: thêm chrome_executable_path vào config.json hoặc chạy: npx puppeteer browsers install chrome',
    );
    return opts;
  }

  async launchBrowser(): Promise<void> {
    return retryWithBackoffAndJitter(
      async () => {
        this.browser = await puppeteer.launch(this.getChromeLaunchOptions());
      },
      {
        maxRetries: 3,
        initialDelay: 2000,
        maxDelay: 10000,
        retryableErrors: ['browser', 'launch', 'timeout', 'network'],
        onRetry: (attempt, error, delay) => {
          this.logger.log(
            `🔄 Retry khởi tạo browser lần ${attempt} sau ${Math.round(delay)}ms...`,
          );
        },
      },
    ).catch((error) => {
      this.logger.error('❌ Lỗi khi khởi tạo trình duyệt:', error);
      throw error;
    });
  }

  async openPage(url: string): Promise<puppeteer.Page> {
    return retryWithBackoffAndJitter(
      async () => {
        if (!this.browser) {
          await this.launchBrowser();
        }

        const page = await this.browser!.newPage();

        // Anti-detection settings
        await page.evaluateOnNewDocument(() => {
          // Remove webdriver property
          Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
          });

          // Mock plugins
          Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5],
          });

          // Mock languages
          Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en'],
          });

          // Mock chrome object
          (window as any).chrome = {
            runtime: {},
          };

          // Override getParameter
          Object.defineProperty(navigator, 'getParameter', {
            get: () => () => null,
          });
        });

        // Set realistic user agent
        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        );

        // Set viewport
        await page.setViewport({
          width: 1920,
          height: 1080,
          deviceScaleFactor: 1,
          hasTouch: false,
          isLandscape: true,
          isMobile: false,
        });

        // Set extra headers
        await page.setExtraHTTPHeaders({
          'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
          'Upgrade-Insecure-Requests': '1',
          'Cache-Control': 'max-age=0',
        });

        // Random delay before navigation
        await new Promise((resolve) =>
          setTimeout(resolve, Math.random() * 2000 + 1000),
        );

        await page.goto(url, {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });

        return page;
      },
      {
        maxRetries: 3,
        initialDelay: 2000,
        maxDelay: 10000,
        retryableErrors: ['timeout', 'navigation', 'network', 'net::'],
        onRetry: (attempt, error, delay) => {
          this.logger.log(
            `🔄 Retry mở trang lần ${attempt} sau ${Math.round(delay)}ms...`,
          );
        },
      },
    ).catch((error) => {
      this.logger.error('❌ Lỗi khi mở trang:', error);
      throw error;
    });
  }

  async closeBrowser(): Promise<void> {
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.logger.log('🛑 Đã đóng toàn bộ trình duyệt. 🛑 KẾT THÚC CA');
        return;
      }
    } catch (error) {
      this.logger.error('❌ Lỗi khi đóng page:', error);
      throw error;
    }
  }

  async login(
    page: puppeteer.Page,
    username: string,
    password: string,
  ): Promise<void> {
    try {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      this.logger.log('🔐 Bắt đầu đăng nhập...');

      // Tìm và nhập username
      await page.waitForSelector('#login', { timeout: 15000 });
      await page.type('#login', username);
      this.logger.log('✅ Đã nhập username');

      // Tìm và nhập password
      await page.waitForSelector('#password', { timeout: 15000 });
      await page.type('#password', password);
      this.logger.log('✅ Đã nhập password');

      // Click button đăng nhập và đợi navigation
      this.logger.log('🔍 Đang tìm nút đăng nhập...');

      // Tạo promise để đợi navigation (nếu có)
      const navigationPromise = page
        .waitForNavigation({
          waitUntil: 'networkidle2',
          timeout: 30000,
        })
        .catch(() => {
          this.logger.log('⚠️ Không có navigation sau khi đăng nhập');
          return null;
        });

      // Click button
      const clicked = await page.waitForFunction(
        () => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const loginButton = buttons.find((btn) =>
            btn.textContent?.includes('Đăng Nhập'),
          );
          if (loginButton) {
            (loginButton as HTMLButtonElement).click();
            return true;
          }
          return false;
        },
        { timeout: 10000 },
      );

      if (!clicked) {
        throw new Error('Không tìm thấy nút Đăng Nhập');
      }

      this.logger.log('✅ Đã click nút đăng nhập');

      // Đợi navigation hoàn tất (nếu có)
      await navigationPromise;

      // Đợi thêm để đảm bảo page ổn định
      this.logger.log('⏳ Đợi page ổn định sau đăng nhập...');
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Kiểm tra URL sau khi đăng nhập
      const currentUrl = page.url();
      this.logger.log(`📄 URL sau khi đăng nhập: ${currentUrl}`);

      // Kiểm tra xem có đăng nhập thành công không
      // Có thể thêm logic check element đặc trưng của trang đã đăng nhập
      try {
        await page.waitForFunction(
          () => {
            // Check xem có button SEXYBCRT không (dấu hiệu đã login)
            return (
              document.querySelector('[data-provider="SEXYBCRT"]') !== null
            );
          },
          { timeout: 10000 },
        );
        this.logger.log('✅ Đăng nhập thành công - Đã tìm thấy SEXYBCRT');
      } catch (checkError) {
        this.logger.log(
          '⚠️ Không tìm thấy SEXYBCRT ngay sau login, có thể cần đợi thêm',
        );
        // Đợi thêm 5 giây
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } catch (error) {
      this.logger.error('❌ Lỗi khi đăng nhập:', error);

      // Chụp screenshot để debug
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        await page.screenshot({
          path: `screenshots-debug/login-error-${timestamp}.png`,
          fullPage: true,
        });
        this.logger.log('📸 Đã chụp screenshot lỗi đăng nhập');
      } catch (screenshotError) {
        // Ignore screenshot error
      }

      throw error;
    }
  }

  async navigateToSexyBaccarat(page: puppeteer.Page): Promise<puppeteer.Page> {
    this.logger.log('🚀 [navigateToSexyBaccarat] BẮT ĐẦU');

    try {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const newPagePromise = new Promise<puppeteer.Page>((resolve, reject) => {
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
                this.logger.log(
                  `✅ [Event] Đã tìm thấy page mới: ${newPage.url()}`,
                );
                resolve(newPage);
              }
            }
          } catch (error) {
            this.logger.error('❌ [Event] Lỗi trong targetcreated:', error);
            clearTimeout(timeout);
            reject(error);
          }
        });
      });
      // Click vào SEXYBCRT
      const found = await page.waitForFunction(
        () => {
          const selectors = [
            'a[data-provider="SEXYBCRT"]',
            'li[data-provider="sexybcrt"] a[data-provider="SEXYBCRT"]',
            '[data-provider="SEXYBCRT"]',
            '*[data-provider="SEXYBCRT"]',
          ];

          for (const selector of selectors) {
            try {
              const element = document.querySelector(selector);
              if (element && (element as HTMLElement).offsetParent !== null) {
                (element as HTMLElement).click();
                return true;
              }
            } catch (e) {
              continue;
            }
          }
          return false;
        },
        { timeout: 15000 },
      );

      if (!found) {
        throw new Error('Không tìm thấy sảnh SEXYBCRT');
      }
      const newPage = await newPagePromise;
      // Đợi page load (với timeout)
      try {
        await newPage.waitForNavigation({
          waitUntil: 'networkidle2',
          timeout: 30000,
        });
      } catch (navError) {
        this.logger.log('⚠️ [5/6] Navigation timeout hoặc không cần thiết');
      }

      // Đợi thêm để chắc chắn
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const finalUrl = newPage.url();
      this.logger.log('🎉 [navigateToSexyBaccarat] HOÀN THÀNH');
      return newPage;
    } catch (error) {
      this.logger.error('❌ [navigateToSexyBaccarat] LỖI:', error);
      this.logger.error('Stack:', error?.stack);

      // Chụp screenshot để debug
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
      } catch (screenshotError) {
        // Ignore
      }

      throw error;
    }
  }

  // Helper: Thay thế element #gameMessage trong iframe
  async replaceGameMessage(
    frame: puppeteer.Frame,
    isWin: boolean,
    amount: string,
  ): Promise<void> {
    try {
      console.log('win', isWin);
      console.log('amt', amount);
      await frame.evaluate(
        (win: boolean, amt: string) => {
          // Xóa element cũ nếu có
          const oldElement = document.getElementById('gameMessage');
          if (oldElement) {
            oldElement.remove();
          }

          // Tạo element mới
          const newElement = document.createElement('div');
          newElement.id = 'gameMessage';
          newElement.className = win ? 'message_win' : 'message_lose';
          newElement.style.cssText = 'right: 48px;';
          newElement.style.animation = 'none';
          const p = document.createElement('p');
          p.textContent = amt;
          newElement.appendChild(p);

          // Thêm vào body
          document.body.appendChild(newElement);
        },
        isWin,
        amount,
      );

      this.logger.log(`✅ Đã thay thế #gameMessage: ${amount}`);
    } catch (error) {
      this.logger.error('❌ Lỗi thay thế gameMessage:', error);
    }
  }

  // Helper: Lấy config cược theo nhóm (that = group thật, ao = group ảo)
  private getGameBetConfig(useAo: boolean): {
    betAmount: number;
    bankerOdds: number;
    playerOdds: number;
  } {
    const defaultConfig = {
      betAmount: 200,
      bankerOdds: 0.95,
      playerOdds: 1.0,
    };
    const main = telegramConfig.gameBetConfig || defaultConfig;
    if (useAo && (telegramConfig as any).gameBetConfigAo) {
      const ao = (telegramConfig as any).gameBetConfigAo;
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

  // Helper: Lấy betAmount từ config (useAo = true cho group ảo)
  private getBetAmount(useAo?: boolean): number {
    const config = this.getGameBetConfig(useAo ?? false);
    return config.betAmount;
  }

  private getPredictionLink(prediction: string): string {
    return (
      (prediction.toUpperCase().includes('CÁI')
        ? telegramConfig.link_forward_du_doan_cai
        : telegramConfig.link_forward_du_doan_con) || ''
    );
  }

  private getResultLink(isDraw: boolean, isWin: boolean): string {
    return (
      (isDraw
        ? telegramConfig.link_forward_lenh_ket_thuc_draw
        : isWin
          ? telegramConfig.link_forward_lenh_ket_thuc_win
          : telegramConfig.link_forward_lenh_ket_thuc_lose) || ''
    );
  }

  // Helper: Tính toán số tiền thắng (chỉ số, không có dấu +/-). useAo = true cho group ảo.
  private calculateWinAmount(winner?: string, useAo?: boolean): number {
    const config = this.getGameBetConfig(useAo ?? false);
    const { betAmount, bankerOdds, playerOdds } = config;

    if (winner?.toUpperCase() === 'NHÀ CÁI') {
      return betAmount * bankerOdds;
    } else {
      return betAmount * playerOdds;
    }
  }

  // Helper: Tính toán số tiền thắng/thua dựa trên betAmount và odds từ config. useAo = true cho group ảo.
  private calculateAmount(
    isDraw: boolean,
    isWin: boolean,
    winner?: string,
    useAo?: boolean,
  ): string {
    const config = this.getGameBetConfig(useAo ?? false);
    const { betAmount, bankerOdds, playerOdds } = config;

    if (isDraw) {
      // HÒA: +0
      return '+0';
    }

    if (isWin) {
      // Thắng: tính dựa trên odds
      let winAmount: number;
      if (winner?.toUpperCase() === 'NHÀ CÁI') {
        // Thắng Banker: betAmount * bankerOdds
        winAmount = betAmount * bankerOdds;
      } else {
        // Thắng Player: betAmount * playerOdds
        winAmount = betAmount * playerOdds;
      }
      // Format với dấu phẩy và 2 chữ số thập phân
      return `+${winAmount.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    }

    // Thua: -betAmount
    return `-${betAmount.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  // Gate bắt buộc: phải thấy iframe game trước khi gửi tin Telegram đầu tiên.
  private async waitForGameIframeReady(page: puppeteer.Page): Promise<void> {
    this.logger.log('⏳ Gate: Đang chờ iframe game xuất hiện...');
    const maxAttempts = 50; // ~100 giây chờ + thời gian reload (build/prod thường chậm hơn dev)
    const checkInterval = 2000;
    const reloadEveryAttempts = 12; // ~24s giữa các lần thử reload
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
        } catch {
          // Bỏ qua lỗi selector, thử selector khác
        }
      }

      const allIframes = await page.$$('iframe');
      if (allIframes.length > 0) {
        this.logger.log(`✅ Gate: Đã thấy ${allIframes.length} iframe`);
        return;
      }

      if (attempt < maxAttempts - 1) {
        if (
          attempt > 0 &&
          attempt % reloadEveryAttempts === 0
        ) {
          this.logger.log(
            '🔄 Gate: Chưa thấy iframe — reload trang game rồi chờ tiếp...',
          );
          try {
            await page.reload({
              waitUntil: 'domcontentloaded',
              timeout: 60000,
            });
            await new Promise((resolve) => setTimeout(resolve, 3000));
          } catch (reloadErr) {
            this.logger.log(`⚠️ Gate: Reload lỗi, tiếp tục chờ: ${reloadErr}`);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
      }
    }

    throw new Error(
      'Gate fail: Không tìm thấy iframe game sau nhiều lần chờ và reload',
    );
  }

  // Helper: Lấy danh sách group IDs (hỗ trợ cả string và array)
  private getGroupAoIds(): string[] {
    const config = telegramConfig.gui_tin_nhan_vao_group_ao;
    if (Array.isArray(config)) {
      return config;
    }
    return [config];
  }

  /** Xóa toàn bộ ảnh trong screenshots-result, screenshots-table, screenshots-tables (gọi theo lịch 00:05 và 15:05) */
  cleanupAllScreenshotFolders(): void {
    const path = require('path');
    try {
      if (fs.existsSync('screenshots-result')) {
        const files = fs.readdirSync('screenshots-result');
        for (const f of files) {
          const full = path.join('screenshots-result', f);
          if (fs.statSync(full).isFile()) fs.unlinkSync(full);
        }
        this.logger.log('✅ Đã xóa ảnh trong screenshots-result');
      }
      if (fs.existsSync('screenshots-table')) {
        const files = fs.readdirSync('screenshots-table');
        for (const f of files) {
          const full = path.join('screenshots-table', f);
          if (fs.statSync(full).isFile()) fs.unlinkSync(full);
        }
        this.logger.log('✅ Đã xóa ảnh trong screenshots-table');
      }
      if (fs.existsSync('screenshots-tables')) {
        const subs = fs.readdirSync('screenshots-tables');
        for (const sub of subs) {
          const full = path.join('screenshots-tables', sub);
          if (fs.statSync(full).isDirectory()) {
            fs.rmSync(full, { recursive: true });
          } else {
            fs.unlinkSync(full);
          }
        }
        this.logger.log('✅ Đã xóa ảnh và folder trong screenshots-tables');
      }
    } catch (err) {
      this.logger.error('❌ Lỗi xóa ảnh/folder:', err);
    }
  }

  // Helper: Gửi tin nhắn đến nhiều group ảo với delay 500ms
  private async sendMessageToGroupAo(
    message: string,
    delay: number = 500,
  ): Promise<void> {
    const groupIds = this.getGroupAoIds();
    for (let i = 0; i < groupIds.length; i++) {
      try {
        await this.telegramService.sendMessage(groupIds[i], message);
        this.logger.log(
          `✅ Đã gửi tin nhắn đến group ảo ${i + 1}/${groupIds.length}`,
        );
        // Đợi 500ms trước khi gửi group tiếp theo (trừ group cuối)
        if (i < groupIds.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } catch (error) {
        this.logger.error(`❌ Lỗi gửi tin nhắn đến group ảo ${i + 1}:`, error);
      }
    }
  }

  // Helper: Gửi ảnh đến nhiều group ảo với delay 500ms
  private async sendPhotoToGroupAo(
    photoPath: string,
    caption?: string,
    delay: number = 500,
  ): Promise<void> {
    const groupIds = this.getGroupAoIds();
    for (let i = 0; i < groupIds.length; i++) {
      try {
        await this.telegramService.sendPhoto(groupIds[i], photoPath, caption);
        this.logger.log(
          `✅ Đã gửi ảnh đến group ảo ${i + 1}/${groupIds.length}`,
        );
        // Đợi 500ms trước khi gửi group tiếp theo (trừ group cuối)
        if (i < groupIds.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } catch (error) {
        this.logger.error(`❌ Lỗi gửi ảnh đến group ảo ${i + 1}:`, error);
      }
    }
  }

  // Helper: Forward message đến nhiều group ảo với delay 500ms
  private async forwardMessageToGroupAo(
    link: string,
    delay: number = 500,
  ): Promise<void> {
    const groupIds = this.getGroupAoIds();
    for (let i = 0; i < groupIds.length; i++) {
      try {
        await this.telegramService.forwardMessageFromLink(link, groupIds[i]);
        this.logger.log(
          `✅ Đã forward message đến group ảo ${i + 1}/${groupIds.length}`,
        );
        // Đợi 500ms trước khi gửi group tiếp theo (trừ group cuối)
        if (i < groupIds.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } catch (error) {
        this.logger.error(
          `❌ Lỗi forward message đến group ảo ${i + 1}:`,
          error,
        );
      }
    }
  }

  async findBaccaratActive(page: puppeteer.Page): Promise<void> {
    try {
      this.logger.log(`📄 Bắt đầu findBaccaratActive với URL: ${page.url()}`);

      // Đợi page ổn định
      await new Promise((resolve) => setTimeout(resolve, 10000));

      this.logger.log('🔍 Đang tìm các bàn Baccarat đang hoạt động...');

      // Kiểm tra xem page có đang load không
      try {
        await page.waitForFunction(() => document.readyState === 'complete', {
          timeout: 10000,
        });
        this.logger.log('✅ Page readyState = complete');
      } catch {
        this.logger.log('⏳ Đợi thêm 5 giây...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      // Đợi iframe xuất hiện với polling
      this.logger.log('⏳ Đang đợi iframe xuất hiện (có thể load động)...');
      let iframe: puppeteer.ElementHandle<HTMLIFrameElement> | null = null;
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
            } catch (e) {
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
                iframe = found as puppeteer.ElementHandle<HTMLIFrameElement>;
                this.logger.log(`✅ Tìm thấy iframe với selector: ${selector}`);
                break;
              }
            } catch (error) {
              continue;
            }
          }

          if (!iframe && allIframes.length > 0) {
            this.logger.log(
              '⚠️ Không tìm thấy #iframeGameHall, thử dùng iframe đầu tiên...',
            );
            iframe =
              allIframes[0] as puppeteer.ElementHandle<HTMLIFrameElement>;
          }

          if (iframe) {
            break;
          }
        }

        if (!iframe && attempt < maxAttempts - 1) {
          this.logger.log(
            `⏳ Chưa tìm thấy iframe, đợi thêm ${checkInterval / 1000} giây...`,
          );
          await new Promise((resolve) => setTimeout(resolve, checkInterval));
        }
      }

      if (!iframe) {
        const pageContent = await page.content();
        const pageTitle = await page.title();
        this.logger.error(`❌ URL page: ${page.url()}`);
        this.logger.error(`❌ Title page: ${pageTitle}`);
        this.logger.error(
          `❌ Page content length: ${pageContent.length} characters`,
        );
        throw new Error('Không tìm thấy iframe iframeGameHall sau 60 giây.');
      }

      // Chuyển vào iframe
      const frame = await iframe.contentFrame();
      if (!frame) {
        throw new Error('Không thể truy cập vào iframe');
      }

      // Bỏ chụp hình sảnh + captionBaoBan: group ảo sẽ nhận báo bàn bằng link forward.

      // Tìm các bàn Baccarat
      const baccaratElements = await frame.evaluate(() => {
        const spans = document.querySelectorAll('span');
        const baccaratSpans = Array.from(spans).filter(
          (span) =>
            span.textContent &&
            span.textContent.toLowerCase().includes('baccarat'),
        );

        return baccaratSpans.slice(0, 5).map((span, index) => ({
          index: index + 1,
          text: span.textContent?.trim() || '',
          element: span,
        }));
      });

      if (baccaratElements.length === 0) {
        throw new Error('Không tìm thấy bàn baccarat nào');
      }

      // Chọn ngẫu nhiên
      const randomIndex = Math.floor(
        Math.random() * Math.min(5, baccaratElements.length),
      );
      const selectedTable = baccaratElements[randomIndex];

      this.logger.log(`🎯 Đã chọn bàn: ${selectedTable.text}`);

      // Lưu tên bàn để dùng sau
      this.selectedTableName = selectedTable.text;

      // Click vào bàn
      await frame.evaluate((index) => {
        const spans = document.querySelectorAll('span');
        const baccaratSpans = Array.from(spans).filter(
          (span) =>
            span.textContent &&
            span.textContent.toLowerCase().includes('baccarat'),
        );

        if (baccaratSpans[index]) {
          (baccaratSpans[index] as HTMLElement).click();
        }
      }, randomIndex);

      // Đợi bàn load
      this.logger.log('⏳ Đợi 15 giây để hoàn thành tải dữ liệu bàn...');
      await new Promise((resolve) => setTimeout(resolve, 45000));

      // Gửi tin nhắn Telegram - KHÔNG throw error nếu lỗi
      this.logger.log('📤 Đang gửi tin nhắn Telegram...');

      // Forward vào sảnh cho cả 2 nhóm TRƯỚC khi gửi số bàn/ảnh bàn
      try {
        if (telegramConfig.link_forward_tin_nhan_vao_sanh) {
          const tasks: Promise<unknown>[] = [];
          tasks.push(
            this.forwardMessageToGroupAo(
              telegramConfig.link_forward_tin_nhan_vao_sanh,
            ).catch((err) => {
              this.logger.log(
                `⚠️ Lỗi gửi Telegram vào sảnh (ảo) - Bỏ qua: ${err}`,
              );
            }),
          );
          if (this.shouldSendToNhomThat()) {
            tasks.push(
              this.telegramService
                .forwardMessageFromLink(
                  telegramConfig.link_forward_tin_nhan_vao_sanh,
                  telegramConfig.gui_tin_nhan_vao_group_that,
                )
                .catch((err) => {
                  this.logger.log(
                    `⚠️ Lỗi gửi Telegram vào sảnh (thật) - Bỏ qua: ${err}`,
                  );
                }),
            );
          } else {
            this.logger.log('⏭️ Bỏ gửi nhóm thật (chi_gui_nhom_ao=true)');
          }
          await Promise.all(tasks);
        }
      } catch (err) {
        this.logger.log(`⚠️ Lỗi gửi Telegram vào sảnh - Bỏ qua: ${err}`);
      }

      // Chụp ảnh bàn
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const tableScreenshotPath = `screenshots-table/${timestamp}.png`;

        if (!fs.existsSync('screenshots-table')) {
          fs.mkdirSync('screenshots-table', { recursive: true });
        }

        // Set viewport riêng cho phần chụp bàn
        this.logger.log('🔧 Set viewport cho chụp bàn...');
        const CAPTURE_WIDTH = 1600;
        const CAPTURE_HEIGHT = 900;

        await page.setViewport({
          width: CAPTURE_WIDTH,
          height: CAPTURE_HEIGHT,
          deviceScaleFactor: 1,
        });

        await new Promise((resolve) => setTimeout(resolve, 500));

        // Reset lại iframe về kích thước mới
        await page.evaluate(
          (w, h) => {
            const iframe = document.querySelector('iframe');
            if (iframe) {
              iframe.style.width = `${w}px`;
              iframe.style.height = `${h}px`;
              iframe.style.position = 'fixed';
              iframe.style.top = '0';
              iframe.style.left = '0';
            }
          },
          CAPTURE_WIDTH,
          CAPTURE_HEIGHT,
        );

        await new Promise((resolve) => setTimeout(resolve, 300));

        // Scroll về đầu và reset scale trong iframe
        await frame.evaluate(() => {
          window.scrollTo(0, 0);
          document.body.style.zoom = '1';
          document.body.style.transform = 'scale(1)';
        });

        await new Promise((resolve) => setTimeout(resolve, 500));

        // Tìm vùng bàn chơi chính xác
        const tableBox = await frame.evaluate(() => {
          const gameContainer =
            document.querySelector('#game-container') ||
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

        this.logger.log(
          `📐 Chụp bàn: x=${tableBox.x}, y=${tableBox.y}, w=${tableBox.width}, h=${tableBox.height}, dpr=${dpr}`,
        );

        if (tableClipW <= 0 || tableClipH <= 0) {
          this.logger.log(
            '⚠️ Kích thước bàn không hợp lệ (<=0), chụp toàn bộ iframe',
          );
          await iframe.screenshot({
            path: tableScreenshotPath as `${string}.png`,
            type: 'png',
          });
        } else {
          await iframe.screenshot({
            path: tableScreenshotPath as `${string}.png`,
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
            const croppedImagePath = tableScreenshotPath.replace(
              '.png',
              '_cropped.png',
            );
            const imageInfo = await sharp(tableScreenshotPath).metadata();
            const originalHeight = imageInfo.height || 0;

            await sharp(tableScreenshotPath)
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
                  .sendPhoto(
                    telegramConfig.gui_tin_nhan_vao_group_that,
                    croppedImagePath,
                    tableCaption,
                  )
                  .then(() => {
                    sendSuccess = true;
                    this.logger.log('✅ Đã gửi ảnh bàn cho group thật');
                  })
                  .catch((err) => {
                    this.logger.log(
                      `⚠️ Lỗi gửi ảnh bàn (thật) - Bỏ qua: ${err}`,
                    );
                  });
              } else {
                this.logger.log('⏭️ Bỏ gửi ảnh bàn nhóm thật (chi_gui_nhom_ao=true)');
                // Không coi là "sendSuccess" vì nhóm ảo không gửi ảnh bàn ở flow này.
              }

              this.logger.log(`📤 Đã gửi ảnh qua Telegram: ${sendSuccess}`);
            } catch (telegramError) {
              this.logger.log(`⚠️ Lỗi gửi ảnh - Tiếp tục: ${telegramError}`);
            }

            // Xóa ảnh sau khi gửi thành công (ít nhất 1 group thành công)
            if (sendSuccess) {
              try {
                if (fs.existsSync(tableScreenshotPath)) {
                  fs.unlinkSync(tableScreenshotPath);
                }
                if (fs.existsSync(croppedImagePath)) {
                  fs.unlinkSync(croppedImagePath);
                }
                this.logger.log('🗑️ Đã xóa ảnh bàn sau khi gửi thành công');
              } catch (deleteError) {
                this.logger.error('❌ Lỗi xóa ảnh bàn:', deleteError);
              }
            }

            // Sau khi gửi ảnh bàn, forward tin nhắn vào sảnh
            this.logger.log('📤 Đang gửi tin nhắn vào sảnh...');
            try {
              // link vao_sanh đã gửi trước bước gửi số bàn để 2 nhóm đồng bộ

              // Thứ tự: sau vào sảnh, trước chờ lệnh -> gửi báo bàn cho group ảo
              const baoBanLink = String(
                (telegramConfig as any).link_forward_tin_nhan_bao_ban ?? '',
              ).trim();
              if (baoBanLink) {
                await this.forwardMessageToGroupAo(baoBanLink).catch((err) => {
                  this.logger.log(
                    `⚠️ Lỗi forward báo bàn (ảo) - Bỏ qua: ${err}`,
                  );
                });
              }

              if (telegramConfig.link_forward_tin_nhan_cho_lenh) {
                const tasks: Promise<unknown>[] = [];
                tasks.push(
                  this.forwardMessageToGroupAo(
                    telegramConfig.link_forward_tin_nhan_cho_lenh,
                  ).catch((err) => {
                    this.logger.log(
                      `⚠️ Lỗi gửi Telegram vào cho lenh (ảo) - Bỏ qua: ${err}`,
                    );
                  }),
                );
                if (this.shouldSendToNhomThat()) {
                  tasks.push(
                    this.telegramService
                      .forwardMessageFromLink(
                        telegramConfig.link_forward_tin_nhan_cho_lenh,
                        telegramConfig.gui_tin_nhan_vao_group_that,
                      )
                      .catch((err) => {
                        this.logger.log(
                          `⚠️ Lỗi gửi Telegram vào cho lenh (thật) - Bỏ qua: ${err}`,
                        );
                      }),
                  );
                } else {
                  this.logger.log(
                    '⏭️ Bỏ gửi tin chờ lệnh nhóm thật (chi_gui_nhom_ao=true)',
                  );
                }
                await Promise.all(tasks);
              }
            } catch (telegramError) {
              this.logger.log('⚠️ Lỗi gửi tin nhắn vào sảnh - Tiếp tục chạy:');
            }
          }
        } catch (deleteError) {
          this.logger.error('❌ Lỗi xử lý ảnh bàn:', deleteError);
        }
      } catch (screenshotError) {
        this.logger.error('❌ Lỗi khi chụp ảnh bàn:', screenshotError);
      }

      this.logger.log(
        '✅ findBaccaratActive hoàn thành (bỏ qua lỗi Telegram nếu có)',
      );
    } catch (error) {
      this.logger.error('❌ Lỗi khi chọn bàn baccarat:', error);
      throw error;
    }
  }

  async waitForGameResult_that(
    page: puppeteer.Page,
  ): Promise<GameResult> {
    try {
      await new Promise((resolve) => setTimeout(resolve, 10000));

      this.logger.log('🎮 Bắt đầu theo dõi kết quả...');

      // Tìm iframe có id iframeGameHall
      const iframe = await page.waitForSelector('#iframeGame', {
        timeout: 30000,
      });
      if (!iframe) {
        throw new Error('Không tìm thấy iframe iframeGame');
      }

      // Chuyển vào iframe
      const frame = await iframe.contentFrame();
      if (!frame) {
        throw new Error('Không thể truy cập vào iframe');
      }

      // Biến để theo dõi trạng thái
      let hasFirstResult = false;
      let prediction = '';
      let lastResult = '';

      // Lắng nghe liên tục kết quả game với polling trong iframe
      while (true) {
        try {
          // Kiểm tra kết quả hiện tại
          const currentResult = await frame.evaluate(() => {
            const gameWinnerPlayer =
              document.querySelector('#gameWinnerPlayer');
            const gameWinnerBanker =
              document.querySelector('#gameWinnerBanker');

            if (!gameWinnerBanker || !gameWinnerPlayer) {
              throw new Error('Chưa vào được bàn Baccarat');
            }

            if (
              gameWinnerPlayer &&
              gameWinnerPlayer.classList.contains('result_win_blue')
            ) {
              const playerHandValue =
                document.querySelector('#playerHandValue')?.textContent || '0';
              const bankerHandValue =
                document.querySelector('#bankerHandValue')?.textContent || '0';
              return {
                hasResult: true,
                playerValue: playerHandValue,
                bankerValue: bankerHandValue,
                winner: 'Tay Con',
              };
            }
            if (
              gameWinnerBanker &&
              gameWinnerBanker.classList.contains('result_win_red')
            ) {
              const playerHandValue =
                document.querySelector('#playerHandValue')?.textContent || '0';
              const bankerHandValue =
                document.querySelector('#bankerHandValue')?.textContent || '0';
              return {
                hasResult: true,
                playerValue: playerHandValue,
                bankerValue: bankerHandValue,
                winner: 'Nhà Cái',
              };
            }
            if (
              gameWinnerBanker &&
              gameWinnerBanker.classList.contains('result_tie_green')
            ) {
              const playerHandValue =
                document.querySelector('#playerHandValue')?.textContent || '0';
              const bankerHandValue =
                document.querySelector('#bankerHandValue')?.textContent || '0';
              return {
                hasResult: true,
                playerValue: playerHandValue,
                bankerValue: bankerHandValue,
                winner: 'Hòa',
              };
            }
            return { hasResult: false };
          });

          // Lần đầu có kết quả: gửi dự đoán vào group thật — TẮT
          if (currentResult.hasResult && !hasFirstResult) {
            hasFirstResult = true;
            lastResult = `${currentResult.winner}_${currentResult.playerValue}_${currentResult.bankerValue}`;

            await new Promise((resolve) => setTimeout(resolve, 2000));
            const randomValue = Math.random(); // 0.0 - 1.0
            if (randomValue <= 0.493) {
              prediction = 'TAY CON';
            } else {
              prediction = 'NHÀ CÁI';
            }

            if (this.shouldSendToNhomThat()) {
              const link = this.getPredictionLink(prediction);
              if (link) {
                await this.telegramService.forwardMessageFromLink(
                  link,
                  telegramConfig.gui_tin_nhan_vao_group_that,
                );
              } else {
                this.logger.log('⏭️ Thiếu link dự đoán, bỏ gửi nhóm thật');
              }
            } else {
              this.logger.log(
                '⏭️ Bỏ gửi dự đoán nhóm thật (chi_gui_nhom_ao=true)',
              );
            }
          }
          // Lần thứ 2 có kết quả: kiểm tra kết quả mới và so sánh với dự đoán
          else if (currentResult.hasResult && hasFirstResult) {
            const currentResultString = `${currentResult.winner}_${currentResult.playerValue}_${currentResult.bankerValue}`;

            // Chỉ xử lý nếu kết quả khác với kết quả trước đó
            if (currentResultString !== lastResult) {
              lastResult = currentResultString;
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
              const resultImagePath = `screenshots-result/that_${timestamp}.png`;
              try {
                // Tạo thư mục screenshots nếu chưa có
                if (!fs.existsSync('screenshots-result')) {
                  fs.mkdirSync('screenshots-result', { recursive: true });
                }

                // 🎯 Thay thế #gameMessage trước khi chụp ảnh
                const isDrawResult =
                  currentResult.winner?.toUpperCase() === 'HÒA';
                let isWin = false;

                if (isDrawResult) {
                  // Case HÒA: không thắng không thua
                  isWin = false;
                  // this.logger.log('🤝 Group thật: Kết quả HÒA +0');
                } else {
                  // Case CÁI/CON: So sánh prediction với kết quả
                  isWin =
                    prediction.toLowerCase() ===
                    currentResult.winner?.toLowerCase();
                  // this.logger.log(`🎯 Group thật: ${isWin ? 'WIN' : 'LOSE'}`);
                }

                // Tính toán amount text từ betAmount và odds trong config
                const amountText = this.calculateAmount(
                  isDrawResult,
                  isWin,
                  currentResult.winner,
                );

                // Set viewport và iframe về kích thước chuẩn trước khi chụp
                const RESULT_WIDTH = 1600;
                const RESULT_HEIGHT = 900;

                await page.setViewport({
                  width: RESULT_WIDTH,
                  height: RESULT_HEIGHT,
                  deviceScaleFactor: 1,
                });

                await page.evaluate(
                  (w, h) => {
                    const iframe = document.querySelector('iframe');
                    if (iframe) {
                      iframe.style.width = `${w}px`;
                      iframe.style.height = `${h}px`;
                      iframe.style.position = 'fixed';
                      iframe.style.top = '0';
                      iframe.style.left = '0';
                    }
                  },
                  RESULT_WIDTH,
                  RESULT_HEIGHT,
                );

                await frame.evaluate(() => {
                  window.scrollTo(0, 0);
                  document.body.style.zoom = '1';
                  document.body.style.transform = 'scale(1)';
                });

                await new Promise((resolve) => setTimeout(resolve, 500));

                // Tìm canvas element có id canvasElement trong iframe TRƯỚC
                const canvasBox = await frame.evaluate(() => {
                  const canvas = document.querySelector(
                    '#canvasElement',
                  ) as HTMLCanvasElement;
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

                // Sử dụng lock để đảm bảo chỉ 1 nhóm chụp ảnh tại một thời điểm
                this.screenshotLock = this.screenshotLock.then(async () => {
                  // Thay thế gameMessage ngay trước khi chụp ảnh để tránh bị ghi đè bởi nhóm kia
                  await this.replaceGameMessage(
                    frame,
                    isWin || isDrawResult,
                    amountText,
                  );

                  // Đợi một frame để canvas render (rút gọn để giảm timeout)
                  await frame.evaluate(() => {
                    void document.body.offsetHeight;
                    return new Promise<void>((resolve) => {
                      requestAnimationFrame(() => resolve());
                    });
                  });
                  await new Promise((resolve) => setTimeout(resolve, 200));

                  if (!canvasBox) {
                    this.logger.log(
                      '⚠️ Không tìm thấy canvasElement, chụp toàn bộ iframe',
                    );
                    await iframe.screenshot({
                      path: resultImagePath as `${string}.png`,
                      type: 'png',
                    });
                  } else {
                    const dpr = await frame.evaluate(
                      () => window.devicePixelRatio || 1,
                    );
                    const clipW = Math.floor(canvasBox.width * dpr);
                    const clipH = Math.floor(canvasBox.height * dpr);

                    this.logger.log(
                      `📐 Chụp canvas: x=${canvasBox.x}, y=${canvasBox.y}, w=${canvasBox.width}, h=${canvasBox.height}, dpr=${dpr}`,
                    );

                    if (clipW <= 0 || clipH <= 0) {
                      this.logger.log(
                        '⚠️ Kích thước canvas không hợp lệ (<=0), chụp toàn bộ iframe',
                      );
                      await iframe.screenshot({
                        path: resultImagePath as `${string}.png`,
                        type: 'png',
                      });
                    } else {
                      await iframe.screenshot({
                        path: resultImagePath as `${string}.png`,
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

                // Gửi ảnh qua Telegram vào group thật — TẮT
                try {
                  const resultLink = this.getResultLink(isDrawResult, isWin);

                  await new Promise((resolve) => setTimeout(resolve, 2000));

                  if (this.shouldSendToNhomThat()) {
                    await this.telegramService.sendPhoto(
                      telegramConfig.gui_tin_nhan_vao_group_that,
                      resultImagePath,
                    );
                    if (resultLink) {
                      await this.telegramService.forwardMessageFromLink(
                        resultLink,
                        telegramConfig.gui_tin_nhan_vao_group_that,
                      );
                    }
                    this.logger.log('📤 Đã gửi ảnh kết quả qua Telegram');
                  } else {
                    this.logger.log(
                      '⏭️ Bỏ gửi ảnh kết quả nhóm thật (chi_gui_nhom_ao=true)',
                    );
                  }

                  // Xác định kết quả để trả về
                  let gameResult: GameResult = 'HOA';
                  if (isDrawResult) {
                    gameResult = 'HOA';
                  } else {
                    gameResult = isWin ? 'WIN' : 'LOSE';
                  }
                  // Lưu lời/lỗ cho tổng kết ngày
                  this.lastRunProfit = isDrawResult
                    ? 0
                    : isWin
                      ? this.calculateWinAmount(currentResult.winner)
                      : -this.getBetAmount();

                  // Xóa ảnh sau khi gửi thành công
                  try {
                    if (fs.existsSync(resultImagePath)) {
                      fs.unlinkSync(resultImagePath);
                    }
                    this.logger.log(
                      '🗑️ Đã xóa ảnh kết quả sau khi gửi thành công',
                    );
                  } catch (deleteError) {
                    this.logger.error('❌ Lỗi xóa ảnh kết quả:', deleteError);
                  }

                  // Thoát khỏi vòng lặp và trả về kết quả
                  return gameResult;
                } catch (telegramError) {
                  this.logger.error('❌ Lỗi gửi Telegram:', telegramError);
                  // Xóa ảnh ngay cả khi lỗi để tránh tích tụ
                  try {
                    if (fs.existsSync(resultImagePath)) {
                      fs.unlinkSync(resultImagePath);
                    }
                  } catch (deleteError) {
                    // Ignore
                  }
                  return 'LOSE'; // Mặc định là LOSE nếu có lỗi
                }
              } catch (screenshotError) {
                this.logger.error('❌ Lỗi khi chụp ảnh:', screenshotError);
                // Xóa ảnh nếu đã được tạo
                try {
                  if (resultImagePath && fs.existsSync(resultImagePath)) {
                    fs.unlinkSync(resultImagePath);
                  }
                } catch (deleteError) {
                  // Ignore
                }
                return 'LOSE'; // Mặc định là LOSE nếu có lỗi
              }

              // Thoát khỏi vòng lặp để setTimeout có thể chạy
              return 'LOSE'; // Mặc định nếu không có kết quả
            }
          }
        } catch (error) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      // Nếu vòng lặp kết thúc mà không có return, trả về LOSE
      return 'LOSE';
    } catch (error) {
      this.logger.error('❌ Lỗi khi lắng nghe kết quả game:', error);
      // Đảm bảo đóng browser nếu có lỗi
      try {
        await this.closeBrowser();
      } catch (closeError) {
        this.logger.error('❌ Lỗi khi đóng browser:', closeError);
      }
      // Trả về LOSE nếu có lỗi
      return 'LOSE';
    }
  }

  async waitForGameResult_ao(page: puppeteer.Page): Promise<GameResult> {
    try {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      this.logger.log('🎮 Bắt đầu theo dõi kết quả (group ảo)...');
      // Tìm iframe có id iframeGame
      const iframe = await page.waitForSelector('#iframeGame', {
        timeout: 30000,
      });
      if (!iframe) {
        throw new Error('Không tìm thấy iframe iframeGame');
      }

      // Chuyển vào iframe
      const frame = await iframe.contentFrame();
      if (!frame) {
        throw new Error('Không thể truy cập vào iframe');
      }

      // Biến để theo dõi trạng thái
      let hasFirstResult = false;
      let lastResult = '';

      // Lắng nghe liên tục kết quả game với polling trong iframe
      while (true) {
        try {
          // Kiểm tra kết quả hiện tại
          const currentResult = await frame.evaluate(() => {
            const gameWinnerPlayer =
              document.querySelector('#gameWinnerPlayer');
            const gameWinnerBanker =
              document.querySelector('#gameWinnerBanker');

            if (!gameWinnerBanker || !gameWinnerPlayer) {
              throw new Error('Chưa vào được bàn Baccarat');
            }

            if (
              gameWinnerPlayer &&
              gameWinnerPlayer.classList.contains('result_win_blue')
            ) {
              const playerHandValue =
                document.querySelector('#playerHandValue')?.textContent || '0';
              const bankerHandValue =
                document.querySelector('#bankerHandValue')?.textContent || '0';
              return {
                hasResult: true,
                playerValue: playerHandValue,
                bankerValue: bankerHandValue,
                winner: 'Tay Con',
              };
            }
            if (
              gameWinnerBanker &&
              gameWinnerBanker.classList.contains('result_win_red')
            ) {
              const playerHandValue =
                document.querySelector('#playerHandValue')?.textContent || '0';
              const bankerHandValue =
                document.querySelector('#bankerHandValue')?.textContent || '0';
              return {
                hasResult: true,
                playerValue: playerHandValue,
                bankerValue: bankerHandValue,
                winner: 'Nhà Cái',
              };
            }
            if (
              gameWinnerBanker &&
              gameWinnerBanker.classList.contains('result_tie_green')
            ) {
              const playerHandValue =
                document.querySelector('#playerHandValue')?.textContent || '0';
              const bankerHandValue =
                document.querySelector('#bankerHandValue')?.textContent || '0';
              return {
                hasResult: true,
                playerValue: playerHandValue,
                bankerValue: bankerHandValue,
                winner: 'Hòa',
              };
            }
            return { hasResult: false };
          });

          // Lần đầu có kết quả: chỉ lưu
          if (currentResult.hasResult && !hasFirstResult) {
            hasFirstResult = true;
            lastResult = `${currentResult.winner}_${currentResult.playerValue}_${currentResult.bankerValue}`;

            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
          // Lần thứ 2 có kết quả: GIẢ BỘ DỰ ĐOÁN (nhưng đã biết kết quả)
          else if (currentResult.hasResult && hasFirstResult) {
            const currentResultString = `${currentResult.winner}_${currentResult.playerValue}_${currentResult.bankerValue}`;

            // Chỉ xử lý nếu kết quả khác với kết quả trước đó
            if (currentResultString !== lastResult) {
              lastResult = currentResultString;
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
              const resultImagePath = `screenshots-result/ao_${timestamp}.png`;
              let isDrawResult = false;
              let isWin = false;
              try {
                // Tạo thư mục screenshots nếu chưa có
                if (!fs.existsSync('screenshots-result')) {
                  fs.mkdirSync('screenshots-result', { recursive: true });
                }

                // 🎭 BƯỚC 1: Kiểm tra xem kết quả có phải HÒA không
                isDrawResult =
                  currentResult.winner?.toUpperCase() === 'HÒA';

                let prediction = '';
                isWin = false;

                if (isDrawResult) {
                  // ⚖️ Case HÒA: Random dự đoán CÁI/CON nhưng kết quả vẫn là HÒA +0
                  this.logger.log(
                    '🤝 Group ảo: Kết quả HÒA - không thắng không thua',
                  );
                  prediction = Math.random() < 0.5 ? 'NHÀ CÁI' : 'TAY CON';
                  isWin = false;
                } else {
                  // 🎲 Case CÁI/CON: Áp dụng tỉ lệ win 85%, lose 15%
                  this.logger.log(
                    '🎲 Group ảo: Tính toán prediction (tỉ lệ win 85%)...',
                  );

                  const randomValue = Math.random();
                  const shouldWin = randomValue < 0.85;

                  if (shouldWin) {
                    // 85%: Dự đoán đúng = kết quả
                    if (currentResult.winner?.toUpperCase() === 'NHÀ CÁI') {
                      prediction = 'NHÀ CÁI';
                    } else {
                      prediction = 'TAY CON';
                    }
                    this.logger.log('✅ Group ảo: Sẽ dự đoán đúng (85%)');
                  } else {
                    // 15%: Dự đoán sai = ngược lại
                    if (currentResult.winner?.toUpperCase() === 'NHÀ CÁI') {
                      prediction = 'TAY CON';
                    } else {
                      prediction = 'NHÀ CÁI';
                    }
                    this.logger.log('❌ Group ảo: Sẽ dự đoán sai (15%)');
                  }

                  // Tính isWin
                  isWin =
                    prediction.toUpperCase() ===
                    currentResult.winner?.toUpperCase();
                }

                // Tính toán amount text từ betAmount và odds trong config (group ảo)
                const amountText = this.calculateAmount(
                  isDrawResult,
                  isWin,
                  currentResult.winner,
                  true,
                );

                this.logger.log(
                  `🎯 Group ảo: prediction="${prediction}", #gameMessage ${isDrawResult ? 'HÒA' : isWin ? 'WIN' : 'LOSE'} ${amountText}`,
                );
                // Lưu lời/lỗ group ảo cho tổng kết ngày (dùng gameBetConfigAo)
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

                // 🎭 BƯỚC 2: Chụp ảnh kết quả TRƯỚC (để có ảnh sẵn)
                this.logger.log('📸 Group ảo: Chụp ảnh kết quả trước...');

                // Set viewport và iframe về kích thước chuẩn trước khi chụp
                const RESULT_WIDTH = 1600;
                const RESULT_HEIGHT = 900;

                await page.setViewport({
                  width: RESULT_WIDTH,
                  height: RESULT_HEIGHT,
                  deviceScaleFactor: 1,
                });

                await page.evaluate(
                  (w, h) => {
                    const iframe = document.querySelector('iframe');
                    if (iframe) {
                      iframe.style.width = `${w}px`;
                      iframe.style.height = `${h}px`;
                      iframe.style.position = 'fixed';
                      iframe.style.top = '0';
                      iframe.style.left = '0';
                    }
                  },
                  RESULT_WIDTH,
                  RESULT_HEIGHT,
                );

                await frame.evaluate(() => {
                  window.scrollTo(0, 0);
                  document.body.style.zoom = '1';
                  document.body.style.transform = 'scale(1)';
                });

                await new Promise((resolve) => setTimeout(resolve, 500));

                // Tìm canvas element có id canvasElement trong iframe TRƯỚC
                const canvasBox = await frame.evaluate(() => {
                  const canvas = document.querySelector(
                    '#canvasElement',
                  ) as HTMLCanvasElement;
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

                // Sử dụng lock để đảm bảo chỉ 1 nhóm chụp ảnh tại một thời điểm
                this.screenshotLock = this.screenshotLock.then(async () => {
                  // Thay thế gameMessage ngay trước khi chụp ảnh để tránh bị ghi đè bởi nhóm kia
                  await this.replaceGameMessage(
                    frame,
                    isWin || isDrawResult,
                    amountText,
                  );

                  // Đợi một frame để canvas render (rút gọn để giảm timeout)
                  await frame.evaluate(() => {
                    void document.body.offsetHeight;
                    return new Promise<void>((resolve) => {
                      requestAnimationFrame(() => resolve());
                    });
                  });
                  await new Promise((resolve) => setTimeout(resolve, 200));

                  if (!canvasBox) {
                    this.logger.log(
                      '⚠️ Không tìm thấy canvasElement, chụp toàn bộ iframe',
                    );
                    await iframe.screenshot({
                      path: resultImagePath as `${string}.png`,
                      type: 'png',
                    });
                  } else {
                    const dpr = await frame.evaluate(
                      () => window.devicePixelRatio || 1,
                    );
                    const clipW = Math.floor(canvasBox.width * dpr);
                    const clipH = Math.floor(canvasBox.height * dpr);

                    this.logger.log(
                      `📐 Chụp canvas (ảo): x=${canvasBox.x}, y=${canvasBox.y}, w=${canvasBox.width}, h=${canvasBox.height}, dpr=${dpr}`,
                    );

                    if (clipW <= 0 || clipH <= 0) {
                      this.logger.log(
                        '⚠️ Kích thước canvas không hợp lệ (<=0), chụp toàn bộ iframe',
                      );
                      await iframe.screenshot({
                        path: resultImagePath as `${string}.png`,
                        type: 'png',
                      });
                    } else {
                      await iframe.screenshot({
                        path: resultImagePath as `${string}.png`,
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

                // 🎭 BƯỚC 4: Gửi tin nhắn dự đoán (group ảo – dùng gameBetConfigAo)
                this.logger.log('🎭 Group ảo: Gửi tin nhắn dự đoán...');

                let aoPrediction = prediction.toUpperCase();
                if (!aoPrediction.includes('CÁI') && !aoPrediction.includes('CON')) {
                  aoPrediction = Math.random() < 0.5 ? 'CÁI' : 'CON';
                  this.logger.log(
                    `⚠️ Group ảo: Prediction không rõ ràng (${prediction}), dùng fallback`,
                  );
                }

                try {
                  const link = this.getPredictionLink(aoPrediction);
                  if (link) {
                    await this.forwardMessageToGroupAo(link);
                    this.logger.log('✅ Group ảo: Đã gửi tin nhắn dự đoán');
                  } else {
                    this.logger.log('⏭️ Group ảo: Thiếu link dự đoán, bỏ gửi');
                  }
                } catch (predictionError) {
                  this.logger.error(
                    '❌ Lỗi gửi dự đoán (ảo):',
                    predictionError,
                  );
                }

                // 🎭 BƯỚC 5: Đợi 15 giây (giả bộ đợi kết quả)
                this.logger.log(
                  '⏳ Group ảo: Đợi 15 giây trước khi gửi kết quả...',
                );
                await new Promise((resolve) => setTimeout(resolve, 15000));

                const resultLink = this.getResultLink(isDrawResult, isWin);

                // 🎭 BƯỚC 7: Gửi ảnh kết quả qua Telegram vào group ảo
                try {
                  await this.sendPhotoToGroupAo(resultImagePath);
                  if (resultLink) {
                    await this.forwardMessageToGroupAo(resultLink);
                  } else {
                    this.logger.log('⏭️ Group ảo: Thiếu link kết quả, bỏ gửi');
                  }
                  this.logger.log('📤 Group ảo: Đã gửi ảnh kết quả (sau 20s)');

                  // Xóa ảnh sau khi gửi thành công
                  try {
                    if (fs.existsSync(resultImagePath)) {
                      fs.unlinkSync(resultImagePath);
                    }
                    this.logger.log(
                      '🗑️ Đã xóa ảnh kết quả sau khi gửi thành công',
                    );
                  } catch (deleteError) {
                    this.logger.error('❌ Lỗi xóa ảnh kết quả:', deleteError);
                  }
                } catch (telegramError) {
                  this.logger.error('❌ Lỗi gửi Telegram:', telegramError);
                  // Xóa ảnh ngay cả khi lỗi để tránh tích tụ
                  try {
                    if (fs.existsSync(resultImagePath)) {
                      fs.unlinkSync(resultImagePath);
                    }
                  } catch (deleteError) {
                    // Ignore
                  }
                }
              } catch (screenshotError) {
                this.logger.error('❌ Lỗi khi chụp ảnh:', screenshotError);
                // Xóa ảnh nếu đã được tạo
                try {
                  if (resultImagePath && fs.existsSync(resultImagePath)) {
                    fs.unlinkSync(resultImagePath);
                  }
                } catch (deleteError) {
                  // Ignore
                }
              }

              // Thoát khỏi vòng lặp — trả về đúng kết quả (85% win đã xử lý trong logic)
              if (isDrawResult) return 'HOA';
              return isWin ? 'WIN' : 'LOSE';
            }
          }
        } catch (error) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } catch (error) {
      this.logger.error('❌ Lỗi khi lắng nghe kết quả game (group ảo):', error);
      // Đảm bảo đóng browser nếu có lỗi
      try {
        await this.closeBrowser();
      } catch (closeError) {
        this.logger.error('❌ Lỗi khi đóng browser:', closeError);
      }
      throw error;
    }
  }

  getLastRunProfit(): number {
    return this.lastRunProfit;
  }

  getLastGameResult_that(): GameResult | null {
    return this.lastGameResult_that;
  }

  getLastRunProfit_ao(): number {
    return this.lastRunProfit_ao;
  }

  getLastGameResult_ao(): GameResult | null {
    return this.lastGameResult_ao;
  }

  async runBaccaratAuto(): Promise<void> {
    try {
      this.logger.log('🎯 Bắt đầu chạy Baccarat auto...');
      this.lastRunProfit = 0;
      this.lastGameResult_that = null;
      this.lastRunProfit_ao = 0;
      this.lastGameResult_ao = null;
      this.currentSessionCa = null;

      await this.closeBrowser();
      this.logger.log('✅ STEP 1: Đã đóng browser cũ');

      const page = await this.openPage(telegramConfig.url_site);
      this.logger.log('✅ STEP 2: Đã mở page');

      await this.login(
        page,
        telegramConfig.username_site,
        telegramConfig.password_site,
      );
      this.logger.log('✅ STEP 3: Đã đăng nhập xong - Chuẩn bị tìm SEXYBCRT');

      // Đợi thêm sau khi đăng nhập để page ổn định
      this.logger.log('⏳ STEP 4: Đợi 2 giây trước khi tìm SEXYBCRT...');
      await new Promise((resolve) => setTimeout(resolve, 2000));

      this.logger.log('🔍 STEP 5: Bắt đầu gọi navigateToSexyBaccarat()...');
      const newPage = await this.navigateToSexyBaccarat(page);
      this.logger.log(`✅ STEP 6: Đã lấy được page mới: ${newPage.url()}`);

      // Chỉ bắt đầu gửi tin sau khi xác nhận đã có iframe game.
      await this.waitForGameIframeReady(newPage);
      this.logger.log('✅ STEP 6.5: Đã thấy iframe game, bắt đầu gửi tin');

      // Forward tin nhắn bắt đầu trước khi chọn bàn
      this.logger.log('📤 STEP 7: Gửi tin nhắn bắt đầu...');
      try {
        if (telegramConfig.link_forward_tin_nhan_bat_dau) {
          const tasks: Promise<unknown>[] = [];
          tasks.push(
            this.forwardMessageToGroupAo(
              telegramConfig.link_forward_tin_nhan_bat_dau_ao,
            ).catch((err) => {
              this.logger.log(
                `⚠️ Lỗi gửi Telegram bắt đầu (group ảo) - Bỏ qua: ${err}`,
              );
            }),
          );
          if (this.shouldSendToNhomThat()) {
            tasks.push(
              this.telegramService
                .forwardMessageFromLink(
                  telegramConfig.link_forward_tin_nhan_bat_dau,
                  telegramConfig.gui_tin_nhan_vao_group_that,
                )
                .catch((err) => {
                  this.logger.log(
                    `⚠️ Lỗi gửi Telegram bắt đầu (group thật) - Bỏ qua: ${err}`,
                  );
                }),
            );
          } else {
            this.logger.log(
              '⏭️ Bỏ gửi tin bắt đầu nhóm thật (chi_gui_nhom_ao=true)',
            );
          }
          await Promise.all(tasks);
        }

        // Ngay sau tin bắt đầu: forward tin lệnh theo ca (index = ca - 1 trong mảng)
        const cfg = telegramConfig as Record<string, unknown>;
        const soCaCfg = Math.max(
          0,
          Math.floor(Number(cfg.so_ca) || 0),
        );
        const lenCaLinks = cfg.link_forward_tin_nhan_len_ca;
        if (
          soCaCfg > 0 &&
          Array.isArray(lenCaLinks) &&
          lenCaLinks.length > 0
        ) {
          const effectiveSoCa = Math.min(soCaCfg, lenCaLinks.length);
          if (effectiveSoCa < soCaCfg) {
            this.logger.log(
              `⚠️ link_forward_tin_nhan_len_ca chỉ có ${lenCaLinks.length} phần tử — dùng tối đa ${effectiveSoCa} ca`,
            );
          }
          // Luôn đọc từ disk: telegramConfig chỉ parse 1 lần khi import — cron sẽ không thấy sửa tay.
          const overrideCa = readSessionCaOverrideFromConfigFile();
          const sessionCa =
            overrideCa > 0
              ? Math.min(Math.max(1, overrideCa), effectiveSoCa)
              : getSessionCa(effectiveSoCa);
          this.currentSessionCa = sessionCa;
          if (overrideCa > 0) {
            this.logger.log(
              `📌 session_ca_override=${overrideCa} (từ config.json) → ca ${sessionCa}/${effectiveSoCa}; sau OK về 0`,
            );
          }
          const linkRaw = lenCaLinks[sessionCa - 1];
          const linkLen =
            typeof linkRaw === 'string' ? linkRaw.trim() : String(linkRaw ?? '').trim();
          if (linkLen) {
            this.logger.log(
              `📤 Forward tin lệnh ca ${sessionCa}/${effectiveSoCa} (index ${sessionCa - 1})...`,
            );
            const tasks: Promise<unknown>[] = [];
            tasks.push(
              this.forwardMessageToGroupAo(linkLen).catch((err) => {
                this.logger.log(
                  `⚠️ Lỗi forward lệnh ca (group ảo) - Bỏ qua: ${err}`,
                );
              }),
            );
            if (this.shouldSendToNhomThat()) {
              tasks.push(
                this.telegramService
                  .forwardMessageFromLink(
                    linkLen,
                    telegramConfig.gui_tin_nhan_vao_group_that,
                  )
                  .catch((err) => {
                    this.logger.log(
                      `⚠️ Lỗi forward lệnh ca (group thật) - Bỏ qua: ${err}`,
                    );
                  }),
              );
            } else {
              this.logger.log(
                '⏭️ Bỏ forward lệnh ca nhóm thật (chi_gui_nhom_ao=true)',
              );
            }
            await Promise.all(tasks);
            if (overrideCa > 0) {
              resetSessionCaOverrideInConfig();
              this.logger.log(
                '✅ Đã đặt session_ca_override về 0 trong config.json',
              );
            }
            this.logger.log(
              `✅ Đã gửi tin lệnh ca ${sessionCa}/${effectiveSoCa}`,
            );
          } else {
            this.logger.log(
              `⚠️ link_forward_tin_nhan_len_ca[${sessionCa - 1}] trống — bỏ qua`,
            );
          }
        }
      } catch (telegramError) {
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
        upsertCaProfitToday('that', caForSheet, this.lastRunProfit);
        upsertCaProfitToday('ao', caForSheet, this.lastRunProfit_ao);
      }

      if (isGoogleSheetConfigured()) {
        try {
          await Promise.all([
            appendCaProfitToGoogleSheet('that', this.lastRunProfit, caForSheet),
            appendCaProfitToGoogleSheet('ao', this.lastRunProfit_ao, caForSheet),
          ]);
          this.logger.log(
            `✅ Đã ghi số tiền ca lên Google Sheet (tab Thật + Ảo)${caForSheet ? ` - CA ${caForSheet}` : ''}`,
          );
        } catch (e) {
          this.logger.log(`⚠️ Lỗi ghi Google Sheet - bỏ qua: ${e}`);
        }
      }

      this.logger.log('✅ STEP 11: Đã hoàn thành theo dõi game');
      await this.closeBrowser();

      this.logger.log('📤 STEP 12: Gửi tin nhắn kết thúc ca...');
      // Gửi tin nhắn kết thúc dựa trên kết quả
      if (telegramConfig.link_forward_lenh_ket_thuc) {
        const tasks: Promise<unknown>[] = [];
        tasks.push(
          this.forwardMessageToGroupAo(
            telegramConfig.link_forward_lenh_ket_thuc,
          ),
        );
        if (this.shouldSendToNhomThat()) {
          tasks.push(
            this.telegramService.forwardMessageFromLink(
              telegramConfig.link_forward_lenh_ket_thuc,
              telegramConfig.gui_tin_nhan_vao_group_that,
            ),
          );
        } else {
          this.logger.log(
            '⏭️ Bỏ gửi lệnh kết thúc nhóm thật (chi_gui_nhom_ao=true)',
          );
        }
        void Promise.all(tasks);
       }
      if (telegramConfig.link_forward_tin_nhan_ket_thuc_ca) {
        // WIN hoặc HÒA → ket_thuc_ca, Thua → ket_thuc_ca_2
        const endLinkThat =
        gameResult_that === 'LOSE'
            ? (telegramConfig.link_forward_tin_nhan_ket_thuc_ca_2 ||
                telegramConfig.link_forward_tin_nhan_ket_thuc_ca)
            : telegramConfig.link_forward_tin_nhan_ket_thuc_ca;
        const endLinkAo =
        gameResult_ao === 'LOSE'
            ? (telegramConfig.link_forward_tin_nhan_ket_thuc_ca_2 ||
                telegramConfig.link_forward_tin_nhan_ket_thuc_ca)
            : telegramConfig.link_forward_tin_nhan_ket_thuc_ca;
        this.logger.log(
          `📤 Kết quả: ${gameResult_that} → Forward link: ${endLinkThat === 'LOSE' ? 'ket_thuc_ca_2' : 'ket_thuc_ca'}`,
        );

        const tasks: Promise<unknown>[] = [];
        tasks.push(this.forwardMessageToGroupAo(endLinkAo));
        if (this.shouldSendToNhomThat()) {
          tasks.push(
            this.telegramService.forwardMessageFromLink(
              endLinkThat,
              telegramConfig.gui_tin_nhan_vao_group_that,
            ),
          );
        } else {
          this.logger.log(
            '⏭️ Bỏ gửi kết thúc ca nhóm thật (chi_gui_nhom_ao=true)',
          );
        }
        await Promise.all(tasks);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Gửi tin nhắn tổng kết sau khi đã gửi kết thúc ca (cho cả 2 nhóm)
      if (telegramConfig.link_forward_tin_nhan_tong_ket) {
        const tongKetLink = telegramConfig.link_forward_tin_nhan_tong_ket.trim();
        const tongKetLinkThat = telegramConfig.link_forward_tin_nhan_tong_ket_that.trim();
        if (tongKetLink !== '') {
          const mediaRaw = String(
            (telegramConfig as any).tong_ket_media_path ?? '',
          ).trim();
          const mediaPath = mediaRaw
            ? path.isAbsolute(mediaRaw)
              ? mediaRaw
              : path.join(process.cwd(), mediaRaw)
            : '';

          // Nhóm thật: giữ nguyên tin gốc từ link tổng kết (không build).
          if (this.shouldSendToNhomThat()) {
            await this.telegramService.forwardMessageFromLink(
              tongKetLinkThat,
              telegramConfig.gui_tin_nhan_vao_group_that,
            );
          } else {
            this.logger.log(
              '⏭️ Bỏ gửi tổng kết nhóm thật (chi_gui_nhom_ao=true)',
            );
          }

          // Nhóm ảo: gửi bản tổng kết tự build.
          for (const gid of this.getGroupAoIds()) {
            if (mediaPath && fs.existsSync(mediaPath)) {
              try {
                await this.telegramService.sendEditedPhotoCaptionFromLink(
                  tongKetLink,
                  gid,
                  mediaPath,
                  (text: string) => this.editTongKetCaLines(text, 'ao'),
                );
              } catch (e) {
                this.logger.log(
                  `⚠️ Gửi tổng kết dạng ảnh lỗi — fallback sang text: ${e}`,
                );
                await this.telegramService.sendEditedMessageFromLink(
                  tongKetLink,
                  gid,
                  (text: string) => this.editTongKetCaLines(text, 'ao'),
                );
              }
            } else {
              await this.telegramService.sendEditedMessageFromLink(
                tongKetLink,
                gid,
                (text: string) => this.editTongKetCaLines(text, 'ao'),
              );
            }
          }
        }
      }

      // Gửi các tin nhắn phụ sau khi gửi tin nhắn kết thúc ca
      if (
        telegramConfig.link_forward_tin_nhan_phu &&
        Array.isArray(telegramConfig.link_forward_tin_nhan_phu) &&
        telegramConfig.link_forward_tin_nhan_phu.length > 0
      ) {
        this.logger.log(
          `📤 Gửi ${telegramConfig.link_forward_tin_nhan_phu.length} tin nhắn phụ...`,
        );
        for (const phuLink of telegramConfig.link_forward_tin_nhan_phu) {
          if (phuLink && phuLink.trim() !== '') {
            const tasks: Promise<unknown>[] = [];
            tasks.push(this.forwardMessageToGroupAo(phuLink));
            if (this.shouldSendToNhomThat()) {
              tasks.push(
                this.telegramService.forwardMessageFromLink(
                  phuLink,
                  telegramConfig.gui_tin_nhan_vao_group_that,
                ),
              );
            } else {
              this.logger.log(
                '⏭️ Bỏ gửi tin phụ nhóm thật (chi_gui_nhom_ao=true)',
              );
            }
            await Promise.all(tasks);
            // Delay 1 giây giữa các tin nhắn
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        this.logger.log('✅ Đã gửi xong tất cả tin nhắn phụ');
      }
      if (telegramConfig.link_forward_tin_nhan_lich_ca) {
        const tasks: Promise<unknown>[] = [];
        tasks.push(
          this.forwardMessageToGroupAo(
            telegramConfig.link_forward_tin_nhan_lich_ca,
          ),
        );
        if (this.shouldSendToNhomThat()) {
          tasks.push(
            this.telegramService.forwardMessageFromLink(
              telegramConfig.link_forward_tin_nhan_lich_ca,
              telegramConfig.gui_tin_nhan_vao_group_that,
            ),
          );
        } else {
          this.logger.log(
            '⏭️ Bỏ gửi lịch ca nhóm thật (chi_gui_nhom_ao=true)',
          );
        }
        await Promise.all(tasks);
      }
      

      // Bỏ xóa ảnh sảnh: không còn chụp sảnh nữa.

      this.logger.log('🎉 HOÀN THÀNH TẤT CẢ!');
    } catch (error) {
      this.logger.error('❌ LỖI tại một step nào đó:', error);
      this.logger.error('Stack trace:', error?.stack);
      this.logger.error('Error message:', error?.message);
      try {
        await this.closeBrowser();
      } catch (closeError) {
        this.logger.error('❌ Lỗi khi đóng browser sau lỗi:', closeError);
      }
      throw error;
    }
  }
}
