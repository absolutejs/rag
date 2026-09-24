import { shallowRef, onScopeDispose } from "vue";
import { createWebIndexClient } from "../client/web-index";
export const useWebIndex = (path = "/web-index") => {
  const client = createWebIndexClient({ path });
  const state = shallowRef(client.getSnapshot());
  const unsubscribe = client.subscribe(() => {
    state.value = client.getSnapshot();
  });
  onScopeDispose(() => {
    client.cancel();
    unsubscribe();
    client.dispose();
  });
  return { ...client, state };
};
