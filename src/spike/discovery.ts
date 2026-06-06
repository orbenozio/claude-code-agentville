import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SessionInfo {
  sessionId: string;
  projectDir: string; // encoded project dir name
  mainFile: string; // absolute path to <session-id>.jsonl
  subagentsDir: string; // absolute path to <session-id>/subagents
  mtimeMs: number;
}

export function projectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Discover candidate main-session files (`<project>/<session-id>.jsonl`) across
 * all projects, sorted hottest-first by filesystem mtime (SPEC.md §7 — mtime only,
 * no content parsing).
 */
export async function discoverSessions(root = projectsRoot()): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  let projectDirs: string[];
  try {
    projectDirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  for (const projectDir of projectDirs) {
    const dirPath = path.join(root, projectDir);
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const sessionId = e.name.slice(0, -".jsonl".length);
      const mainFile = path.join(dirPath, e.name);
      let st;
      try {
        st = await fs.stat(mainFile);
      } catch {
        continue;
      }
      sessions.push({
        sessionId,
        projectDir,
        mainFile,
        subagentsDir: path.join(dirPath, sessionId, "subagents"),
        mtimeMs: st.mtimeMs,
      });
    }
  }

  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Hottest session, optionally filtered to a project dir substring. */
export async function hottestSession(projectFilter?: string): Promise<SessionInfo | undefined> {
  const all = await discoverSessions();
  const filtered = projectFilter ? all.filter((s) => s.projectDir.includes(projectFilter)) : all;
  return filtered[0];
}

/** All sessions sharing a project dir, hottest-first (the "sibling villages"). */
export async function siblingSessions(projectDir: string): Promise<SessionInfo[]> {
  return (await discoverSessions()).filter((s) => s.projectDir === projectDir);
}

function clipTitle(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 42 ? one.slice(0, 41) + "…" : one;
}

/**
 * A short, human title for a session — a `summary` record if one appears early,
 * else the first user message. Reads only the file head (no full parse).
 */
export async function sessionTitle(mainFile: string): Promise<string> {
  try {
    const fh = await fs.open(mainFile, "r");
    let chunk: string;
    try {
      const buf = Buffer.alloc(32768);
      const { bytesRead } = await fh.read(buf, 0, 32768, 0);
      chunk = buf.toString("utf8", 0, bytesRead);
    } finally {
      await fh.close();
    }
    let firstUser: string | null = null;
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      let o: { type?: string; summary?: string; message?: { content?: unknown } };
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type === "summary" && typeof o.summary === "string" && o.summary.trim()) {
        return clipTitle(o.summary);
      }
      if (!firstUser && o.type === "user") {
        const c = o.message?.content;
        const t =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? ((c.find((x) => (x as { type?: string }).type === "text") as { text?: string })?.text ?? "")
              : "";
        // skip tool-result/caveat-only first lines; require real prose
        if (t && t.trim() && !t.startsWith("<")) firstUser = t;
      }
    }
    if (firstUser) return clipTitle(firstUser);
  } catch {
    /* ignore */
  }
  return "Untitled chat";
}
