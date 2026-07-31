import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { stat } from "node:fs/promises";

export class NpmSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NpmSourceError";
  }
}

/** npm package name grammar (scoped or unscoped), per the npm registry rules. */
const VALID_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * Split an `npm:` specifier body into package name and optional subpath.
 * `@scope/pkg/skills/review` → { packageName: "@scope/pkg", subpath: "skills/review" }
 * `pkg` → { packageName: "pkg" }
 */
export function parseNpmSpecifier(specifier: string): {
  packageName: string;
  subpath?: string;
} {
  const parts = specifier.split("/");
  const nameSegments = specifier.startsWith("@") ? 2 : 1;
  const packageName = parts.slice(0, nameSegments).join("/");

  if (parts.length < nameSegments || !VALID_PACKAGE_NAME.test(packageName)) {
    throw new NpmSourceError(`Invalid npm package specifier: "npm:${specifier}"`);
  }

  const subpath = parts.slice(nameSegments).join("/");
  return subpath ? { packageName, subpath } : { packageName };
}

/**
 * Locate the root directory of an installed package using Node's own module
 * resolution, so pnpm symlink layouts, workspace hoisting, and Yarn PnP all
 * work. Packages whose `exports` map doesn't expose `./package.json` fall back
 * to a manual node_modules walk (the same ancestor chain Node itself uses).
 */
async function resolvePackageRoot(
  projectRoot: string,
  packageName: string,
): Promise<string> {
  const requireFromProject = createRequire(join(projectRoot, "package.json"));
  try {
    return dirname(requireFromProject.resolve(`${packageName}/package.json`));
  } catch {
    // ERR_PACKAGE_PATH_NOT_EXPORTED (or a missing main entry) — walk node_modules.
  }

  for (let dir = projectRoot; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ...packageName.split("/"));
    try {
      if ((await stat(join(candidate, "package.json"))).isFile()) {
        return candidate;
      }
    } catch {
      // keep walking
    }
    if (dirname(dir) === dir) {break;}
  }

  throw new NpmSourceError(
    `npm package "${packageName}" is not installed (resolved from ${projectRoot}). ` +
      `Install it with your package manager first.`,
  );
}

/**
 * Resolve an `npm:` source (sans prefix) to an absolute directory inside the
 * installed package. Mirrors `path:` semantics: the specifier points at a
 * directory; wildcard discovery and `path` scoping happen downstream.
 */
export async function resolveNpmSource(
  projectRoot: string,
  specifier: string,
): Promise<string> {
  const { packageName, subpath } = parseNpmSpecifier(specifier);
  const packageRoot = await resolvePackageRoot(resolve(projectRoot), packageName);

  const absPath = subpath ? resolve(packageRoot, subpath) : packageRoot;

  // Prevent subpath traversal outside the package
  if (absPath !== packageRoot && !absPath.startsWith(`${packageRoot}/`)) {
    throw new NpmSourceError(
      `npm source "npm:${specifier}" resolves outside package "${packageName}"`,
    );
  }

  let s;
  try {
    s = await stat(absPath);
  } catch {
    throw new NpmSourceError(`npm source not found: ${absPath}`);
  }

  if (!s.isDirectory()) {
    throw new NpmSourceError(`npm source is not a directory: ${absPath}`);
  }

  return absPath;
}
