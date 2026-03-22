// Mock HTTP server helper for tests — intercepts fetch calls

type MockRoute = {
  method: string;
  pathPattern: RegExp | string;
  handler: (url: URL, body?: any) => any;
};

export class MockServer {
  private routes: MockRoute[] = [];
  private originalFetch: typeof globalThis.fetch;

  constructor() {
    this.originalFetch = globalThis.fetch;
  }

  addRoute(method: string, pathPattern: RegExp | string, handler: (url: URL, body?: any) => any) {
    this.routes.push({ method, pathPattern, handler });
    return this;
  }

  // Convenience methods
  get(path: RegExp | string, handler: (url: URL) => any) {
    return this.addRoute('GET', path, handler);
  }

  post(path: RegExp | string, handler: (url: URL, body?: any) => any) {
    return this.addRoute('POST', path, handler);
  }

  put(path: RegExp | string, handler: (url: URL, body?: any) => any) {
    return this.addRoute('PUT', path, handler);
  }

  delete(path: RegExp | string, handler: (url: URL) => any) {
    return this.addRoute('DELETE', path, handler);
  }

  install() {
    const routes = this.routes;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? 'GET').toUpperCase();

      for (const route of routes) {
        const matchMethod = route.method === method;
        const matchPath =
          typeof route.pathPattern === 'string'
            ? url.pathname.includes(route.pathPattern)
            : route.pathPattern.test(url.pathname);

        if (matchMethod && matchPath) {
          let body: any;
          if (init?.body && typeof init.body === 'string') {
            try { body = JSON.parse(init.body); } catch { body = init.body; }
          }

          const result = route.handler(url, body);
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // Unmatched routes return 404
      return new Response(JSON.stringify({ status: 404, message: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
  }

  restore() {
    globalThis.fetch = this.originalFetch;
  }
}
