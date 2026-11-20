// End-to-end browser test of the required user workflow (directive §5).
// Requires a running server (see docs/ADMIN.md#end-to-end-test). Usage:
//   node e2e/workflow.e2e.cjs http://localhost:8010 <screenshot-dir>
const { chromium } = require("playwright");
const path = require("path");

const BASE = process.argv[2] || "http://localhost:8010";
const SHOTS = process.argv[3] || path.join(__dirname, "screenshots");
const EX = path.join(__dirname, "..", "examples", "myers-park-halfway-house");
const step = (m) => console.log("•", m);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("dialog", (d) => d.accept(d.type() === "prompt" ? (d.message().includes("project name") ? "E2E Halfway House" : "e2e") : undefined));
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + ".png") });
  const openNode = async (k) => { await page.click(`[data-testid=node-${k}] >> text=Open`); await page.waitForSelector(`[data-testid=inspector-${k}]`); };
  const clickAll = async (selector) => {
    for (let i = 0; i < 60; i++) {
      const b = page.locator(selector).first();
      if (!(await b.count())) return;
      await b.click();
      await page.waitForTimeout(250);
    }
  };

  step("login");
  await page.goto(BASE);
  await page.fill("input[name=email]", "admin@ossa.studio");
  await page.fill("input[name=password]", "admin-password-1");
  await page.click("button[type=submit]");
  await page.waitForSelector("text=+ New");

  step("create project");
  await page.click("text=+ New");
  await page.waitForSelector("[data-testid=node-N09]");
  await page.waitForSelector("text=Image execution blocked");
  await shot("01-empty-canvas");

  step("upload documents");
  await openNode("N09");
  await page.setInputFiles("[data-testid=file-input]", [
    "MPCC-HH_Project_Description_SAMPLE.txt", "MPCC-HH_Finish_Schedule_SAMPLE.csv",
    "MPCC-HH_Equipment_Schedule_SAMPLE.csv", "render_bar_view_SYNTHETIC.png",
  ].map((f) => path.join(EX, f)));
  await page.waitForSelector("text=MPCC-HH_Equipment_Schedule_SAMPLE.csv");
  await page.waitForSelector("[data-testid=inspector-N09] >> text=Finish schedule / material specification", { timeout: 10000 }).catch(() => {});
  await shot("02-intake");
  await clickAll("[data-testid=inspector-N09] button.ok:has-text('Accept')");

  step("review project understanding + finishes");
  await page.click("[aria-label=Close]");
  await openNode("N01");
  await clickAll("[data-testid=inspector-N01] button:has-text('Approve all shown')");
  await page.click("[aria-label=Close]");
  await openNode("N02");
  await page.waitForSelector("[data-testid=rec-PL2]");
  await shot("03-finishes");
  await clickAll("[data-testid=inspector-N02] button:has-text('Approve all shown')");
  await page.waitForSelector("[data-testid=inspector-N02] .badge:has-text('VALIDATED')");
  await page.click("[aria-label=Close]");

  step("authorise source + draw mask");
  await openNode("N05");
  await page.click("button:has-text('Authorise as source')");
  await page.click("button:has-text('Draw mask')");
  const cv = page.locator("[data-testid=mask-canvas]");
  await cv.scrollIntoViewIfNeeded();
  const bb = await cv.boundingBox();
  await page.mouse.move(bb.x + 2, bb.y + bb.height * 0.645);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width * 0.5, bb.y + bb.height * 0.8, { steps: 8 });
  await page.mouse.move(bb.x + bb.width - 2, bb.y + bb.height * 0.895, { steps: 8 });
  await page.mouse.up();
  await page.fill("[data-testid=mask-editor] input[placeholder^=label]", "cabinet faces");
  await shot("04-mask");
  await page.click("[data-testid=save-mask]");
  await page.waitForSelector("[data-testid=inspector-N05] button.ok:has-text('Approve')");
  await page.click("[data-testid=inspector-N05] button.ok:has-text('Approve')");
  await page.waitForSelector("[data-testid=inspector-N05] .badge:has-text('VALIDATED')");
  await page.click("[aria-label=Close]");

  step("describe intent");
  await openNode("N04");
  await page.selectOption("[data-testid=er-image]", { index: 1 });
  await page.fill("[data-testid=er-instruction]", "Change the lower cabinet faces to PL2. Keep the SS2 backsplash and black separators unchanged.");
  await page.selectOption("[data-testid=er-mask]", { index: 1 });
  await page.click("[data-testid=er-analyse]");
  await page.waitForSelector("[data-testid=er-analysis] >> text=PL2");
  await page.click("[data-testid=er-approve]");
  await page.waitForSelector("text=Continue to Oscillator");
  await shot("05-intent");

  step("oscillator plan + run");
  await page.click("text=Continue to Oscillator");
  await page.waitForSelector("[data-testid=inspector-N07]");
  await page.click("[data-testid=osc-plan]");
  await page.waitForSelector("[data-testid=osc-planresult] >> text=AUTO: openai/gpt-image-1");
  await shot("06-oscillator");
  await page.click("[data-testid=osc-run]");
  await page.waitForSelector("[data-testid=inspector-N07] .pill.ok:has-text('succeeded')", { timeout: 30000 });

  step("review output");
  await page.click("button:has-text('Review')");
  await page.waitForSelector("[data-testid=checks] >> text=VERIFIED pixel-identical");
  await shot("07-review-slider");
  const boxes = page.locator("input[data-testid^=chk-]");
  for (let i = 0; i < (await boxes.count()); i++) {
    const id = await boxes.nth(i).getAttribute("data-testid");
    await boxes.nth(i).click();
    await page.waitForSelector(`input[data-testid=${id}]:checked`);
  }
  await page.click("[data-testid=view-diff]");
  await page.waitForTimeout(500);
  await shot("08-review-diff");
  await page.fill("[data-testid=decision-reason]", "Matches PL2; adjacent finishes untouched.");
  await page.click("[data-testid=approve]");
  await page.waitForSelector("text=approved on");

  step("reload — state persists");
  await page.reload();
  await page.waitForSelector("[data-testid=node-N08] .badge:has-text('VALIDATED')");
  await page.waitForSelector("text=E2E Halfway House");
  await page.click("[aria-label=Close]").catch(() => {});
  await shot("09-after-reload");
  if (errors.length) throw new Error("page errors: " + errors.join("\n"));
  console.log("E2E PASSED");
  await browser.close();
})().catch(async (e) => { console.error("E2E FAILED:", e.message); process.exit(1); });
