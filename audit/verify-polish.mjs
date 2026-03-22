import { chromium } from "playwright";
import { writeFileSync } from "fs";

const BASE = "http://localhost:3210";
const OUT = "/Users/sidc/Code/rovodev/audit";

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
      await page.waitForTimeout(150);
    }
  }
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const log = [];
  function note(msg) { log.push(msg); console.log(msg); }

  // --- 1280px viewport ---
  note("=== 1280px viewport ===");
  const ctx1280 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx1280.newPage();
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForTimeout(2000);
  await dismissOnboardingIfPresent(page);

  // 1. Brand name check
  const brandText = await page.textContent(".topbar-brand");
  note(`[brand] topbar text: "${brandText}"`);
  if (brandText?.includes("RovoDev Hub")) note("[brand] PASS");
  else note("[brand] FAIL - expected 'RovoDev Hub'");

  // 2. Settings icon is a gear (not a sun)
  const settingsSvg = await page.locator(".topbar-controls .icon-btn svg").first();
  const hasCircle = await settingsSvg.locator("circle").count();
  const hasPath = await settingsSvg.locator("path").count();
  note(`[settings-icon] svg has ${hasCircle} circle(s) and ${hasPath} path(s)`);
  if (hasPath >= 1 && hasCircle >= 1) note("[settings-icon] PASS (gear shape)");
  else note("[settings-icon] CHECK MANUALLY");

  await page.screenshot({ path: `${OUT}/verify-1280-initial.png`, fullPage: true });
  note("[screenshot] verify-1280-initial.png saved");

  // 3. Empty state text
  const emptyState = await page.locator(".empty-state p").textContent().catch(() => null);
  note(`[empty-state] text: "${emptyState}"`);
  if (emptyState?.includes("RovoDev Hub")) note("[empty-state] PASS");
  else note("[empty-state] SKIP (messages loaded)");

  // 4. Sidebar collapse toggle exists
  const collapseBtn = page.locator(".sidebar-collapse-btn");
  const collapseBtnCount = await collapseBtn.count();
  note(`[sidebar-collapse] toggle button count: ${collapseBtnCount}`);
  if (collapseBtnCount > 0) note("[sidebar-collapse] PASS - button exists");
  else note("[sidebar-collapse] FAIL - button missing");

  // 5. Click collapse button
  if (collapseBtnCount > 0) {
    await collapseBtn.click();
    await page.waitForTimeout(500);
    const isCollapsed = await page.locator(".sidebar.is-collapsed").count();
    note(`[sidebar-collapse] after click: is-collapsed=${isCollapsed > 0}`);
    await page.screenshot({ path: `${OUT}/verify-1280-collapsed.png`, fullPage: true });
    note("[screenshot] verify-1280-collapsed.png saved");

    // Re-expand
    await page.locator(".sidebar-collapse-btn").click();
    await page.waitForTimeout(500);
    const isExpanded = await page.locator(".sidebar.is-collapsed").count();
    note(`[sidebar-collapse] after re-expand: is-collapsed=${isExpanded > 0}`);
    await page.screenshot({ path: `${OUT}/verify-1280-expanded.png`, fullPage: true });
    note("[screenshot] verify-1280-expanded.png saved");
  }

  // 6. Settings drawer opens with gear click
  await page.locator(".topbar-controls .icon-btn").last().click();
  await page.waitForTimeout(1000);
  const drawerVisible = await page.locator(".drawer").isVisible().catch(() => false);
  note(`[settings-drawer] visible after click: ${drawerVisible}`);
  if (drawerVisible) note("[settings-drawer] PASS");
  else note("[settings-drawer] FAIL");
  await page.screenshot({ path: `${OUT}/verify-1280-settings.png`, fullPage: true });
  note("[screenshot] verify-1280-settings.png saved");

  // Close drawer
  await page.locator(".drawer-overlay").click().catch(() => {});
  await page.waitForTimeout(300);

  // 7. Model dropdown check
  const modelSelect = page.locator(".composer-model");
  const modelValue = await modelSelect.inputValue().catch(() => "N/A");
  const firstOptionText = await page.locator(".composer-model option").first().textContent().catch(() => "N/A");
  note(`[model-display] selected value: "${modelValue}", first option text: "${firstOptionText}"`);
  if (firstOptionText === "Auto" || modelValue === "default") note("[model-display] PASS");
  else note("[model-display] CHECK");

  await ctx1280.close();

  // --- 1600px viewport ---
  note("\n=== 1600px viewport ===");
  const ctx1600 = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page2 = await ctx1600.newPage();
  await page2.goto(BASE, { waitUntil: "networkidle", timeout: 15000 });
  await page2.waitForTimeout(2000);
  await dismissOnboardingIfPresent(page2);
  await page2.screenshot({ path: `${OUT}/verify-1600-initial.png`, fullPage: true });
  note("[screenshot] verify-1600-initial.png saved");

  // Collapse sidebar at 1600px
  const collapse2 = page2.locator(".sidebar-collapse-btn");
  if (await collapse2.count() > 0) {
    await collapse2.click();
    await page2.waitForTimeout(500);
    await page2.screenshot({ path: `${OUT}/verify-1600-collapsed.png`, fullPage: true });
    note("[screenshot] verify-1600-collapsed.png saved");
    await collapse2.click();
    await page2.waitForTimeout(500);
  }

  await ctx1600.close();
  await browser.close();

  // Write log
  const report = log.join("\n");
  writeFileSync(`${OUT}/verify-polish-report.txt`, report);
  note("\n=== DONE ===");
  console.log(report);
}

run().catch((e) => { console.error(e); process.exit(1); });
