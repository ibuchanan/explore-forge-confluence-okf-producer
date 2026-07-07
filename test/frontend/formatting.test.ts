import { describe, expect, it } from "vitest";
import {
  lozengeAppearanceFor,
  stageLabel,
} from "../../src/frontend/formatting";

describe("stageLabel", () => {
  it("maps a known job stage to its display label", () => {
    expect(stageLabel("listing-descendants")).toBe("Listing descendant pages");
  });

  it("falls back to the raw stage value when unknown", () => {
    expect(stageLabel("some-future-stage")).toBe("some-future-stage");
  });
});

describe("lozengeAppearanceFor", () => {
  it("maps ready to success", () => {
    expect(lozengeAppearanceFor("ready")).toBe("success");
  });

  it("maps failed to danger", () => {
    expect(lozengeAppearanceFor("failed")).toBe("danger");
  });

  it("maps cancelled to moved", () => {
    expect(lozengeAppearanceFor("cancelled")).toBe("moved");
  });

  it("maps any other status to inprogress", () => {
    expect(lozengeAppearanceFor("running")).toBe("inprogress");
    expect(lozengeAppearanceFor("queued")).toBe("inprogress");
  });
});
