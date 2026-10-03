import type * as puppeteer from 'puppeteer';
export type ToolcasinoOverlayInjectOptions = {
    initialText?: string;
};
export declare function injectToolCasinoOverlay(page: puppeteer.Page, options?: ToolcasinoOverlayInjectOptions): Promise<void>;
export declare function updateToolCasinoOverlayText(page: puppeteer.Page, text: string): Promise<void>;
export declare function removeToolCasinoOverlay(page: puppeteer.Page): Promise<void>;
