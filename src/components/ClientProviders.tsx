"use client";

import { useEffect } from "react";
import { logBuffer } from "@/services/logBuffer";
import BugReportModal from "@/components/BugReportModal";

export default function ClientProviders({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    logBuffer.install();
  }, []);

  return (
    <>
      {children}
      <BugReportModal />
    </>
  );
}
