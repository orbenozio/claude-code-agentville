'use strict';

/**
 * Position-based, two-sided-marker injection logic (ported from Claude Code
 * Nonstop, with Agentville's own markers and no seed-config line).
 *
 * We wrap the injected block in matching open/close markers and only ever remove
 * the text *between and including* our own marker pair. This lets us coexist with
 * Nonstop in the same webview/index.js without either extension clobbering the
 * other. Pure string functions (no fs) so they are trivially unit-testable.
 */

const { OPEN_PREFIX, OPEN_SUFFIX, CLOSE_MARKER } = require('./constants');

/**
 * Find every Agentville block in `content`.
 * Returns an array of { start, end, version } where [start, end) spans the whole
 * block including both markers. Handles multiple/duplicate blocks (defensive).
 */
function findBlocks(content) {
  const blocks = [];
  let searchFrom = 0;
  while (true) {
    const openIdx = content.indexOf(OPEN_PREFIX, searchFrom);
    if (openIdx < 0) break;

    const lineEnd = content.indexOf('\n', openIdx);
    const openLine = content.slice(openIdx, lineEnd < 0 ? content.length : lineEnd);
    let version = null;
    if (openLine.endsWith(OPEN_SUFFIX)) {
      version = openLine.slice(OPEN_PREFIX.length, openLine.length - OPEN_SUFFIX.length);
    }

    const closeIdx = content.indexOf(CLOSE_MARKER, openIdx);
    if (closeIdx < 0) {
      blocks.push({ start: openIdx, end: content.length, version, malformed: true });
      break;
    }
    const end = closeIdx + CLOSE_MARKER.length;
    blocks.push({ start: openIdx, end, version, malformed: false });
    searchFrom = end;
  }
  return blocks;
}

/**
 * Remove ALL Agentville blocks from `content` (including duplicates/leftovers),
 * collapsing a single surrounding blank line. Returns cleaned content. Never
 * touches text outside our markers (e.g. Nonstop's block).
 */
function stripAllBlocks(content) {
  const blocks = findBlocks(content);
  if (blocks.length === 0) return content;
  let out = content;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const { start, end } = blocks[i];
    let s = start;
    let e = end;
    // Eat a single trailing newline we may have introduced after the block.
    if (out[e] === '\n') e += 1;
    // Collapse the single blank line `inject()` puts before the block (the second
    // of the `\n\n` it prepends). Only ever consume ONE preceding newline — never
    // spaces/tabs, which could be meaningful indentation of foreign code.
    if (out[s - 1] === '\n') s -= 1;
    out = out.slice(0, s) + out.slice(e);
  }
  return out;
}

/**
 * Build a fresh injection block. The webview script is self-contained (it reads
 * no host-seeded config), so — unlike Nonstop — we inject only the script body.
 * @param {string} version  extension version (goes in the open marker)
 * @param {string} scriptBody  the IIFE-wrapped webview script source
 */
function buildBlock(version, scriptBody) {
  const open = `${OPEN_PREFIX}${version}${OPEN_SUFFIX}`;
  return `${open}\n${scriptBody}\n${CLOSE_MARKER}`;
}

/**
 * Is `content` already correctly injected for `version`?
 * Invariant: exactly one well-formed block, and its version matches.
 */
function hasValidInjection(content, version) {
  const blocks = findBlocks(content);
  if (blocks.length !== 1) return false;
  const b = blocks[0];
  return !b.malformed && b.version === version;
}

/**
 * Produce the new file content carrying a single fresh Agentville block.
 *
 * Injection is IN-PLACE. If we have no block yet we append one at the end (with a
 * separating blank line). If we already have a block we replace the FIRST one
 * *where it sits* — same byte offsets — and drop any duplicate blocks, without
 * reordering anything and without trimming global whitespace. This is critical
 * when another extension (e.g. Nonstop) also injects into the same file: if both
 * injectors appended-to-end, each would shove its block past the other on every
 * reload, so both files would read as "changed" forever and both would keep
 * offering "Reload Window". With in-place replacement, re-injecting an already
 * up-to-date block is a byte-for-byte no-op (next === content), which is what
 * stops the reload loop. We never touch text outside our own markers.
 */
function inject(content, version, scriptBody) {
  const blocks = findBlocks(content);
  const block = buildBlock(version, scriptBody);

  if (blocks.length === 0) {
    // First injection: append at the end with a single separating blank line.
    const trimmed = content.replace(/\s+$/, '');
    return `${trimmed}\n\n${block}\n`;
  }

  let out = content;
  // Remove duplicate blocks (everything past the first), back-to-front so the
  // earlier offsets we still need stay valid. Mirrors stripAllBlocks' single
  // surrounding-newline cleanup. These all sit after the primary block, so the
  // primary block's offsets below remain correct.
  for (let i = blocks.length - 1; i >= 1; i--) {
    let { start: s, end: e } = blocks[i];
    if (out[e] === '\n') e += 1;
    if (out[s - 1] === '\n') s -= 1;
    out = out.slice(0, s) + out.slice(e);
  }
  // Replace the primary (first) block in place — same start/end, no reordering.
  const primary = blocks[0];
  return out.slice(0, primary.start) + block + out.slice(primary.end);
}

module.exports = {
  findBlocks,
  stripAllBlocks,
  buildBlock,
  hasValidInjection,
  inject,
};
