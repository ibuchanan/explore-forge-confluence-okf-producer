import Resolver from "@forge/resolver";

type GetTextPayload = {
  example: string;
};

const resolver = new Resolver();

resolver.define<GetTextPayload, string>("getText", () => "Hello, world!");

export const handler = resolver.getDefinitions();
