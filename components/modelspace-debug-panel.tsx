"use client";

import { useEffect, useMemo, useState } from "react";
import {
  clearModelSpaceDebugLogs,
  exportModelSpaceDebugLogs,
  getModelSpaceDebugLogs,
  MODELSPACE_DEBUG_EVENT,
  type ModelSpaceDebugEntry
} from "@/lib/modelspace-debug";

function formatEntry(entry: ModelSpaceDebugEntry) {
  const data = entry.data === undefined ? "" : ` ${JSON.stringify(entry.data)}`;
  return `${String(entry.elapsedMs).padStart(6, " ")}ms ${entry.level.toUpperCase().padEnd(5, " ")} [${entry.category}] ${entry.event}${data}`;
}

export function ModelSpaceDebugPanel() {
  const [enabled, setEnabled] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [logs, setLogs] = useState<ModelSpaceDebugEntry[]>([]);
  const [copyState, setCopyState] = useState("Copy");

  useEffect(() => {
    const debugEnabled = new URLSearchParams(window.location.search).get("debug") === "1";
    if (!debugEnabled) return;

    const refresh = () => setLogs(getModelSpaceDebugLogs());
    const initialize = window.setTimeout(() => {
      setEnabled(true);
      refresh();
    }, 0);

    window.addEventListener(MODELSPACE_DEBUG_EVENT, refresh);
    return () => {
      window.clearTimeout(initialize);
      window.removeEventListener(MODELSPACE_DEBUG_EVENT, refresh);
    };
  }, []);

  const visibleLogs = useMemo(() => logs.slice(-140), [logs]);
  const errors = logs.filter((entry) => entry.level === "error").length;
  const warnings = logs.filter((entry) => entry.level === "warn").length;

  if (!enabled) return null;

  const copyLogs = async () => {
    try {
      await navigator.clipboard.writeText(exportModelSpaceDebugLogs());
      setCopyState("Copied");
      window.setTimeout(() => setCopyState("Copy"), 1500);
    } catch {
      setCopyState("Copy failed");
    }
  };

  const clearLogs = () => {
    clearModelSpaceDebugLogs();
    setLogs([]);
  };

  return (
    <aside
      aria-label="ModelSpace debug panel"
      style={{
        position: "fixed",
        zIndex: 2147483647,
        left: 8,
        right: 8,
        bottom: 8,
        maxHeight: expanded ? "46vh" : 44,
        border: "1px solid rgba(255,255,255,.28)",
        borderRadius: 10,
        background: "rgba(0,0,0,.88)",
        color: "#fff",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 10,
        boxShadow: "0 12px 40px rgba(0,0,0,.45)",
        overflow: "hidden",
        pointerEvents: "auto"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 42, padding: "6px 8px" }}>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          style={{ border: 0, borderRadius: 6, padding: "6px 8px", background: "#fff", color: "#111", fontWeight: 800 }}
        >
          {expanded ? "Hide" : "Debug"}
        </button>
        <strong style={{ flex: 1 }}>logs {logs.length} · err {errors} · warn {warnings}</strong>
        <button type="button" onClick={() => void copyLogs()} style={{ border: "1px solid #555", borderRadius: 6, padding: "6px 8px", background: "#222", color: "#fff" }}>{copyState}</button>
        <button type="button" onClick={clearLogs} style={{ border: "1px solid #555", borderRadius: 6, padding: "6px 8px", background: "#222", color: "#fff" }}>Clear</button>
      </div>

      {expanded && (
        <pre
          style={{
            margin: 0,
            padding: "8px 10px 12px",
            maxHeight: "calc(46vh - 44px)",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            borderTop: "1px solid rgba(255,255,255,.16)",
            lineHeight: 1.35,
            userSelect: "text"
          }}
        >
          {visibleLogs.map(formatEntry).join("\n") || "Waiting for runtime events…"}
        </pre>
      )}
    </aside>
  );
}
