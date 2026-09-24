import { randomBytes } from "node:crypto";

// nanoid's URL-safe alphabet: 64 symbols, so each random byte maps without bias.
const ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

/** Random URL-safe id (same alphabet and entropy per character as nanoid). */
export function shortId(size = 8): string {
  const bytes = randomBytes(size);
  let id = "";
  for (let index = 0; index < size; index += 1) id += ALPHABET[bytes[index]! & 63];
  return id;
}
