import { readable } from "svelte/store";
import { createResearchClient } from "../client/research";
export const createResearchStore = (path = "/research") => {
  const client = createResearchClient({ path });
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
