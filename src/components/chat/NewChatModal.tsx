"use client";

import React, { useState } from "react";
import { http } from "@/services/http";
import { useChatStore } from "@/stores/chatStore";
import { useRouter } from "next/navigation";

export function NewChatModal({ onClose }: { onClose: () => void }) {
  const [address, setAddress] = useState("");
  const [service, setService] = useState<"iMessage" | "SMS">("iMessage");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address.trim()) return;

    setLoading(true);
    try {
      const res = await http.createChat([address.trim()], service);
      let guid = res?.data?.guid ?? res?.data?.chatGuid ?? res?.guid;

      if (!guid && res?.data === "OK") {
         // Server fallback — sometimes it returns just "OK". Without the guid, 
         // we might need to wait for the next sync or query it, but for now we fallback to the address format
         guid = `${service};-;<address>`; // We shouldn't guess, let's query it
         const r2 = await http.queryChats({ limit: 10, sort: "lastmessage" });
         guid = r2?.data?.[0]?.guid; 
      }
      
      if (guid || res?.data?.guid) {
        let finalGuid = res?.data?.guid || guid;
        useChatStore.getState().setActiveChatGuid(finalGuid);
        router.push(`/chats/${encodeURIComponent(finalGuid)}`);
        onClose();
      } else {
        alert("Failed to determine new chat GUID.");
      }
    } catch (err: any) {
      alert("Error creating chat: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ backgroundColor: 'var(--bg-secondary)', padding: 24, borderRadius: 12, width: 400, maxWidth: '90%' }}>
        <h3 style={{ marginTop: 0 }}>New Chat</h3>
        <form onSubmit={handleCreate}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', marginBottom: 8, fontSize: 13, color: 'var(--muted)' }}>To:</label>
            <input 
              type="text" 
              placeholder="Phone number, email, or handle..." 
              value={address} 
              onChange={e => setAddress(e.target.value)} 
              className="compose-input" 
              autoFocus 
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
          </div>
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', marginBottom: 8, fontSize: 13, color: 'var(--muted)' }}>Service:</label>
            <select 
              value={service} 
              onChange={e => setService(e.target.value as any)} 
              className="compose-input"
              style={{ padding: 8, width: '100%', borderRadius: 8, boxSizing: 'border-box' }}
            >
              <option value="iMessage">iMessage</option>
              <option value="SMS">SMS</option>
            </select>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" onClick={onClose} className="button-secondary" style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: 'rgba(255,255,255,0.1)', color: 'var(--fg)', cursor: 'pointer' }}>Cancel</button>
            <button type="submit" disabled={loading || !address.trim()} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer' }}>
              {loading ? "Starting..." : "Start Chat"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
