import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatRecord } from '@/lib/db';
import { countUnread, formatTitle, stripCount, TabIndicator } from '@/services/tabIndicator';

const DOT = 'data:image/png;base64,dot';
const tick = () => new Promise((r) => setTimeout(r, 0));

function chat(hasUnreadMessage: boolean): ChatRecord {
  return { guid: Math.random().toString(), hasUnreadMessage } as ChatRecord;
}

describe('tab indicator', () => {
  let link: HTMLLinkElement;
  const created: TabIndicator[] = [];
  const make = (draw: () => Promise<string | null>) => {
    const indicator = new TabIndicator(draw);
    created.push(indicator);
    return indicator;
  };

  beforeEach(() => {
    document.head.innerHTML = '<title>WebBubbles</title><link rel="icon" href="/favicon.ico?x" type="image/x-icon">';
    link = document.head.querySelector('link')!;
  });

  afterEach(() => {
    // Each indicator watches <head>; one left running would reach into the next test
    for (const indicator of created.splice(0)) indicator.dispose();
  });

  it('counts chats with something unread', () => {
    expect(countUnread([chat(true), chat(false), chat(true)])).toBe(2);
    expect(countUnread([])).toBe(0);
  });

  it('prefixes the title with the count and strips it again', () => {
    expect(formatTitle(3, 'WebBubbles')).toBe('(3) WebBubbles');
    expect(formatTitle(0, 'WebBubbles')).toBe('WebBubbles');
    expect(stripCount('(12) WebBubbles')).toBe('WebBubbles');
    expect(stripCount('WebBubbles')).toBe('WebBubbles');
  });

  it('puts the count in the title and a dot on the favicon, and takes them off again', async () => {
    const indicator = make(async () => DOT);

    indicator.update(2);
    await tick();
    expect(document.title).toBe('(2) WebBubbles');
    expect(link.getAttribute('href')).toBe(DOT);
    expect(link.getAttribute('type')).toBe('image/png');

    indicator.update(5);
    await tick();
    expect(document.title).toBe('(5) WebBubbles');

    indicator.update(0);
    await tick();
    expect(document.title).toBe('WebBubbles');
    expect(link.getAttribute('href')).toBe('/favicon.ico?x');
    expect(link.getAttribute('type')).toBe('image/x-icon');
  });

  it('puts the indicator back when the page rewrites its own title', async () => {
    const indicator = make(async () => DOT);
    indicator.update(1);
    await tick();

    // What a client-side navigation does to the head
    document.title = 'WebBubbles';
    link.setAttribute('href', '/favicon.ico?x');
    await tick();

    expect(document.title).toBe('(1) WebBubbles');
    expect(link.getAttribute('href')).toBe(DOT);
  });

  it('restores the favicon even after the page has replaced the link element', async () => {
    const indicator = make(async () => DOT);
    indicator.update(1);
    await tick();

    // What a client-side navigation can do: a fresh <link>, which the watcher re-dots
    link.remove();
    const fresh = document.createElement('link');
    fresh.rel = 'icon';
    fresh.setAttribute('href', '/favicon.ico?x');
    fresh.setAttribute('type', 'image/x-icon');
    document.head.appendChild(fresh);
    await tick();
    expect(fresh.getAttribute('href')).toBe(DOT);

    indicator.update(0);
    await tick();
    expect(fresh.getAttribute('href')).toBe('/favicon.ico?x');
    expect(fresh.getAttribute('type')).toBe('image/x-icon');
  });

  it('leaves the favicon alone when the dot cannot be drawn', async () => {
    const indicator = make(async () => null);
    indicator.update(1);
    await tick();
    expect(document.title).toBe('(1) WebBubbles');
    expect(link.getAttribute('href')).toBe('/favicon.ico?x');
  });

  it('sets and clears the app badge when the browser offers one', async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { setAppBadge, clearAppBadge });
    const indicator = make(async () => DOT);

    indicator.update(4);
    expect(setAppBadge).toHaveBeenCalledWith(4);
    indicator.update(0);
    expect(clearAppBadge).toHaveBeenCalled();
  });

  it('restores the tab when disposed', async () => {
    const indicator = make(async () => DOT);
    indicator.update(3);
    await tick();

    indicator.dispose();
    expect(document.title).toBe('WebBubbles');
    expect(link.getAttribute('href')).toBe('/favicon.ico?x');
  });
});
