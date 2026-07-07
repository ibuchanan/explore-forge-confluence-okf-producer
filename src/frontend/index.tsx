import React, { useEffect, useState } from "react";
import { makeInvoke } from "@forge/bridge";
import ForgeReconciler, { Text } from "@forge/react";

type GetTextPayload = {
  example: string;
};

type ResolverDefinitions = {
  getText: (payload: GetTextPayload) => string;
};

const invoke = makeInvoke<ResolverDefinitions>();

const App = () => {
  const [data, setData] = useState<string | null>(null);

  useEffect(() => {
    invoke("getText", { example: "my-invoke-variable" }).then(setData);
  }, []);

  return (
    <>
      <Text>Hello world!</Text>
      <Text>{data ? data : "Loading..."}</Text>
    </>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
