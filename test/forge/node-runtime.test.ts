import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const NODE_MAJOR = "24";
const NODE_ENGINE_RANGE = ">=24 <25";

function readProjectFile(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf-8").trim();
}

describe("Node runtime configuration", () => {
  it("keeps Forge, package, type, and local version settings on Node 24", () => {
    const manifest = parseYaml(readProjectFile("manifest.yml")) as {
      app?: { runtime?: { name?: string } };
    };
    const packageJson = JSON.parse(readProjectFile("package.json")) as {
      engines?: { node?: string };
      devDependencies?: Record<string, string>;
    };

    expect(manifest.app?.runtime?.name).toBe(`nodejs${NODE_MAJOR}.x`);
    expect(packageJson.engines?.node).toBe(NODE_ENGINE_RANGE);
    expect(packageJson.devDependencies?.["@types/node"]).toMatch(
      new RegExp(`^\\^${NODE_MAJOR}\\.`),
    );
    expect(readProjectFile(".nvmrc")).toBe(NODE_MAJOR);
    expect(readProjectFile(".node-version")).toBe(NODE_MAJOR);
  });
});
