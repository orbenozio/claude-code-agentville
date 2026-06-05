// Self-check for TailReader: incremental tailing must reconstruct exactly the
// complete lines appended, even when byte chunks split a multi-byte UTF-8 char
// or a JSON line mid-way. Run: npx tsx src/spike/tailcheck.ts
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TailReader } from "../core/TailReader.js";

const tmp = path.join(os.tmpdir(), `agentville-tailcheck-${process.pid}.jsonl`);

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ ${msg}`);
  }
}

async function main(): Promise<void> {
  await fs.writeFile(tmp, "");
  // lines with Hebrew (2-byte UTF-8) and emoji (4-byte) to stress boundary handling
  const lines = [
    JSON.stringify({ n: 1, t: "שלום עולם" }),
    JSON.stringify({ n: 2, t: "agent 🏭 working" }),
    JSON.stringify({ n: 3, t: "subagent ✅ done — מצוין" }),
    JSON.stringify({ n: 4, t: "plain ascii" }),
  ];
  const fullText = lines.map((l) => l + "\n").join("");
  const fullBytes = Buffer.from(fullText, "utf8");

  const reader = new TailReader(tmp, 0); // read from start
  const collected: string[] = [];

  // append the file in awkward byte-sized chunks that land mid-char and mid-line
  const chunkSize = 7;
  for (let i = 0; i < fullBytes.length; i += chunkSize) {
    const chunk = fullBytes.subarray(i, Math.min(i + chunkSize, fullBytes.length));
    await fs.appendFile(tmp, chunk);
    collected.push(...(await reader.poll()));
  }
  collected.push(...(await reader.poll()));

  assert(collected.length === lines.length, `line count: got ${collected.length}, want ${lines.length}`);
  let allMatch = true;
  for (let i = 0; i < lines.length; i++) {
    if (collected[i] !== lines[i]) {
      allMatch = false;
      console.error(`   line ${i}: got ${JSON.stringify(collected[i])} want ${JSON.stringify(lines[i])}`);
    }
  }
  assert(allMatch, "every line reconstructed byte-exact (no split chars / partial lines)");
  // each line must be valid JSON
  let allJson = true;
  for (const l of collected) {
    try {
      JSON.parse(l);
    } catch {
      allJson = false;
    }
  }
  assert(allJson, "every emitted line is parseable JSON");

  // rotation: truncate the file, reader should reset and re-read
  await fs.writeFile(tmp, lines[0] + "\n");
  const afterRotate = await reader.poll();
  assert(afterRotate.length === 1 && afterRotate[0] === lines[0], "rotation/truncation detected and re-read");

  await fs.rm(tmp, { force: true });
}

await main();
