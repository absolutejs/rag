import { Injectable, signal, type DestroyRef } from "@angular/core";
import { createResearchClient } from "../client/research";
@Injectable({ providedIn: "root" })
export class ResearchService {
  connect(path = "/research", destroyRef?: DestroyRef) {
    const client = createResearchClient({ path });
    const state = signal(client.getSnapshot());
    const unsubscribe = client.subscribe(() => state.set(client.getSnapshot()));
    const dispose = () => {
      unsubscribe();
      client.dispose();
    };
    destroyRef?.onDestroy(dispose);
    return { ...client, state: state.asReadonly(), dispose };
  }
}
