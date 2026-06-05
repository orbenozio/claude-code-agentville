import { promises as fs } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * Incremental, UTF-8-aware tail reader for a single growing JSONL file.
 *
 * Guarantees (SPEC.md §8):
 *  - reads only [offset, EOF] on each poll — never re-parses the whole file
 *  - never splits a multi-byte UTF-8 char (StringDecoder buffers partial bytes)
 *  - never emits a partial JSON line (holds the trailing fragment until the next \n)
 *  - "start from tail": on first open, skips to near-EOF and drops the first
 *    partial line (the byte cut almost always lands mid-line)
 *  - rotation/truncation: detected by size < bytesRead, caller decides reset
 */
export class TailReader {
  private offset = 0;
  private decoder = new StringDecoder("utf8");
  private lineBuffer = "";
  private opened = false;

  constructor(
    private readonly filePath: string,
    /** on first open, start this many bytes from the end (0 = whole file) */
    private readonly tailBytes = 0,
  ) {}

  /**
   * Read whatever has been appended since the last call.
   * Returns complete lines (without trailing newline). Empty array if nothing new.
   */
  async poll(): Promise<string[]> {
    let stat;
    try {
      stat = await fs.stat(this.filePath);
    } catch {
      return []; // file vanished/not ready yet
    }
    const size = stat.size;

    if (!this.opened) {
      this.opened = true;
      if (this.tailBytes > 0 && size > this.tailBytes) {
        // start near the tail, then drop the first (almost certainly partial) line
        this.offset = size - this.tailBytes;
        const lines = await this.readFrom(size);
        if (lines.length > 0) lines.shift(); // discard the leading partial line
        return lines;
      }
      this.offset = 0;
    }

    // rotation / truncation: file shrank below where we were reading
    if (size < this.offset) {
      this.reset();
    }
    if (size === this.offset) return [];

    return this.readFrom(size);
  }

  private async readFrom(size: number): Promise<string[]> {
    const length = size - this.offset;
    if (length <= 0) return [];

    const fh = await fs.open(this.filePath, "r");
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, this.offset);
      this.offset += bytesRead;

      this.lineBuffer += this.decoder.write(buf.subarray(0, bytesRead));
      const parts = this.lineBuffer.split("\n");
      this.lineBuffer = parts.pop() ?? ""; // last element is the incomplete tail
      return parts.map((l) => l.replace(/\r$/, "")).filter((l) => l.length > 0);
    } finally {
      await fh.close();
    }
  }

  /** Reset to re-read from the start of the (rotated) file. */
  reset(): void {
    this.offset = 0;
    this.lineBuffer = "";
    this.decoder = new StringDecoder("utf8"); // drop any buffered partial multi-byte char
    this.opened = true;
  }

  get bytesRead(): number {
    return this.offset;
  }
}
