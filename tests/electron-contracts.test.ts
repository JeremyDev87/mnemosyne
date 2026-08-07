import { describe, expect, it } from "vitest";
import {
  documentRequestSchema,
  searchRequestSchema
} from "../src/electron/contracts";
import { isAllowedNavigation, secureWebPreferences } from "../src/electron/security";

describe("Electron capability boundary", () => {
  it("accepts only bounded search and opaque document requests", () => {
    expect(searchRequestSchema.parse({ query: " 일정 ", limit: 5 })).toEqual({ query: "일정", limit: 5 });
    expect(() => searchRequestSchema.parse({ query: "", limit: 5 })).toThrow();
    expect(() => searchRequestSchema.parse({ query: "x".repeat(201), limit: 5 })).toThrow();
    expect(() => searchRequestSchema.parse({ query: "일정", limit: 21 })).toThrow();

    const id = "a".repeat(64);
    expect(documentRequestSchema.parse({ documentId: id })).toEqual({ documentId: id });
    expect(() => documentRequestSchema.parse({ documentId: "../private.md" })).toThrow();
  });

  it("keeps renderer and preload sandboxed without Node authority", () => {
    expect(secureWebPreferences("/trusted/preload.js")).toEqual(expect.objectContaining({
      preload: "/trusted/preload.js",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }));
  });

  it("allows only the exact initial renderer entry navigation", () => {
    const rendererEntry = "mnemosyne://renderer/main_window/index.html";
    expect(isAllowedNavigation(rendererEntry, rendererEntry)).toBe(true);
    expect(isAllowedNavigation("https://example.com", rendererEntry)).toBe(false);
    expect(isAllowedNavigation("file:///private/wiki/secret.md", rendererEntry)).toBe(false);
  });
});
