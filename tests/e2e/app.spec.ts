import { expect, test } from "@playwright/test";

test("renders the dashboard, wiki search, and guarded editor", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "오늘의 운영 상태" })).toBeVisible();
  await expect(page.getByText("Cloud dashboard 검증")).toBeVisible();

  await page.getByRole("link", { name: "Wiki" }).click();
  await page.getByLabel("Wiki 검색어").fill("주간");
  await page.getByRole("button", { name: "검색" }).click();
  await expect(page.getByText("Personal Tasks Current Ledger")).toBeVisible();

  await page.getByRole("link", { name: "Ops 편집" }).click();
  await expect(page.getByLabel("Markdown 편집기")).toHaveValue(/Personal Tasks Current Ledger/);
  await page.getByRole("button", { name: "변경 검증" }).click();
  await expect(page.getByText("변경 사항이 없습니다.")).toBeVisible();
});
