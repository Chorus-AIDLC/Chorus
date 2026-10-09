import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRoleTool } from "./role-tools.js";

export default function chorusReviewProvider(pi: ExtensionAPI): void {
  registerRoleTool(pi, "reviewer");
}
