# WebBubbles

A web client for [BlueBubbles](https://bluebubbles.app) — access your iMessage conversations from any browser.

## Features

- **Real-time messaging** — send and receive iMessages via your BlueBubbles server
- **Offline-first** — messages cached in IndexedDB for instant loading
- **Full sync** — initial sync pulls all chats and recent messages
- **Incremental sync** — only fetches new messages after first sync
- **Draft auto-save** — unsent messages are preserved per-chat
- **Bug reporting** — built-in tool captures screenshot + logs for easy debugging

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) 20+
- A running [BlueBubbles Server](https://bluebubbles.app) on your Mac

### Setup

```bash
npm install
cp .env.example .env.local  # Optional: configure GitHub bug reports
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and enter your BlueBubbles server URL and password.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | No | GitHub PAT for bug report issue creation |
| `GITHUB_REPO` | No | GitHub repo for bug reports (`owner/repo`) |

### Scripts

```bash
npm run dev       # Start dev server
npm run build     # Production build
npm run test      # Run unit + integration tests
npm run test:watch # Watch mode
```

## Architecture

```
src/
├── app/              # Next.js App Router pages
│   ├── api/          # API routes (bug reports)
│   ├── chats/        # Chat list + message view
│   └── page.tsx      # Setup/connect screen
├── components/       # React components
├── lib/              # Database (Dexie/IndexedDB)
├── services/         # HTTP, Socket, Sync, Action Handler
├── stores/           # Zustand state management
└── test/             # Vitest tests + mock server
```

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Database**: Dexie.js (IndexedDB)
- **State**: Zustand
- **Real-time**: Socket.IO
- **Testing**: Vitest + fake-indexeddb

## License

MIT
