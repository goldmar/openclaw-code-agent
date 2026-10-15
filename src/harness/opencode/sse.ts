/** Incremental SSE decoder; supports CRLF, split UTF-8, comments and multiline data. */
export async function* sseFrames(
  response: Response,
): AsyncGenerator<{ event: string; data: unknown }> {
  if (!response.body) throw new Error("OpenCode SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += chunk.done
        ? decoder.decode()
        : decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.search(/[\r\n]/)) >= 0) {
        if (buffer[end] === "\r" && end === buffer.length - 1 && !chunk.done)
          break;
        const line = buffer.slice(0, end);
        const width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(end + width);
        if (!line) {
          if (data.length) {
            const raw = data.join("\n");
            yield { event, data: JSON.parse(raw) };
          }
          event = "message";
          data = [];
        } else if (line.startsWith("data:"))
          data.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith("event:")) event = line.slice(6).trim();
      }
      if (chunk.done) break;
    }
  } finally {
    await reader.cancel().catch((): undefined => undefined);
    reader.releaseLock();
  }
}
