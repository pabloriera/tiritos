import { describe, expect, it } from "vitest";

describe("development endpoints", () => {
  it("uses relative browser routes", () => {
    expect("/api/maps").toMatch(/^\/api/);
    expect("/ws").toMatch(/^\/ws/);
  });
});
