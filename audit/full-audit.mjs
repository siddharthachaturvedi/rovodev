import { chromium } from "playwright";
import fs from "node:fs/promises";

const BASE = "http://localhost:3210";
const results = [];

function log(msg) {
  console.log(msg);
  results.push(msg);
}

async function waitForResponseSettled(page, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const stopVisible = await page.locator(".stop-btn").isVisible().catch(() => false);
    const thinkingVisible = await page.locator(".thinking-indicator").isVisible().catch(() => false);
    if (!stopVisible && !thinkingVisible) {
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function countUiMessages(page) {
  const users = await page.locator(".msg-user .msg-bubble").count();
  const assistants = await page.locator(".msg-assistant .msg-bubble").count();
  return { users, assistants };
}

async function getNewestSessionId(page) {
  return await page.evaluate(async () => {
    const res = await fetch("/api/sessions");
    const payload = await res.json();
    return payload?.sessions?.[0]?.id ?? "";
  });
}

async function getHistoryCounts(page, sessionId) {
  return await page.evaluate(async (sid) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/history`);
    const payload = await res.json();
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    const users = messages.filter((m) => m?.kind === "user").length;
    const assistants = messages.filter((m) => m?.kind === "assistant").length;
    return { total: messages.length, users, assistants };
  }, sessionId);
}

async function dismissOnboardingIfPresent(page) {
  const modal = page.locator(".onboarding-modal");
  if (!(await modal.isVisible().catch(() => false))) return;

  for (let i = 0; i < 4; i += 1) {
    const finish = page.locator(".onboarding-footer button", { hasText: "Finish setup" });
    if (await finish.isVisible().catch(() => false)) {
      await finish.click();
      await page.waitForTimeout(300);
      return;
    }
    const next = page.locator(".onboarding-footer button", { hasText: "Next" });
    if (await next.isVisible().catch(() => false)) {
      await next.click();
      await page.waitForTimeout(200);
    }
  }
  await page.keyboard.press("Escape").catch(() => {});
}

async function stabilizeBackendBeforeAudit(page) {
  await page.evaluate(async () => {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    }).catch(() => {});
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reset" }),
    }).catch(() => {});
  });
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  log("\n=== SYNC AUDIT: INITIALIZE ===");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  await dismissOnboardingIfPresent(page);
  await stabilizeBackendBeforeAudit(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "audit/01-initial.png", fullPage: true });

  log("\n=== SYNC AUDIT: CREATE THREAD ===");
  await page.click('button[title="New thread"]');
  await page.waitForTimeout(1500);
  const newSessionId = await getNewestSessionId(page);
  log(`Newest session ID: ${newSessionId || "N/A"}`);
  await page.screenshot({ path: "audit/02-new-thread.png", fullPage: true });

  const prompts = [
    "Say hello in one sentence.",
    "What is 2 + 2? Reply only with the number.",
    "Name three colors, one per line.",
    "Write a short haiku about coding.",
    "Say goodbye in one sentence.",
  ];

  for (let i = 0; i < prompts.length; i += 1) {
    log(`\n=== SYNC AUDIT: MESSAGE ${i + 1}/5 ===`);
    await page.fill(".composer-textarea", prompts[i]);
    await page.click(".send-btn");
    const settled = await waitForResponseSettled(page, 60000);
    const ui = await countUiMessages(page);
    log(`settled=${settled}, ui users=${ui.users}, assistants=${ui.assistants}`);
    await page.screenshot({ path: `audit/03-message-${i + 1}.png`, fullPage: true });
  }

  const uiAfter5 = await countUiMessages(page);
  log(`\nUI counts after 5 sends: users=${uiAfter5.users}, assistants=${uiAfter5.assistants}`);

  if (newSessionId) {
    const history = await getHistoryCounts(page, newSessionId);
    log(`Backend history counts: users=${history.users}, assistants=${history.assistants}, total=${history.total}`);
    log(`UI vs backend user match: ${uiAfter5.users === history.users}`);
    log(`UI vs backend assistant match: ${uiAfter5.assistants === history.assistants}`);
  } else {
    log("WARN: Could not resolve newest session ID for backend comparison.");
  }

  log("\n=== SYNC AUDIT: HARD REFRESH + RESTORE ===");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  await page.locator(".session-row").first().click();
  await page.waitForTimeout(2500);
  const uiAfterRefresh = await countUiMessages(page);
  log(`After refresh restore: users=${uiAfterRefresh.users}, assistants=${uiAfterRefresh.assistants}`);
  await page.screenshot({ path: "audit/04-after-refresh-restore.png", fullPage: true });

  log("\n=== SYNC AUDIT: SWITCH AWAY/BACK ===");
  const rowCount = await page.locator(".session-row").count();
  if (rowCount > 1) {
    await page.locator(".session-row").nth(1).click();
    await page.waitForTimeout(2000);
    await page.locator(".session-row").first().click();
    await page.waitForTimeout(2500);
  }
  const uiAfterSwitchBack = await countUiMessages(page);
  log(`After switch-back: users=${uiAfterSwitchBack.users}, assistants=${uiAfterSwitchBack.assistants}`);
  await page.screenshot({ path: "audit/05-after-switch-back.png", fullPage: true });

  const staleThinking = await page.locator(".thinking-indicator").isVisible().catch(() => false);
  log(`Stale thinking indicator visible: ${staleThinking}`);

  await browser.close();
  await fs.writeFile("audit/audit-results.txt", results.join("\n"), "utf8");
  log("\nSync audit complete. Results saved to audit/audit-results.txt");
})();
