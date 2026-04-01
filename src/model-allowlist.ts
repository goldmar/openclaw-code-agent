export function isModelAllowed(model: string | undefined, allowedModels: string[] | undefined): boolean {
  if (!allowedModels || allowedModels.length === 0) return true;
  if (!model) return false;
  const modelLower = model.toLowerCase();
  return allowedModels.some((pattern) => modelLower.includes(pattern.toLowerCase()));
}
