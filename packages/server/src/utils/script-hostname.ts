import { slugify } from "./worktree.js";

export function buildScriptHostname(branchName: string | null, scriptName: string): string {
  const serviceHostnameLabel = slugify(scriptName);
  const isDefaultBranch = branchName === null || branchName === "main" || branchName === "master";

  if (isDefaultBranch) {
    return `${serviceHostnameLabel}.localhost`;
  }

  return `${slugify(branchName)}.${serviceHostnameLabel}.localhost`;
}
