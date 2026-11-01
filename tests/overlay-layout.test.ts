import { describe, expect, it } from "vitest";
import { stageScale } from "../overlay/src/layout.js";

describe("overlay stage scaling", () => {
  it("fits and centers the 1920x1080 stage using the limiting viewport dimension", () => {
    expect(stageScale(1920, 1080)).toBe(1);
    expect(stageScale(1280, 720)).toBeCloseTo(2 / 3);
    expect(stageScale(1920, 800)).toBeCloseTo(800 / 1080);
  });

  it("returns zero for a zero-sized viewport", () => {
    expect(stageScale(0, 720)).toBe(0);
  });
});
