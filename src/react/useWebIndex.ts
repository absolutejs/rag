import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createWebIndexClient } from "../client/web-index";
export const useWebIndex = (path = "/web-index") => {
  const client = useMemo(() => createWebIndexClient({ path }), [path]);
  const state = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );
  useEffect(() => () => client.cancel(), [client]);
  return { ...client, state };
};
