import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const BASE = "http://localhost:3210";
const logs = [];

function log(line) {
  console.log(line);
  logs.push(line);
}

async function waitForSettled(page, timeoutMs = 240000) {
  const start = Date.now();
  let sawBusy = false;
  while (Date.now() - start < timeoutMs) {
    const stopVisible = await page.locator(".stop-btn").isVisible().catch(() => false);
    const thinkingVisible = await page.locator(".thinking-indicator").isVisible().catch(() => false);
    if (stopVisible || thinkingVisible) {
      sawBusy = true;
    }
    const assistantCount = await page.locator(".msg-assistant .msg-bubble").count();
    const hasError = Boolean((await page.locator(".error-text").textContent().catch(() => ""))?.trim());
    if ((!stopVisible && !thinkingVisible) && (assistantCount > 0 || hasError || sawBusy)) {
      return true;
    }
    await page.waitForTimeout(800);
  }
  return false;
}

async function dismissOnboardingIfPresent(page) {
  const modal = page.locator(".onboarding-modal");
  if (!(await modal.isVisible().catch(() => false))) return;
  for (let i = 0; i < 4; i += 1) {
    const finish = page.locator(".onboarding-footer button", { hasText: "Finish setup" });
    if (await finish.isVisible().catch(() => false)) {
      await finish.click();
      await page.waitForTimeout(200);
      return;
    }
    const next = page.locator(".onboarding-footer button", { hasText: "Next" });
    if (await next.isVisible().catch(() => false)) {
      await next.click();
      await page.waitForTimeout(150);
    }
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  log("=== CARD RUN: START ===");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1400);
  await dismissOnboardingIfPresent(page);
  await page.evaluate(async () => {
    await fetch("/api/sessions", { method: "DELETE" }).catch(() => {});
    await fetch("/api/sessions", { method: "POST" }).catch(() => {});
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  // ensure fresh thread
  await page.click('button[title="New thread"]');
  await page.waitForTimeout(1000);
  const firstRow = page.locator(".session-row").first();
  if (await firstRow.isVisible().catch(() => false)) {
    await firstRow.click();
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: "audit/card-run-01-new-thread.png", fullPage: true });

  // choose one PMM card (index 2: Launch Messaging Kit)
  await page.locator(".empty-action-btn").nth(2).click();
  await page.waitForTimeout(250);
  const promptPreview = await page.locator(".composer-textarea").inputValue();
  await page.fill(".composer-textarea", `${promptPreview}\n\nKeep the response concise (<=120 words) and actionable.`);
  log(`selected_prompt_chars=${promptPreview.length}`);
  await page.screenshot({ path: "audit/card-run-02-card-selected.png", fullPage: true });

  const sendBtn = page.locator(".send-btn");
  const sendVisible = await sendBtn.isVisible().catch(() => false);
  const sendEnabled = sendVisible ? await sendBtn.isEnabled().catch(() => false) : false;
  log(`send_enabled=${sendEnabled}`);
  if (sendEnabled) {
    await sendBtn.click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: "audit/card-run-03-in-progress.png", fullPage: true });
  } else {
    log("send_not_triggered");
  }

  const settled = await waitForSettled(page, 240000);
  log(`stream_settled=${settled}`);

  const toolCards = await page.locator(".msg-inline-tool").count();
  const assistantBubbles = await page.locator(".msg-assistant .msg-bubble").count();
  const userBubbles = await page.locator(".msg-user .msg-bubble").count();
  const errorText = (await page.locator(".error-text").textContent().catch(() => ""))?.trim() ?? "";
  log(`tool_cards=${toolCards}`);
  log(`assistant_bubbles=${assistantBubbles}`);
  log(`user_bubbles=${userBubbles}`);
  log(`error_text=${errorText || "none"}`);

  await page.screenshot({ path: "audit/card-run-04-complete.png", fullPage: true });
  writeFileSync("audit/card-run-report.txt", logs.join("\n"), "utf8");
  await browser.close();
})();

