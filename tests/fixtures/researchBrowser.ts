import { bindResearchForm } from "../../src/client/research";
const research = bindResearchForm(
  document.querySelector<HTMLFormElement>("form")!,
  document.querySelector<HTMLElement>("pre")!,
);
Object.assign(window, { research });
