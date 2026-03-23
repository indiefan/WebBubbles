# State Management

All client state is managed via Zustand stores in `src/stores/`.

## Store Overview

| Store | Key State | Persistence |
|---|---|---|
| `connectionStore` | `serverAddress`, `password`, `socketState`, `isSetup` | localStorage |
| `chatStore` | `chats[]`, `activeChatGuid` | IndexedDB (via sync) |
| `messageStore` | `messages[]` (active chat), `loading`, `hasMore` | IndexedDB (via sync) |
| `contactStore` | `contacts Map`, `handles Map`, `handleContactMap` | IndexedDB (via sync) |
| `syncStore` | `lastFullSync`, `lastIncrementalSync`, sync progress | localStorage |
| `downloadStore` | `loading{}`, `progress{}` per attachment GUID | In-memory only |

## Reactivity Model

```
Socket event → ActionHandler → IndexedDB upsert + Zustand store update → React re-render
```

- Zustand stores expose state + actions
- Components subscribe via selectors: `useStore(s => s.activeChat)`
- Settings are persisted to localStorage (small, frequently accessed)
- The `contactStore` provides display name resolution with fallback chain:
  `Contact.displayName → Handle.formattedAddress → raw address`

## Chat Display Name Resolution

The `contactStore.resolveChatDisplayName(chat)` method handles:
- Group chats with explicit name → use it
- 1:1 chats → resolve single participant via `resolveDisplayName`
- Unnamed groups → join participant names (max 4, then "& N more")

Contact matching normalizes phone numbers to digits-only and does case-insensitive email comparison.
