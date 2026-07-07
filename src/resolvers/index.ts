import Resolver from "@forge/resolver";
import { registerExportResolvers } from "./export";

const resolver = new Resolver();

registerExportResolvers(resolver);

export const handler = resolver.getDefinitions();
