// Capture real cockpit states for the deck: cold open → full run at the gate → staged write.
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
  });
  page.setDefaultTimeout(240_000);

  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await page.waitForSelector("text=Start consultation");
  await page.waitForTimeout(800);
  await page.screenshot({ path: "assets/shot-cold-open.png" });
  console.log("✓ cold open");

  await page.click("text=Start consultation");
  // Catch the run mid-flight (~25s in: translate/roles/structuring active) for a "working" frame.
  await page.waitForTimeout(25_000);
  await page.screenshot({ path: "assets/shot-midrun.png" });
  console.log("✓ mid-run");

  await page.waitForSelector(".btn-approve", { timeout: 240_000 });
  await page.waitForTimeout(2_500); // let the last panel settle
  await page.screenshot({ path: "assets/shot-gate.png" });
  console.log("✓ gate");

  // The HITL gate requires confirming at least one consideration before approving.
  await page.click(".consideration");
  await page.waitForTimeout(600);
  await page.click(".btn-approve");
  await page.waitForSelector(".receipt-stamp", { timeout: 90_000 });
  await page.waitForTimeout(1_200);
  await page.screenshot({ path: "assets/shot-staged.png" });
  console.log("✓ staged");

  await browser.close();
})().catch((e) => { console.error("CAPTURE FAILED:", e.message); process.exit(1); });
