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
