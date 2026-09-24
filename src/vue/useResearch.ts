import { shallowRef, onScopeDispose } from "vue";
import { createResearchClient } from "../client/research";
export const useResearch = (path = "/research") => {
  const client = createResearchClient({ path });
  const state = shallowRef(client.getSnapshot());
  const unsubscribe = client.subscribe(() => {
    state.value = client.getSnapshot();
  });
  onScopeDispose(() => {
    unsubscribe();
    client.dispose();
  });
  return { ...client, state };
};
