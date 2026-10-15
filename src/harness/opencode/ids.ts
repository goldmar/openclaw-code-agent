import { randomBytes } from "node:crypto";
// Port of @opencode/schema Identifier.ascending (MIT), v2.0.29.
let lastTimestamp = 0;
let counter = 0;
export function newMessageId(timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  const value = BigInt(timestamp) * 0x1000n + BigInt(++counter);
  const time = Array.from({ length: 6 }, (_, i) =>
    Number((value >> BigInt(40 - 8 * i)) & 255n)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
  const chars =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return (
    "msg_" + time + Array.from(randomBytes(14), (b) => chars[b % 62]).join("")
  );
}
