export function formatHarnessModelLabel(input: {
  harness?: string;
  model?: string;
}): string | undefined {
  const harness = input.harness?.trim();
  const model = input.model?.trim();
  if (harness && model) return `${harness} | ${model}`;
  if (harness) return `${harness} | default`;
  return model;
}

export function formatHarnessModelSuffix(input: {
  harness?: string;
  model?: string;
}): string {
  const label = formatHarnessModelLabel(input);
  return label ? ` | ${label}` : "";
}
