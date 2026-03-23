# Architecture Overview

WebBubbles is a Next.js 16 web client for [BlueBubbles](https://bluebubbles.app), connecting to the same macOS server that the mobile apps use. It provides iMessage access from any browser.

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

See component-level docs:
- [Data Layer](./data-layer.md) — IndexedDB schema, attachment caching, live queries
- [Services](./services.md) — HTTP client, Socket.IO, sync engine, download manager, outgoing queue
- [State Management](./state-management.md) — Zustand stores and reactivity model
- [Messaging](./messaging.md) — Send/receive lifecycle, reactions, attachments
