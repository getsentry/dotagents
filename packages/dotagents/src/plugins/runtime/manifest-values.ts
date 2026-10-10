/** Formats an already validated plugin-relative component path. */
export function runtimePath(value: string): string {
  return value.startsWith(".") ? value : `./${value}`;
}
