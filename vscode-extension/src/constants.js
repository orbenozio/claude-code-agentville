'use strict';

/**
 * Shared constants for the Agentville Launcher extension.
 *
 * The injection markers are two-sided (open + close) so our block can be located
 * and removed precisely no matter what else is appended to the same file by a
 * co-installed extension (notably Claude Code Nonstop). We only ever remove text
 * *between our own markers*, which is what lets the two extensions share Claude's
 * webview/index.js safely.
 */

// Open marker carries the version: "// >>> Agentville Launcher (injected) v1.2.3 >>>"
const OPEN_PREFIX = '// >>> Agentville Launcher (injected) v';
const OPEN_SUFFIX = ' >>>';
const CLOSE_MARKER = '// <<< Agentville Launcher (injected) <<<';

// Marker string of a known co-installed extension that injects into the same
// webview file. Used only to DETECT its presence (diagnostics) so we never
// clobber it — the value must match that extension's open marker verbatim.
const FOREIGN_MARKER = '// >>> Claude Code Nonstop (injected) v';

// Backup file suffix (kept distinct from Nonstop's ".nonstop-backup").
const BACKUP_SUFFIX = '.agentville-backup';

// Claude Code extension id and directory prefix.
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const CLAUDE_DIR_PREFIX = 'anthropic.claude-code-';

// The webview entry file we inject into, relative to the extension dir.
const WEBVIEW_ENTRY = 'webview/index.js';

module.exports = {
  OPEN_PREFIX,
  OPEN_SUFFIX,
  CLOSE_MARKER,
  FOREIGN_MARKER,
  BACKUP_SUFFIX,
  CLAUDE_EXTENSION_ID,
  CLAUDE_DIR_PREFIX,
  WEBVIEW_ENTRY,
};
