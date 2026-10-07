// Unread state on the browser tab itself: a count in the title, a dot on the
// favicon, and an app badge when the app is installed. Driven by the chat
// store, so it changes the moment a message arrives over the socket, even
// while the tab is in the background.

import { ChatRecord } from '@/lib/db';

const FALLBACK_TITLE = 'WebBubbles';
/** The artwork the favicon is drawn from; the .ico can't be relied on to decode everywhere. */
const ICON_SOURCE = '/icon-192x192.png';
const ICON_SIZE = 64;
const DOT_COLOR = '#ef4444';
const COUNT_PREFIX = /^\(\d+\) /;

/** How many chats have something unread. */
export function countUnread(chats: ChatRecord[]): number {
  let n = 0;
  for (const chat of chats) if (chat.hasUnreadMessage) n++;
  return n;
}

export function stripCount(title: string): string {
  return title.replace(COUNT_PREFIX, '');
}

export function formatTitle(unread: number, base: string): string {
  return unread > 0 ? `(${unread}) ${base}` : base;
}

/**
 * The app icon with a dot in its corner, as a data URL.
 *
 * Decoded with createImageBitmap rather than an <img>: image decoding tied to
 * rendering can stall while the tab is hidden, which is exactly when this
 * runs.
 */
async function drawDotIcon(): Promise<string | null> {
  const res = await fetch(ICON_SOURCE);
  if (!res.ok) return null;
  const bitmap = await createImageBitmap(await res.blob());

  const canvas = document.createElement('canvas');
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, ICON_SIZE, ICON_SIZE);
  bitmap.close();

  // Top-right corner, ringed in white so it reads on both light and dark tab bars
  const radius = ICON_SIZE * 0.2;
  const cx = ICON_SIZE - radius - 2;
  const cy = radius + 2;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = DOT_COLOR;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  return canvas.toDataURL('image/png');
}

/** The favicon as the page declared it, so it can be put back. */
interface SavedIcon {
  href: string;
  type: string | null;
}

export class TabIndicator {
  private unread = 0;
  private base: string | null = null;
  private dotIcon: Promise<string | null> | null = null;
  private dotUrl: string | null = null;
  private saved: SavedIcon | null = null;
  private observer: MutationObserver | null = null;

  constructor(private readonly drawIcon: () => Promise<string | null> = drawDotIcon) {}

  /** Reflect this many unread chats on the tab. Safe to call repeatedly. */
  update(unread: number) {
    if (typeof document === 'undefined') return;
    this.unread = unread;
    this.base ??= stripCount(document.title) || FALLBACK_TITLE;
    this.applyTitle();
    void this.applyIcon();
    this.applyBadge();
    this.watchHead();
  }

  /** Put the tab back the way it was and stop watching. */
  dispose() {
    this.observer?.disconnect();
    this.observer = null;
    this.unread = 0;
    if (typeof document === 'undefined') return;
    this.applyTitle();
    this.restoreIcon();
    this.applyBadge();
  }

  private applyTitle() {
    const want = formatTitle(this.unread, this.base ?? FALLBACK_TITLE);
    if (document.title !== want) document.title = want;
  }

  private iconLinks(): HTMLLinkElement[] {
    return [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')].filter(
      (link) => !link.rel.includes('apple-touch'),
    );
  }

  private async applyIcon() {
    if (this.unread === 0) {
      this.restoreIcon();
      return;
    }
    this.dotIcon ??= this.drawIcon().catch(() => null);
    const url = await this.dotIcon;
    // The count may have dropped back to zero while the icon was being drawn
    if (!url || this.unread === 0) return;

    this.dotUrl = url;
    for (const link of this.iconLinks()) {
      if (link.getAttribute('href') === url) continue;
      // Remember what the page declared; the framework may swap the element
      // itself on navigation, so this is kept as values, not an element
      this.saved ??= { href: link.getAttribute('href') ?? '', type: link.getAttribute('type') };
      link.setAttribute('type', 'image/png');
      link.setAttribute('href', url);
    }
  }

  private restoreIcon() {
    if (!this.saved || !this.dotUrl) return;
    for (const link of this.iconLinks()) {
      if (link.getAttribute('href') !== this.dotUrl) continue;
      link.setAttribute('href', this.saved.href);
      if (this.saved.type) link.setAttribute('type', this.saved.type);
      else link.removeAttribute('type');
    }
    this.saved = null;
  }

  private applyBadge() {
    const nav = navigator as Navigator & {
      setAppBadge?: (n: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    try {
      if (this.unread > 0) nav.setAppBadge?.(this.unread)?.catch(() => {});
      else nav.clearAppBadge?.()?.catch(() => {});
    } catch {
      // Badging isn't available here
    }
  }

  /**
   * The framework owns <head> and re-renders the title and icon links on
   * navigation; put the indicator back whenever that happens.
   */
  private watchHead() {
    if (this.observer || typeof MutationObserver === 'undefined') return;
    this.observer = new MutationObserver(() => {
      if (this.unread === 0) return;
      this.applyTitle();
      void this.applyIcon();
    });
    this.observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  }
}

export const tabIndicator = new TabIndicator();
