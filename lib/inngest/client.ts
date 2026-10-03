import { Inngest } from "inngest";

export const inngest = new Inngest({
  id: "tradumanga",
  checkpointing: { maxRuntime: "240s" },
});
