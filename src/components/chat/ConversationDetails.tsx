"use client";

import React, { useEffect, useState, useCallback } from "react";
import { db, AttachmentRecord, ChatRecord } from "@/lib/db";
import { http } from "@/services/http";
import { useContactStore } from "@/stores/contactStore";
import { useChatStore } from "@/stores/chatStore";
import { downloadService } from "@/services/downloads";

interface ConversationDetailsProps {
  chat: ChatRecord;
  onClose: () => void;
}

export function ConversationDetails({ chat, onClose }: ConversationDetailsProps) {
  const { resolveDisplayName } = useContactStore();
  const [sharedMedia, setSharedMedia] = useState<AttachmentRecord[]>([]);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [addAddress, setAddAddress] = useState("");
  const [renameText, setRenameText] = useState(chat.displayName || "");
  const [loading, setLoading] = useState(false);

  const isGroup = (chat.participantHandleAddresses?.length ?? 0) > 1;

  // Load shared media attachments for this chat
  useEffect(() => {
    const loadMedia = async () => {
      try {
        // Get messages for this chat that have attachments
        const msgs = await db.messages
          .where("chatGuid").equals(chat.guid)
          .filter(m => m.hasAttachments)
          .toArray();

        const msgGuids = msgs.map(m => m.guid);
        if (msgGuids.length === 0) return;

        const attachments = await db.attachments
          .where("messageGuid").anyOf(msgGuids)
          .filter(a => !!a.mimeType && (a.mimeType.startsWith("image/") || a.mimeType.startsWith("video/")))
          .toArray();

        setSharedMedia(attachments.slice(0, 30)); // Limit to 30 for perf
      } catch (e) {
        console.error("[Details] Failed to load shared media:", e);
      }
    };
    loadMedia();
  }, [chat.guid]);

  // Load thumbnails as they come in
  useEffect(() => {
    for (const att of sharedMedia) {
      if (!mediaUrls[att.guid]) {
        downloadService.getAttachmentUrl(att.guid).then(url => {
          setMediaUrls(prev => ({ ...prev, [att.guid]: url }));
        }).catch(() => {});
      }
    }
  }, [sharedMedia, mediaUrls]);

  const handleRename = async () => {
    if (!renameText.trim()) return;
    setLoading(true);
    try {
      await http.updateChat(chat.guid, renameText.trim());
      await db.chats.update(chat.guid, { displayName: renameText.trim() });
      const updated = await db.chats.get(chat.guid);
      if (updated) useChatStore.getState().upsertChat(updated);
    } catch (e: any) {
      alert("Rename failed: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAddParticipant = async () => {
    if (!addAddress.trim()) return;
    setLoading(true);
    try {
      await http.addParticipant(chat.guid, addAddress.trim());
      setAddAddress("");
      // Refresh chat from server
      const res = await http.singleChat(chat.guid, "participants");
      if (res?.data) {
        const updated = { ...chat, participantHandleAddresses: res.data.participants?.map((p: any) => p.address) ?? chat.participantHandleAddresses };
        await db.chats.put(updated);
        useChatStore.getState().upsertChat(updated);
      }
    } catch (e: any) {
      alert("Add participant failed: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveParticipant = async (address: string) => {
    if (!confirm(`Remove ${resolveDisplayName(address)} from group?`)) return;
    setLoading(true);
    try {
      await http.removeParticipant(chat.guid, address);
      const res = await http.singleChat(chat.guid, "participants");
      if (res?.data) {
        const updated = { ...chat, participantHandleAddresses: res.data.participants?.map((p: any) => p.address) ?? chat.participantHandleAddresses };
        await db.chats.put(updated);
        useChatStore.getState().upsertChat(updated);
      }
    } catch (e: any) {
      alert("Remove participant failed: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLeave = async () => {
    if (!confirm("Leave this group chat?")) return;
    setLoading(true);
    try {
      await http.leaveChat(chat.guid);
      onClose();
    } catch (e: any) {
      alert("Leave failed: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const sectionStyle: React.CSSProperties = { padding: "12px 16px", borderBottom: "1px solid var(--border)" };
  const labelStyle: React.CSSProperties = { fontSize: 11, color: "var(--muted)", marginBottom: 8, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 };

  return (
    <div style={{ width: 320, minWidth: 320, height: "100%", backgroundColor: "var(--bg-secondary)", borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", overflowY: "auto" }}>
      {/* Header */}
      <div style={{ padding: 16, borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Details</h3>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>

      {/* Participants */}
      <div style={sectionStyle}>
        <div style={labelStyle}>Participants ({chat.participantHandleAddresses?.length ?? 0})</div>
        {chat.participantHandleAddresses?.map(addr => (
          <div key={addr} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
            <div style={{ width: 32, height: 32, borderRadius: "50%", backgroundColor: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 13, fontWeight: 600, flexShrink: 0 }}>
              {resolveDisplayName(addr).charAt(0).toUpperCase()}
            </div>
            <span style={{ flex: 1, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{resolveDisplayName(addr)}</span>
            {isGroup && (
              <button onClick={() => handleRemoveParticipant(addr)} title="Remove" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--danger)", padding: 4, flexShrink: 0 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
              </button>
            )}
          </div>
        ))}
        {/* Add participant input */}
        {isGroup && (
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input type="text" placeholder="Add participant..." value={addAddress} onChange={e => setAddAddress(e.target.value)} className="compose-input" style={{ flex: 1, fontSize: 12, padding: "6px 8px" }} />
            <button onClick={handleAddParticipant} disabled={loading || !addAddress.trim()} style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", cursor: "pointer", fontSize: 12 }}>Add</button>
          </div>
        )}
      </div>

      {/* Group actions */}
      {isGroup && (
        <div style={sectionStyle}>
          <div style={labelStyle}>Group Name</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="text" value={renameText} onChange={e => setRenameText(e.target.value)} className="compose-input" style={{ flex: 1, fontSize: 12, padding: "6px 8px" }} />
            <button onClick={handleRename} disabled={loading} style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", cursor: "pointer", fontSize: 12 }}>Rename</button>
          </div>
          <button onClick={handleLeave} disabled={loading} style={{ marginTop: 12, padding: "8px 16px", borderRadius: 8, border: "none", background: "var(--danger)", color: "#fff", cursor: "pointer", fontSize: 12, width: "100%" }}>Leave Group</button>
        </div>
      )}

      {/* Shared Media */}
      <div style={sectionStyle}>
        <div style={labelStyle}>Shared Media</div>
        {sharedMedia.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--muted)", padding: "8px 0" }}>No shared media</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
            {sharedMedia.map(att => (
              <div key={att.guid} style={{ width: "100%", aspectRatio: "1", borderRadius: 6, overflow: "hidden", backgroundColor: "rgba(255,255,255,0.05)" }}>
                {mediaUrls[att.guid] ? (
                  att.mimeType?.startsWith("video/") ? (
                    <video src={mediaUrls[att.guid]} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <img src={mediaUrls[att.guid]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  )
                ) : (
                  <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span className="loading-spinner" style={{ width: 16, height: 16 }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
