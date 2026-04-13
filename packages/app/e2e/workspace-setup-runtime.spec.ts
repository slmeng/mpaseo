import { existsSync } from "node:fs";
import { expect, test } from "./fixtures";
import { createTempGitRepo } from "./helpers/workspace";
import { clickTerminal, waitForTabBar } from "./helpers/launcher";
import {
  connectWorkspaceSetupClient,
  createWorkspaceThroughDaemon,
  findWorktreeWorkspaceForProject,
  openHomeWithProject,
} from "./helpers/workspace-setup";

test.describe("Workspace setup runtime authority", () => {
  test.describe.configure({ retries: 1 });

  test("worktree workspace is created in its own directory", async ({ page }) => {
    test.setTimeout(90_000);

    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("workspace-setup-chat-");

    try {
      await client.openProject(repo.path);
      const workspace = await createWorkspaceThroughDaemon(client, {
        cwd: repo.path,
        worktreeSlug: `setup-chat-${Date.now()}`,
      });

      const wsInfo = await findWorktreeWorkspaceForProject(client, repo.path);
      expect(wsInfo.workspaceDirectory).not.toBe(repo.path);
      expect(existsSync(wsInfo.workspaceDirectory)).toBe(true);

      // Navigate to the workspace via sidebar
      await openHomeWithProject(page, repo.path);
      const wsButton = page.getByRole("button", { name: workspace.name });
      await expect(wsButton).toBeVisible({ timeout: 30_000 });
      await wsButton.click();
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("first terminal opens in the created workspace directory", async ({ page }) => {
    test.setTimeout(90_000);

    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("workspace-setup-terminal-");

    try {
      await client.openProject(repo.path);

      // Create workspace via daemon API since the new workspace screen
      // no longer has a standalone terminal button
      const worktreeSlug = `setup-terminal-${Date.now()}`;
      const result = await client.createPaseoWorktree({
        cwd: repo.path,
        worktreeSlug,
      });
      if (!result.workspace || result.error) {
        throw new Error(result.error ?? "Failed to create workspace");
      }
      const workspaceDir = result.workspace.workspaceDirectory;
      const workspaceName = result.workspace.name;

      // Navigate to the worktree workspace via sidebar click (direct URL
      // navigation for freshly created worktree workspaces can race with
      // Expo Router hydration, so we use the sidebar which is authoritative).
      await openHomeWithProject(page, repo.path);
      const sidebarWorkspace = page.getByRole("button", { name: workspaceName });
      await expect(sidebarWorkspace).toBeVisible({ timeout: 30_000 });
      await sidebarWorkspace.click();
      await waitForTabBar(page);

      await clickTerminal(page);

      const terminal = page.locator('[data-testid="terminal-surface"]');
      await expect(terminal.first()).toBeVisible({ timeout: 20_000 });

      // Verify terminal is listed under the worktree directory, not the original repo
      await expect
        .poll(async () => (await client.listTerminals(workspaceDir)).terminals.length > 0, {
          timeout: 30_000,
        })
        .toBe(true);
      expect((await client.listTerminals(repo.path)).terminals.length).toBe(0);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
});
