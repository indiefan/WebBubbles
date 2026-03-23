# WebBubbles

Web native client implementation for the [BlueBubbles Server](https://bluebubbles.app). Access your iMessage conversations from any browser by connecting to the same macOS server that the mobile apps use.

## Installation

### Prerequisites

- A running [BlueBubbles Server](https://bluebubbles.app) on your Mac — this is the iMessage bridge that WebBubbles connects to
- Your server's **URL** and **password** (found in the BlueBubbles Server app under Settings)

### Option A: Docker Compose (Recommended)

The simplest way to run WebBubbles in production. Includes health checks, automatic restarts, and zero-downtime rolling updates.

1. Clone the repo and create your environment file:

   ```bash
   git clone https://github.com/indiefan/WebBubbles.git
   cd WebBubbles
   cp .env.example .env.local
   ```

2. (Optional) Edit `.env.local` to enable in-app bug reporting:

   ```bash
   GITHUB_TOKEN=ghp_...        # GitHub PAT with `repo` scope
   GITHUB_REPO=owner/repo      # Target repo for bug report issues
   ```

3. Start the service:

   ```bash
   docker compose up -d
   ```

4. Open [http://localhost:3042](http://localhost:3042) and enter your BlueBubbles server URL and password.

> To use Docker Swarm for orchestration, deploy with `docker stack deploy -c docker-compose.yml webbubbles` instead.

### Option B: Docker (Standalone)

```bash
docker run -d \
  -p 3042:3000 \
  --name webbubbles \
  --restart unless-stopped \
  ghcr.io/indiefan/webbubbles:latest
```

Open [http://localhost:3042](http://localhost:3042).

### Option C: Local Development

Requires [Node.js](https://nodejs.org) 20+.

```bash
git clone https://github.com/indiefan/WebBubbles.git
cd WebBubbles
npm install
cp .env.example .env.local   # Optional: configure GitHub bug reports
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and enter your BlueBubbles server URL and password.

#### Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server (Turbopack) |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run test` | Run unit + integration tests |
| `npm run test:watch` | Watch mode |
| `npm run lint` | ESLint |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | No | GitHub PAT with `repo` scope — enables in-app bug report filing |
| `GITHUB_REPO` | No | Target GitHub repo for bug reports (format: `owner/repo`) |

## System Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Next.js App                          │
│                                                         │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────────┐ │
│  │  Pages /  │  │  Zustand  │  │  Service Layer       │ │
│  │  Comps    │←→│  Stores   │←→│  (HTTP, Socket,      │ │
│  │  (React)  │  │  (state)  │  │   Sync, Downloads)   │ │
│  └──────────┘  └───────────┘  └──────────┬───────────┘ │
│                                           │             │
│               ┌───────────────────────────┤             │
│               │                           │             │
│      ┌────────▼────────┐       ┌──────────▼──────────┐  │
│      │  Dexie.js       │       │  fetch + Socket.IO   │  │
│      │  (IndexedDB)    │       │  Client              │  │
│      └─────────────────┘       └──────────┬──────────┘  │
│                                           │             │
└───────────────────────────────────────────┼─────────────┘
                                            │
                                ┌───────────▼───────────┐
                                │  BlueBubbles Server   │
                                │  (macOS host)         │
                                └───────────────────────┘
```

## Core Principles

1. **Server is source of truth.** IndexedDB is a performance cache; conflicts resolve by trusting the server.
2. **Event-driven updates.** Socket.IO events → Zustand stores → React re-renders. No polling.
3. **Optimistic UI.** Outgoing messages appear instantly with temp GUIDs, replaced on server confirmation.
4. **Offline-tolerant, online-first.** The server connection is essential. IndexedDB enables fast startup and draft persistence.

## Tech Stack

| Concern | Choice |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript (strict) |
| State | Zustand |
| Local DB | Dexie.js (IndexedDB) |
| Real-time | socket.io-client |
| HTTP | Native fetch with auth wrapper |
| Styling | Vanilla CSS (dark theme, glassmorphism) |
| Dates | date-fns |

## Directory Structure

```
src/
├── app/                    # Next.js App Router pages
│   ├── page.tsx            # Setup/connect page
│   ├── chats/
│   │   ├── layout.tsx      # Sidebar + socket init + chat list
│   │   ├── page.tsx        # Empty state
│   │   └── [guid]/page.tsx # Conversation view
│   ├── api/                # Server-side API routes (bug reports, health)
│   └── globals.css         # All styles
├── components/
│   ├── chat/               # MessageBubble, ComposeArea, ReactionPicker, etc.
│   └── search/             # SearchPanel
├── services/               # HTTP, Socket, Sync, Downloads, ActionHandler, OutgoingQueue
├── stores/                 # Zustand stores (connection, chat, message, contact, sync, download)
├── lib/                    # Dexie DB schema
└── test/                   # Vitest tests (phase1/2/3, integration, contacts)
```

## Data Flow

See component-level docs in `design/`:
- [Data Layer](design/data-layer.md) — IndexedDB schema, attachment caching, live queries
- [Services](design/services.md) — HTTP client, Socket.IO, sync engine, download manager, outgoing queue
- [State Management](design/state-management.md) — Zustand stores and reactivity model
- [Messaging](design/messaging.md) — Send/receive lifecycle, reactions, attachments

## License

MIT

