import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = "http://localhost:3210";
const OUT_DIR = "audit";
const SHOTS = [];

function note(msg) {
  console.log(msg);
  SHOTS.push(msg);
}

async function shot(page, name) {
  const path = `${OUT_DIR}/${name}`;
  await page.screenshot({ path, fullPage: true });
  note(`[screenshot] ${path}`);
}

async function waitForSettled(page, timeoutMs = 70000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const stopVisible = await page.locator(".stop-btn").isVisible().catch(() => false);
    const thinkingVisible = await page.locator(".thinking-indicator").isVisible().catch(() => false);
    if (!stopVisible && !thinkingVisible) return true;
    await page.waitForTimeout(450);
  }
  return false;
}

async function clickIfVisible(page, selector) {
  const loc = page.locator(selector);
  if (await loc.isVisible().catch(() => false)) {
    await loc.click();
    return true;
  }
  return false;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const page = await context.newPage();

  note("=== WOW AUDIT: FIRST RUN TO END ===");
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 20000 });
  await page.waitForTimeout(1500);

  await shot(page, "wow-01-first-load-onboarding.png");

  // Step 1: Welcome -> Next
  await clickIfVisible(page, '.onboarding-footer button:has-text("Next")');
  await page.waitForTimeout(300);
  await shot(page, "wow-02-onboarding-auth.png");

  // Step 2: Re-check auth (idempotent) -> Next
  await clickIfVisible(page, '.onboarding-step button:has-text("Re-check auth")');
  await page.waitForTimeout(800);
  await shot(page, "wow-03-onboarding-auth-checked.png");
  await clickIfVisible(page, '.onboarding-footer button:has-text("Next")');
  await page.waitForTimeout(300);

  // Step 3: Backend controls -> Next
  await shot(page, "wow-04-onboarding-backend.png");
  // try start once (safe if already running)
  await clickIfVisible(page, '.onboarding-step button:has-text("Start backend")');
  await page.waitForTimeout(1200);
  await shot(page, "wow-05-onboarding-backend-action.png");
  await clickIfVisible(page, '.onboarding-footer button:has-text("Next")');
  await page.waitForTimeout(300);

  // Step 4: Finish
  await shot(page, "wow-06-onboarding-ready.png");
  await clickIfVisible(page, '.onboarding-footer button:has-text("Finish setup")');
  await page.waitForTimeout(700);
  await shot(page, "wow-07-post-onboarding-home.png");

  // New thread + prompt chips
  await page.click('button[title="New thread"]');
  await page.waitForTimeout(1200);
  await shot(page, "wow-08-new-thread.png");

  const firstPrompt = page.locator(".empty-action-btn").first();
  if (await firstPrompt.isVisible().catch(() => false)) {
    await firstPrompt.click();
    await page.waitForTimeout(250);
    await shot(page, "wow-09-prompt-chip-selected.png");
  }

  // Send and wait for a real assistant response.
  // Keep this deterministic for audit stability while preserving the PMM card visual.
  await page.fill(".composer-textarea", "Say hello in one sentence.");
  const canSend = await page.locator(".send-btn").isVisible().catch(() => false);
  if (canSend) {
    await page.click(".send-btn");
    await shot(page, "wow-10-streaming.png");
    const settled = await waitForSettled(page, 120000);
    note(`stream_settled=${settled}`);
    await shot(page, "wow-11-response-complete.png");
  }

  // Showcase settings and collapsible rail
  await page.locator(".topbar-controls .icon-btn").last().click();
  await page.waitForTimeout(500);
  await shot(page, "wow-12-settings-open.png");
  await clickIfVisible(page, ".drawer-overlay");
  await page.waitForTimeout(250);

  await clickIfVisible(page, ".sidebar-collapse-btn");
  await page.waitForTimeout(350);
  await shot(page, "wow-13-sidebar-collapsed.png");
  await clickIfVisible(page, ".sidebar-collapse-btn");
  await page.waitForTimeout(350);
  await shot(page, "wow-14-final-state.png");

  await browser.close();
  writeFileSync(`${OUT_DIR}/wow-first-run-report.txt`, SHOTS.join("\n"), "utf8");
  note("Saved audit/wow-first-run-report.txt");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

