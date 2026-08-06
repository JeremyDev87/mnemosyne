import { expect, test } from "@playwright/test";

test("public shell is synthetic and owner entrypoint is visible", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Mnemosyne");
  await expect(page.getByRole("heading", { name: "기억을 저장하는 대신, 흐름을 안전하게 이어갑니다." })).toBeVisible();
  await expect(page.getByRole("link", { name: /소유자 로그인/ })).toHaveAttribute("href", "/login");
  await expect(page.getByText("실제 Wiki를 읽지 않는 synthetic shell")).toBeVisible();
});

test("health endpoint is no-store synthetic", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["cache-control"]).toBe("no-store");
  await expect(response.json()).resolves.toEqual({ status: "ok", runtime: "nextjs", data: "synthetic-only" });
});
