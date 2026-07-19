/**
 * Forge storage manifest tests
 *
 * API request syntax and deprecated import patterns are covered by
 * Forge Prelint. This file keeps the cross-file check that links code imports
 * to manifest scopes.
 *
 * @see {@link https://developer.atlassian.com/platform/forge/runtime-reference/storage-api-custom-entities/|Hosted storage overview}
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { findImports, parseSourceFile } from "./ast-helpers";
import { getAllTypeScriptFiles } from "./filesystem-helpers";
import { getManifestScopes, loadManifest } from "./manifest-helpers";

describe("Forge storage manifest scopes", () => {
  const srcPath = path.join(process.cwd(), "src");

  it("should declare storage:app when @forge/kvs is used", () => {
    const manifest = loadManifest();
    const manifestScopes = new Set(getManifestScopes(manifest));
    const files = getAllTypeScriptFiles(srcPath);

    const kvsImports = files.flatMap((file) => {
      const sourceFile = parseSourceFile(file);
      const imports = findImports(sourceFile, "@forge/kvs");

      return imports.map((entry) => ({
        file,
        line: entry.line,
      }));
    });

    if (kvsImports.length === 0) {
      expect(kvsImports).toEqual([]);
      return;
    }

    expect(
      manifestScopes.has("storage:app"),
      `The manifest must declare storage:app when @forge/kvs is used. Found @forge/kvs imports at:\n${kvsImports
        .map((entry) => `${entry.file}: line ${entry.line}`)
        .join("\n")}`,
    ).toBe(true);
  });
});
