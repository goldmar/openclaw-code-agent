export function formatHarnessModelLabel(input: {
  harness?: string;
  model?: string;
}, options: {
  separator?: string;
} = {}): string | undefined {
  const separator = options.separator ?? " / ";
  const harness = input.harness?.trim();
  const model = input.model?.trim();
  if (harness && model) return `${harness}${separator}${model}`;
  if (harness) return `${harness}${separator}default`;
  return model;
}

export function formatHarnessModelSuffix(input: {
  harness?: string;
  model?: string;
}): string {
  const label = formatHarnessModelLabel(input);
  return label ? ` | ${label}` : "";
}
