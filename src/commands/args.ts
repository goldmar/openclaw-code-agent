export interface CommandArgToken {
  value: string;
  raw: string;
  start: number;
  end: number;
}

export function tokenizeCommandArgs(raw: string): string[] {
  return tokenizeCommandArgSpans(raw).map((token) => token.value);
}

export function tokenizeCommandArgSpans(raw: string): CommandArgToken[] {
  return Array.from(raw.matchAll(/"[^"]*"|'[^']*'|\S+/g), (match) => {
    const token = match[0];
    const start = match.index ?? 0;
    return {
      value: stripWrappingQuotes(token),
      raw: token,
      start,
      end: start + token.length,
    };
  });
}

export function consumeFirstCommandArg(raw: string): { value: string; rest: string } | undefined {
  const [first] = tokenizeCommandArgSpans(raw);
  if (!first) return undefined;
  return {
    value: first.value,
    rest: raw.slice(first.end).trimStart(),
  };
}

function stripWrappingQuotes(token: string): string {
  if (
    (token.startsWith("\"") && token.endsWith("\""))
    || (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }
  return token;
}
