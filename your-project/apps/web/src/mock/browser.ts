import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

export const worker = setupWorker(...handlers);

export async function startMockApi() {
  if (import.meta.env.VITE_API_MODE === "real") return;
  await worker.start({ onUnhandledFrame: "bypass" });
}
