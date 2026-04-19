import { createRequire } from "node:module";

type CliPackageJson = {
  version?: unknown;
};

const require = createRequire(import.meta.url);

export function resolveCliVersion(): string {
  const packageJson = require("../../package.json") as CliPackageJson;
  if (typeof packageJson.version === "string" && packageJson.version.trim().length > 0) {
    return packageJson.version.trim();
  }
  throw new Error("Unable to resolve @getpaseo/cli version from package.json.");
}

export function resolveCliVersionOrUnknown(): string {
  try {
    return resolveCliVersion();
  } catch {
    return "unknown";
  }
}
