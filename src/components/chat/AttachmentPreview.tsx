"use client";

import React from "react";

interface AttachmentPreviewProps {
  files: File[];
  onRemove: (index: number) => void;
}

export function AttachmentPreview({ files, onRemove }: AttachmentPreviewProps) {
  if (files.length === 0) return null;

  return (
    <div className="attachment-preview" style={{ display: 'flex', gap: 8, padding: '8px 12px', overflowX: 'auto', borderBottom: '1px solid var(--border)' }}>
      {files.map((file, i) => (
        <div key={i} style={{ position: 'relative', width: 60, height: 60, minWidth: 60, borderRadius: 8, overflow: 'hidden', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          {file.type.startsWith('image/') ? (
            <img src={URL.createObjectURL(file)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : file.type.startsWith('video/') ? (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' }}>
              <svg width="24" height="24" fill="none" stroke="#fff" strokeWidth="2" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
            </div>
          ) : (
             <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
               <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
             </div>
          )}
          <button 
            type="button"
            onClick={() => onRemove(i)}
            style={{ position: 'absolute', top: 2, right: 2, background: 'rgba(0,0,0,0.5)', color: '#fff', border: 'none', borderRadius: '50%', width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      ))}
    </div>
  );
}
