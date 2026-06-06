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
 * Produce the new file content with a single fresh Agentville block appended.
 * Strips any/all existing Agentville blocks first (idempotent + de-dupe), and
 * leaves all non-Agentville content (e.g. Nonstop's injection) untouched.
 */
function inject(content, version, scriptBody) {
  const clean = stripAllBlocks(content);
  const trimmed = clean.replace(/\s+$/, '');
  const block = buildBlock(version, scriptBody);
  return `${trimmed}\n\n${block}\n`;
}

module.exports = {
  findBlocks,
  stripAllBlocks,
  buildBlock,
  hasValidInjection,
  inject,
};
