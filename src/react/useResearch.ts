import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createResearchClient } from "../client/research";
export const useResearch = (path = "/research") => {
  const client = useMemo(() => createResearchClient({ path }), [path]);
  const state = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );
  useEffect(() => () => client.cancel(), [client]);
  return { ...client, state };
};
