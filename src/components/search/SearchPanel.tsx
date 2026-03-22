"use client";

import React, { useState } from "react";
import { db, MessageRecord } from "@/lib/db";
import { http } from "@/services/http";
import { serverMessageToRecord } from "@/services/actionHandler";
import { format } from "date-fns";
import { useRouter } from "next/navigation";

export function SearchPanel({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"local" | "server">("server");
  const [results, setResults] = useState<MessageRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setResults([]);
    try {
      if (mode === "local") {
        const lowerQ = query.toLowerCase();
        // Since full-text search requires a dedicated index layout, we'll do a simple filter over recent messages
        const local = await db.messages.orderBy("dateCreated").reverse().limit(5000).filter(m => !!m.text && m.text.toLowerCase().includes(lowerQ)).toArray();
        setResults(local.slice(0, 100)); // Cap results
      } else {
        const res = await http.queryMessages({
           where: [
             { statement: 'message.text LIKE :text', args: { text: `%${query}%` } }
           ],
           limit: 50
        });
        const serverMsgs = (res?.data || []).map(serverMessageToRecord);
        setResults(serverMsgs);
      }
    } catch (err: any) {
      alert("Search failed: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ position: 'absolute', top: 0, left: 320, width: '380px', height: '100%', backgroundColor: 'var(--bg-secondary)', borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)', zIndex: 10, display: 'flex', flexDirection: 'column', boxShadow: '5px 0 15px rgba(0,0,0,0.5)' }}>
      <div style={{ padding: 16, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <h3 style={{ margin: 0, flex: 1 }}>Search Messages</h3>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>

      <form onSubmit={handleSearch} style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
        <input 
          type="text" 
          placeholder="Search text..." 
          value={query} 
          onChange={e => setQuery(e.target.value)} 
          className="compose-input" 
          autoFocus 
          style={{ width: '100%', boxSizing: 'border-box', marginBottom: 12 }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setMode("local")} style={{ flex: 1, padding: 8, borderRadius: 8, border: 'none', background: mode === "local" ? 'var(--accent)' : 'rgba(255,255,255,0.05)', color: mode === "local" ? '#fff' : 'var(--fg)', cursor: 'pointer' }}>Local</button>
          <button type="button" onClick={() => setMode("server")} style={{ flex: 1, padding: 8, borderRadius: 8, border: 'none', background: mode === "server" ? 'var(--accent)' : 'rgba(255,255,255,0.05)', color: mode === "server" ? '#fff' : 'var(--fg)', cursor: 'pointer' }}>Server</button>
        </div>
        <button type="submit" style={{ display: 'none' }}>Submit</button>
      </form>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}><span className="loading-spinner"></span></div>}
        {!loading && results.length === 0 && query && <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)' }}>No results found</div>}
        
        {results.map(msg => (
          <div 
            key={msg.guid} 
            onClick={() => {
              if (msg.chatGuid) {
                 router.push(`/chats/${encodeURIComponent(msg.chatGuid)}`);
                 onClose();
              }
            }}
            style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)', cursor: 'pointer' }}
          >
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
               {format(new Date(msg.dateCreated), "MMM d, yyyy h:mm a")}
            </div>
            <div style={{ fontSize: 13, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
               {msg.text || (msg.hasAttachments ? '[Attachment]' : '')}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
