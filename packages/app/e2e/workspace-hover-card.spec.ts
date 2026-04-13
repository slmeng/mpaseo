import { test, expect } from "./fixtures";
import { createTempGitRepo } from "./helpers/workspace";
import { waitForWorkspaceTabsVisible } from "./helpers/workspace-tabs";
import {
  connectWorkspaceSetupClient,
  createWorkspaceThroughDaemon,
  openHomeWithProject,
  seedProjectForWorkspaceSetup,
  waitForWorkspaceSetupProgress,
} from "./helpers/workspace-setup";
import type { Page } from "@playwright/test";

function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set.");
  }
  return serverId;
}

// ---------------------------------------------------------------------------
// Composable helpers
// ---------------------------------------------------------------------------

/** Waits for the globe icon to appear on a workspace row (proves scripts are running). */
async function expectGlobeIcon(page: Page): Promise<void> {
  await expect(page.getByTestId("workspace-globe-icon")).toBeVisible({ timeout: 30_000 });
}

/** Hovers the workspace row (by visible name) and waits for the hover card to appear. */
async function expectHoverCard(page: Page, workspaceName: string): Promise<void> {
  const row = page.getByRole("button", { name: workspaceName }).first();
  await row.hover();
  await expect(page.getByTestId("workspace-hover-card")).toBeVisible({ timeout: 10_000 });
}

/** Asserts that a script row with the given name exists in the hover card. */
async function expectScriptInCard(page: Page, scriptName: string): Promise<void> {
  const card = page.getByTestId("workspace-hover-card");
  await expect(card.getByTestId(`hover-card-script-${scriptName}`)).toBeVisible({
    timeout: 10_000,
  });
}

/** Asserts the script status dot indicates "running". */
async function expectScriptRunning(page: Page, scriptName: string): Promise<void> {
  const card = page.getByTestId("workspace-hover-card");
  await expect(card.getByTestId(`hover-card-script-status-${scriptName}`)).toHaveAttribute(
    "aria-label",
    "Running",
    { timeout: 10_000 },
  );
}

/** Asserts the script lifecycle is stopped. */
async function expectScriptStopped(page: Page, scriptName: string): Promise<void> {
  const card = page.getByTestId("workspace-hover-card");
  await expect(card.getByTestId(`hover-card-script-status-${scriptName}`)).toHaveAttribute(
    "aria-label",
    "Stopped",
    { timeout: 10_000 },
  );
}

/** Asserts the script health label shown in the hover card. */
async function expectScriptHealth(
  page: Page,
  scriptName: string,
  health: "Healthy" | "Unhealthy" | "Unknown",
): Promise<void> {
  const card = page.getByTestId("workspace-hover-card");
  await expect(card.getByTestId(`hover-card-script-health-${scriptName}`)).toHaveAttribute(
    "aria-label",
    health,
    { timeout: 10_000 },
  );
}

/** Asserts the hover card contains the workspace name. */
async function expectWorkspaceNameInCard(page: Page, name: string): Promise<void> {
  const card = page.getByTestId("workspace-hover-card");
  await expect(card.getByTestId("hover-card-workspace-name")).toContainText(name, {
    timeout: 10_000,
  });
}

/** Moves the mouse away from the sidebar and asserts the hover card disappears. */
async function expectHoverCardDismissed(page: Page): Promise<void> {
  // Move mouse to the center of the viewport (away from sidebar)
  const viewport = page.viewportSize();
  await page.mouse.move((viewport?.width ?? 1280) / 2, (viewport?.height ?? 720) / 2);
  await expect(page.getByTestId("workspace-hover-card")).not.toBeVisible({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Workspace hover card", () => {
  test("shows hover card with scripts when hovering a workspace with running scripts", async ({
    page,
  }) => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("hovercard-svc-", {
      paseoConfig: {
        worktree: {
          setup: ["sh -c 'echo bootstrapping; sleep 1; echo setup complete'"],
        },
        scripts: {
          web: {
            command:
              "node -e \"const http = require('http'); const s = http.createServer((q,r) => r.end('ok')); s.listen(process.env.PORT || 3000, () => console.log('listening on ' + s.address().port))\"",
          },
        },
      },
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);

      // Wait for setup completion via daemon (setup snapshots are per-session)
      const completed = waitForWorkspaceSetupProgress(
        client,
        (payload) =>
          payload.status === "completed" && payload.detail.log.includes("setup complete"),
      );
      const workspace = await createWorkspaceThroughDaemon(client, {
        cwd: repo.path,
        worktreeSlug: `hovercard-${Date.now()}`,
      });
      await completed;

      await openHomeWithProject(page, repo.path);
      const wsRow = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.id}`);
      await expect(wsRow).toBeVisible({ timeout: 30_000 });
      await wsRow.click();
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });

      await waitForWorkspaceTabsVisible(page);

      // Wait for the globe icon — proves scripts are running and client has the data
      await expectGlobeIcon(page);

      // Hover the workspace row — hover card should appear
      await expectHoverCard(page, workspace.name);

      // Assert the card shows the workspace name
      await expectWorkspaceNameInCard(page, workspace.name);

      // Assert the "web" script entry exists in the card
      await expectScriptInCard(page, "web");

      // Assert the status dot shows "running"
      await expectScriptRunning(page, "web");

      // Assert the script row is a link (has role="link")
      const card = page.getByTestId("workspace-hover-card");
      const serviceLink = card.getByRole("link", { name: "web script" });
      await expect(serviceLink).toBeVisible({ timeout: 10_000 });

      // Move mouse away — card should dismiss
      await expectHoverCardDismissed(page);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("shows stopped scripts and starts them from the hover card", async ({ page }) => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("hovercard-start-", {
      paseoConfig: {
        scripts: {
          web: {
            command:
              "node -e \"const http = require('http'); const s = http.createServer((q,r) => r.end('ok')); s.listen(process.env.PORT || 3000, '127.0.0.1', () => console.log('listening on ' + s.address().port))\"",
          },
        },
      },
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      const workspace = await client.openProject(repo.path);
      if (!workspace.workspace || workspace.error) {
        throw new Error(workspace.error ?? `Failed to open project ${repo.path}`);
      }

      await openHomeWithProject(page, repo.path);
      const wsRow = page.getByTestId(
        `sidebar-workspace-row-${getServerId()}:${workspace.workspace.id}`,
      );
      await expect(wsRow).toBeVisible({ timeout: 30_000 });

      await expectHoverCard(page, workspace.workspace.name);
      await expectWorkspaceNameInCard(page, workspace.workspace.name);
      await expectScriptInCard(page, "web");
      await expectScriptStopped(page, "web");
      await expectScriptHealth(page, "web", "Unknown");

      const card = page.getByTestId("workspace-hover-card");
      const startButton = card.getByTestId("hover-card-script-start-web");
      await expect(startButton).toBeVisible({ timeout: 10_000 });
      await startButton.click();

      await expectScriptRunning(page, "web");
      await expectScriptHealth(page, "web", "Healthy");
      await expect(card.getByRole("link", { name: "web script" })).toBeVisible({ timeout: 10_000 });
      await expect(startButton).not.toBeVisible({ timeout: 10_000 });
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
});
