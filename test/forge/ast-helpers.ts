/**
 * AST Helper Functions for Forge Tests
 */

import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

// ============================================================================
// Core Parsing Functions
// ============================================================================

/**
 * Parse a TypeScript/TSX file into an AST
 *
 * @param filePath - Path to .ts or .tsx file
 * @returns TypeScript AST (SourceFile)
 */
export function parseSourceFile(filePath: string): ts.SourceFile {
  const absolutePath = path.resolve(filePath);
  const content = fs.readFileSync(absolutePath, "utf-8");

  return ts.createSourceFile(
    absolutePath,
    content,
    ts.ScriptTarget.Latest,
    true, // setParentNodes - necessary for finding parent nodes
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * Get line number from AST node
 *
 * @param sourceFile - The parsed source file
 * @param node - The AST node
 * @returns 1-based line number
 */
export function getLineNumber(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

/**
 * Get column number from AST node
 */
function getColumnNumber(sourceFile: ts.SourceFile, node: ts.Node): number {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart()).character + 1
  );
}

// ============================================================================
// Import/Export Utilities
// ============================================================================

/**
 * Find all import declarations in a file
 *
 * Example:
 *   import { Button } from "@forge/react"
 *   → { source: "@forge/react", specifiers: ["Button"], line: 5 }
 */
export function findImports(
  sourceFile: ts.SourceFile,
  sourceFilter?: string | RegExp,
): Array<{
  source: string;
  specifiers: string[];
  line: number;
  type: "named" | "default" | "namespace";
}> {
  const results: Array<{
    source: string;
    specifiers: string[];
    line: number;
    type: "named" | "default" | "namespace";
  }> = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier;

      if (!ts.isStringLiteral(moduleSpecifier)) {
        continue;
      }

      const source = moduleSpecifier.text;

      // Filter by source if provided
      if (sourceFilter) {
        const matches =
          typeof sourceFilter === "string"
            ? source === sourceFilter
            : sourceFilter.test(source);
        if (!matches) {
          continue;
        }
      }

      const specifiers: string[] = [];
      let type: "named" | "default" | "namespace" = "named";

      if (statement.importClause) {
        // import Foo from "bar"
        if (statement.importClause.name) {
          specifiers.push(statement.importClause.name.text);
          type = "default";
        }

        // import * as Foo from "bar"
        if (statement.importClause.namedBindings) {
          if (ts.isNamespaceImport(statement.importClause.namedBindings)) {
            specifiers.push(statement.importClause.namedBindings.name.text);
            type = "namespace";
          } else if (ts.isNamedImports(statement.importClause.namedBindings)) {
            // import { Foo, Bar } from "baz"
            for (const element of statement.importClause.namedBindings
              .elements) {
              specifiers.push(element.propertyName?.text || element.name.text);
            }
          }
        }
      }

      results.push({
        source,
        specifiers,
        line: getLineNumber(sourceFile, statement),
        type,
      });
    }
  }

  return results;
}

/**
 * Find exported names in a source file.
 */
export function findExportedNames(sourceFile: ts.SourceFile): Set<string> {
  const results = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      const exportClause = statement.exportClause;
      if (exportClause && ts.isNamedExports(exportClause)) {
        for (const element of exportClause.elements) {
          results.add(element.name.text);
        }
      }
      continue;
    }

    const isExported = Boolean(
      ts.getCombinedModifierFlags(statement as ts.Declaration) &
        ts.ModifierFlags.Export,
    );

    if (!isExported) {
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      results.add(statement.name.text);
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      results.add(statement.name.text);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          results.add(declaration.name.text);
        }
      }
    }
  }

  return results;
}

/**
 * Find all queue keys instantiated via `new Queue({ key: ... })` where Queue
 * is imported from `@forge/events`.
 */
export function findForgeQueueKeys(sourceFile: ts.SourceFile): Array<{
  key: string;
  line: number;
  column: number;
}> {
  const queueImportNames = new Set<string>();
  const results: Array<{
    key: string;
    line: number;
    column: number;
  }> = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }

    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    if (statement.moduleSpecifier.text !== "@forge/events") {
      continue;
    }

    const importClause = statement.importClause;
    const namedBindings = importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    for (const element of namedBindings.elements) {
      if (element.propertyName?.text === "Queue") {
        queueImportNames.add(element.name.text);
      } else if (!element.propertyName && element.name.text === "Queue") {
        queueImportNames.add("Queue");
      }
    }
  }

  function visit(node: ts.Node) {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      queueImportNames.has(node.expression.text)
    ) {
      const [firstArg] = node.arguments || [];
      if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
        const keyProperty = firstArg.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) &&
            ((ts.isIdentifier(property.name) && property.name.text === "key") ||
              (ts.isStringLiteral(property.name) &&
                property.name.text === "key")),
        );

        if (keyProperty && ts.isStringLiteral(keyProperty.initializer)) {
          results.push({
            key: keyProperty.initializer.text,
            line: getLineNumber(sourceFile, keyProperty.initializer),
            column: getColumnNumber(sourceFile, keyProperty.initializer),
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results;
}
