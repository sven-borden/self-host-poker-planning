// Placeholder until #8 turns the web app into React.
import { MAX_PARTICIPANTS } from "@pp/domain";
import { PROTOCOL_VERSION } from "@pp/protocol";

const status = document.querySelector("#status");
if (status) {
  status.textContent = `Protocol v${PROTOCOL_VERSION}, up to ${MAX_PARTICIPANTS} per room.`;
}
