/**
 * Forge Architecture Tests
 *
 * - Circular dependency prevention
 */

import { type ProjectFiles, projectFiles } from "archunit";
import { beforeAll, describe, expect, it } from "vitest";

describe("Forge Architecture", () => {
  // Cache projectFiles() result to speed up tests
  // This scans the filesystem once instead of per-test
  let cachedProjectFiles: ProjectFiles;

  beforeAll(() => {
    cachedProjectFiles = projectFiles();
  });

  describe("structural rules", () => {
    it("source code should be cycle free", async () => {
      const rule = cachedProjectFiles
        .inFolder("src/**")
        .should()
        .haveNoCycles();

      await expect(rule).toPassAsync();
    });
  });
});
