import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TailReader } from "../TailReader.js";

async function tmpFile(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tailreader-"));
  return path.join(dir, name);
}

// ---------------------------------------------------------------------------
// incremental read from offset (SPEC.md 8: read only [offset, EOF])
// ---------------------------------------------------------------------------

test("incremental poll returns only newly-appended complete lines", async () => {
  const f = await tmpFile("inc.jsonl");
  await fs.writeFile(f, "line1\nline2\n");
  const tr = new TailReader(f, 0);

  assert.deepEqual(await tr.poll(), ["line1", "line2"]);
  assert.deepEqual(await tr.poll(), [], "nothing new -> empty");

  await fs.appendFile(f, "line3\n");
  assert.deepEqual(await tr.poll(), ["line3"], "only the appended line, not re-read");
});

test("a partial (no trailing newline) line is held until completed", async () => {
  const f = await tmpFile("partial.jsonl");
  await fs.writeFile(f, "complete\npar");
  const tr = new TailReader(f, 0);

  assert.deepEqual(await tr.poll(), ["complete"], "partial 'par' is buffered, not emitted");

  await fs.appendFile(f, "tial\nnext\n");
  assert.deepEqual(await tr.poll(), ["partial", "next"], "buffered fragment completes into 'partial'");
});

test("empty lines are filtered out", async () => {
  const f = await tmpFile("blanks.jsonl");
  await fs.writeFile(f, "a\n\n\nb\n");
  const tr = new TailReader(f, 0);
  assert.deepEqual(await tr.poll(), ["a", "b"]);
});

test("CRLF line endings: trailing \\r is stripped", async () => {
  const f = await tmpFile("crlf.jsonl");
  await fs.writeFile(f, "alpha\r\nbeta\r\n");
  const tr = new TailReader(f, 0);
  assert.deepEqual(await tr.poll(), ["alpha", "beta"]);
});

// ---------------------------------------------------------------------------
// UTF-8 boundary safety (SPEC.md 8: never split a multi-byte char)
// ---------------------------------------------------------------------------

test("multi-byte UTF-8 split across two reads is reconstructed byte-exact", async () => {
  const f = await tmpFile("utf8.jsonl");
  // Hebrew + emoji content, written in two appends that cut a multi-byte char.
  const full = "שלום 🏘️ world\n";
  const bytes = Buffer.from(full, "utf8");
  const cut = 8; // lands mid multi-byte sequence
  await fs.writeFile(f, bytes.subarray(0, cut));
  const tr = new TailReader(f, 0);
  assert.deepEqual(await tr.poll(), [], "no complete line yet, and no mojibake emitted");

  await fs.appendFile(f, bytes.subarray(cut));
  assert.deepEqual(await tr.poll(), ["שלום 🏘️ world"], "reconstructed exactly across the byte cut");
});

// ---------------------------------------------------------------------------
// tail-start: skip the leading partial line (SPEC.md 8)
// ---------------------------------------------------------------------------

test("tail-start drops the (almost-certainly partial) first line", async () => {
  const f = await tmpFile("tail.jsonl");
  // build a file bigger than tailBytes; the byte cut lands mid first kept line
  const lines = Array.from({ length: 50 }, (_, i) => `record-${i}`);
  await fs.writeFile(f, lines.join("\n") + "\n");
  const stat = await fs.stat(f);
  const tr = new TailReader(f, 40); // start ~40 bytes from EOF
  const out = await tr.poll();

  assert.ok(out.length > 0, "should return the tail records");
  // the first kept byte is mid-line -> that partial fragment must be dropped, so the
  // first returned line is a clean, whole record that actually exists in the file.
  assert.ok(lines.includes(out[0]), `first emitted line '${out[0]}' must be a whole record`);
  assert.ok(out.every((l) => lines.includes(l)), "every emitted line is a real whole record");
  assert.ok(stat.size > 40);
});

// ---------------------------------------------------------------------------
// rotation / truncation (SPEC.md 8: size < offset -> reset, re-read)
// ---------------------------------------------------------------------------

test("truncation (file shrinks below offset) resets and re-reads from start", async () => {
  const f = await tmpFile("rot.jsonl");
  await fs.writeFile(f, "old1\nold2\nold3\n");
  const tr = new TailReader(f, 0);
  await tr.poll(); // consume everything, offset now at EOF
  assert.ok(tr.bytesRead > 0);

  // simulate rotation: file replaced by a smaller one
  await fs.writeFile(f, "new1\n");
  const out = await tr.poll();
  assert.deepEqual(out, ["new1"], "after truncation, re-reads the new content from the start");
});

test("vanished file -> poll returns [] (does not throw)", async () => {
  const f = await tmpFile("gone.jsonl");
  await fs.writeFile(f, "x\n");
  const tr = new TailReader(f, 0);
  await tr.poll();
  await fs.rm(f);
  assert.deepEqual(await tr.poll(), [], "missing file is tolerated");
});

test("manual reset() re-reads from the start on next poll", async () => {
  const f = await tmpFile("reset.jsonl");
  await fs.writeFile(f, "a\nb\n");
  const tr = new TailReader(f, 0);
  await tr.poll();
  tr.reset();
  assert.deepEqual(await tr.poll(), ["a", "b"], "reset re-reads the whole file");
});
