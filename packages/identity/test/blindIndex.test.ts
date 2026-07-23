import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { env } from "@leadwolf/config";
import { blindIndex, blindIndexHex } from "../src/blindIndex.ts";

describe("blindIndex", () => {
  test("returns 32 raw bytes", () => {
    const idx = blindIndex("jane@example.com");
    expect(idx).toBeInstanceOf(Uint8Array);
    expect(idx.length).toBe(32);
  });
  test("is deterministic", () => {
    expect(blindIndexHex("jane@example.com")).toBe(blindIndexHex("jane@example.com"));
  });
  test("distinct inputs → distinct indexes", () => {
    expect(blindIndexHex("jane@example.com")).not.toBe(blindIndexHex("john@example.com"));
  });
  test("is HMAC-SHA256 over env.BLIND_INDEX_KEY (the master-graph convention)", () => {
    const expected = createHmac("sha256", env.BLIND_INDEX_KEY)
      .update("jane@example.com", "utf8")
      .digest("hex");
    expect(blindIndexHex("jane@example.com")).toBe(expected);
  });
  test("blindIndexHex is the hex of the raw bytes (64 chars)", () => {
    expect(blindIndexHex("x")).toBe(Buffer.from(blindIndex("x")).toString("hex"));
    expect(blindIndexHex("x")).toHaveLength(64);
  });
});
