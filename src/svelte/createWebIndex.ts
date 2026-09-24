import { readable } from "svelte/store";
import { createWebIndexClient } from "../client/web-index";
export const createWebIndexStore = (path = "/web-index") => {
  const client = createWebIndexClient({ path });
  const state = readable(client.getSnapshot(), (set) => {
    set(client.getSnapshot());
    const unsubscribe = client.subscribe(() => set(client.getSnapshot()));
    return () => {
      unsubscribe();
      client.cancel();
    };
  });
  return { ...client, state };
};
