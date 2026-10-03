import * as fs from 'fs';
import * as path from 'path';
import type * as puppeteer from 'puppeteer';

const TOOLCASINO_ASSETS = path.join(process.cwd(), 'ToolCasino', 'assets');

function readDataUrl(fileName: string, mime: string): string | null {
  const abs = path.join(TOOLCASINO_ASSETS, fileName);
  try {
    if (!fs.existsSync(abs)) return null;
    const buf = fs.readFileSync(abs);
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/** SVG nhỏ khi chưa có robot.webp */
const FALLBACK_ROBOT_SVG = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 200" width="150" height="250">
    <rect fill="#2a2a3e" width="120" height="200" rx="16"/>
    <circle cx="60" cy="55" r="28" fill="#6cf"/>
    <rect x="35" y="95" width="50" height="60" rx="8" fill="#889"/>
    <rect x="25" y="108" width="18" height="40" rx="4" fill="#889"/>
    <rect x="77" y="108" width="18" height="40" rx="4" fill="#889"/>
    <text x="60" y="185" text-anchor="middle" fill="#fff" font-size="14" font-family="sans-serif">Tool</text>
  </svg>`,
)}`;

export type ToolcasinoOverlayInjectOptions = {
  /** Nội dung ban đầu trong bong bóng (plain text) */
  initialText?: string;
};

/**
 * Inject UI giống extension ToolCasino (content.js): robot kéo thả + bong bóng chữ neon.
 * Ảnh lấy từ ToolCasino/assets (robot.webp, nen111.webp) dạng data URL để chạy trên mọi origin.
 */
export async function injectToolCasinoOverlay(
  page: puppeteer.Page,
  options?: ToolcasinoOverlayInjectOptions,
): Promise<void> {
  const robotSrc =
    readDataUrl('robot.webp', 'image/webp') ??
    readDataUrl('robot.png', 'image/png') ??
    FALLBACK_ROBOT_SVG;
  const bubbleSrc =
    readDataUrl('nen111.webp', 'image/webp') ??
    readDataUrl('nen111.png', 'image/png');

  const fontTtf = path.join(TOOLCASINO_ASSETS, 'UTM-Akashi.ttf');
  let fontFaceBlock = '';
  try {
    if (fs.existsSync(fontTtf)) {
      const b64 = fs.readFileSync(fontTtf).toString('base64');
      fontFaceBlock = `@font-face{font-family:'UTM Akashi';src:url(data:font/ttf;base64,${b64}) format('truetype');font-weight:normal;font-style:normal;}`;
    }
  } catch {
    /* bỏ qua font tùy chọn */
  }

  const initialText = options?.initialText ?? 'Đang Phân Tích';

  await page.evaluate(
    (opts: {
      robotSrc: string;
      bubbleSrc: string | null;
      initialText: string;
      fontFaceBlock: string;
    }) => {
      document.getElementById('toolcasino-overlay-style')?.remove();
      document.getElementById('prediction-drag-box')?.remove();

      const style = document.createElement('style');
      style.id = 'toolcasino-overlay-style';
      const bubbleCss = opts.bubbleSrc
        ? `#prediction-drag-box .chat_bubble { position: absolute; width: 100%; height: 100%; z-index: -1; object-fit: contain; }`
        : `#prediction-drag-box .chat_bubble {
            position: absolute; width: 100%; height: 100%; z-index: -1;
            border-radius: 24px;
            background: linear-gradient(145deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
            box-shadow: 0 0 20px rgba(255,32,32,0.35), inset 0 0 30px rgba(255,255,255,0.06);
          }`;

      style.textContent = `
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&display=swap');
        ${opts.fontFaceBlock}
        #prediction-drag-box {
          position: fixed;
          z-index: 2147483646;
          cursor: move;
          display: flex;
          align-items: center;
          font-size: 16px;
          pointer-events: auto;
        }
        #prediction-drag-box .robot {
          width: 150px;
          height: 250px;
          margin-right: 12px;
          user-select: none;
        }
        #prediction-drag-box .content {
          display: block;
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
        }
        #prediction-drag-box .content > div {
          box-sizing: border-box;
          padding: 24px;
          height: 200px;
          width: 350px;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          position: relative;
        }
        ${bubbleCss}
        #prediction-drag-box .chat_bubble_text {
          width: 100%;
          max-width: 100%;
          text-align: center;
          font-size: 18px;
          font-weight: 600;
          font-family: 'Orbitron', 'UTM Akashi', sans-serif;
          color: #FF2020;
          text-shadow: 0 0 6px #FF2020, 0 0 14px #FF2020, 0 0 30px #CC0000;
          animation: toolcasino-blink-glow 1.2s ease-in-out infinite;
          margin: 0;
          white-space: pre-wrap;
          word-break: break-word;
        }
        @keyframes toolcasino-blink-glow {
          0%, 100% { opacity: 1; text-shadow: 0 0 6px #FF2020, 0 0 14px #FF2020, 0 0 30px #CC0000; }
          50% { opacity: 0.35; text-shadow: 0 0 2px #FF2020, 0 0 6px #CC0000; }
        }
      `;
      document.head.appendChild(style);

      const box = document.createElement('div');
      box.id = 'prediction-drag-box';
      const bubbleHtml = opts.bubbleSrc
        ? `<img src="${opts.bubbleSrc.replace(/"/g, '&quot;')}" draggable="false" class="chat_bubble" alt="" />`
        : `<div class="chat_bubble" aria-hidden="true"></div>`;
      box.innerHTML = `
        <img src="${opts.robotSrc.replace(/"/g, '&quot;')}" draggable="false" class="robot" alt="" />
        <div class="content">
          ${bubbleHtml}
          <div>
            <p id="chat_bubble_text" class="chat_bubble_text"></p>
          </div>
        </div>
      `;
      document.body.appendChild(box);

      /* Căn trái; trục dọc: tâm cụm ~26% viewport (cao hơn so với 40%). */
      const placeBoxLeftElevated = () => {
        const ih = window.innerHeight;
        const h = box.offsetHeight || 280;
        const anchorY = 0.26;
        box.style.left = '8px';
        box.style.top = `${Math.max(8, Math.round(ih * anchorY - h / 2))}px`;
      };
      placeBoxLeftElevated();
      requestAnimationFrame(() => placeBoxLeftElevated());

      const textEl = box.querySelector('#chat_bubble_text');
      if (textEl) {
        textEl.textContent = opts.initialText;
      }

      const content = box.querySelector('.content') as HTMLElement;
      content.style.left = '150px';
      content.style.right = 'auto';

      let isShown = true;
      const updateContentVisibility = () => {
        content.style.display = isShown ? 'block' : 'none';
      };
      updateContentVisibility();

      let isDragging = false;
      let pos = { top: 0, left: 0, x: 0, y: 0 };

      const dragMove = (clientX: number, clientY: number) => {
        isDragging = true;
        const dx = clientX - pos.x;
        const dy = clientY - pos.y;
        let newLeft = pos.left + dx;
        let newTop = pos.top + dy;
        const boxWidth = box.offsetWidth;
        const boxHeight = box.offsetHeight;
        const screenWidth = window.innerWidth;
        const screenHeight = window.innerHeight;
        newLeft = Math.max(0, Math.min(screenWidth - boxWidth, newLeft));
        newTop = Math.max(0, Math.min(screenHeight - boxHeight, newTop));
        box.style.left = `${newLeft}px`;
        box.style.top = `${newTop}px`;
        const boxLeft = box.offsetLeft;
        if (boxLeft < screenWidth / 2) {
          content.style.left = '150px';
          content.style.right = 'auto';
        } else {
          content.style.right = '150px';
          content.style.left = 'auto';
        }
      };

      const mouseDownHandler = (e: MouseEvent) => {
        e.preventDefault();
        pos = {
          left: box.offsetLeft,
          top: box.offsetTop,
          x: e.clientX,
          y: e.clientY,
        };
        document.addEventListener('mousemove', mouseMoveHandler);
        document.addEventListener('mouseup', mouseUpHandler);
      };
      const mouseMoveHandler = (e: MouseEvent) => {
        e.preventDefault();
        dragMove(e.clientX, e.clientY);
      };
      const mouseUpHandler = (e: MouseEvent) => {
        e.preventDefault();
        setTimeout(() => {
          isDragging = false;
        }, 200);
        document.removeEventListener('mousemove', mouseMoveHandler);
        document.removeEventListener('mouseup', mouseUpHandler);
      };

      const touchStartHandler = (e: TouchEvent) => {
        e.preventDefault();
        const touch = e.touches[0];
        pos = {
          left: box.offsetLeft,
          top: box.offsetTop,
          x: touch.clientX,
          y: touch.clientY,
        };
        document.addEventListener('touchmove', touchMoveHandler, { passive: false });
        document.addEventListener('touchend', touchEndHandler);
      };
      const touchMoveHandler = (e: TouchEvent) => {
        e.preventDefault();
        const touch = e.touches[0];
        dragMove(touch.clientX, touch.clientY);
      };
      const touchEndHandler = (e: TouchEvent) => {
        e.preventDefault();
        setTimeout(() => {
          isDragging = false;
        }, 200);
        document.removeEventListener('touchmove', touchMoveHandler);
        document.removeEventListener('touchend', touchEndHandler);
      };

      box.addEventListener('mousedown', mouseDownHandler);
      box.addEventListener('touchstart', touchStartHandler, { passive: false });

      const robotImage = box.querySelector('.robot');
      robotImage?.addEventListener('load', () => placeBoxLeftElevated());
      robotImage?.addEventListener('click', () => {
        if (!isDragging) {
          isShown = !isShown;
          updateContentVisibility();
        }
      });

      (window as unknown as { __toolcasinoSetText?: (t: string) => void }).__toolcasinoSetText = (
        t: string,
      ) => {
        const el = document.querySelector('#chat_bubble_text');
        if (el) el.textContent = t;
      };
    },
    {
      robotSrc,
      bubbleSrc,
      initialText,
      fontFaceBlock,
    },
  );
}

export async function updateToolCasinoOverlayText(
  page: puppeteer.Page,
  text: string,
): Promise<void> {
  await page.evaluate((t) => {
    const fn = (window as unknown as { __toolcasinoSetText?: (x: string) => void })
      .__toolcasinoSetText;
    if (fn) fn(t);
    else {
      const el = document.querySelector('#chat_bubble_text');
      if (el) el.textContent = t;
    }
  }, text);
}

export async function removeToolCasinoOverlay(
  page: puppeteer.Page,
): Promise<void> {
  await page.evaluate(() => {
    delete (window as unknown as { __toolcasinoSetText?: unknown }).__toolcasinoSetText;
    document.getElementById('toolcasino-overlay-style')?.remove();
    document.getElementById('prediction-drag-box')?.remove();
  });
}
