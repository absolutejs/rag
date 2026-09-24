import { Injectable, signal, type DestroyRef } from "@angular/core";
import { createWebIndexClient } from "../client/web-index";
@Injectable({ providedIn: "root" })
export class WebIndexService {
  connect(path = "/web-index", destroyRef?: DestroyRef) {
    const client = createWebIndexClient({ path });
    const state = signal(client.getSnapshot());
    const unsubscribe = client.subscribe(() => state.set(client.getSnapshot()));
    const dispose = () => {
      client.cancel();
      unsubscribe();
      client.dispose();
    };
    destroyRef?.onDestroy(dispose);
    return { ...client, state: state.asReadonly(), dispose };
  }
}
