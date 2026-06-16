import { isAbsolute } from "node:path";

/** Manifest component paths are always relative to the plugin directory. */
export function isSafeComponentPath(value: string): boolean {
  if (value.length === 0) {return false;}
  if (isAbsolute(value)) {return false;}
  if (/^[a-zA-Z]:[\\/]/.test(value)) {return false;}
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {return false;}
  return !value.replaceAll("\\", "/").split("/").includes("..");
}

