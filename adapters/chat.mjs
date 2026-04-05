import { ToolCallArgumentRepair } from "../core/repair.mjs";
import { formatSseData, parseSseBlock } from "../core/sse.mjs";

export function isStreamingChatCompletion(req, bodyJson, pathname) {
  if (req.method !== "POST") {
    return false;
  }
  if (!bodyJson || bodyJson.stream !== true) {
    return false;
  }
  return pathname.endsWith("/chat/completions");
}

export class ChatCompletionRepairTransformer {
  constructor() {
    this.repair = new ToolCallArgumentRepair();
  }

  handleBlock(block) {
    if (block.trim() === "") {
      return "\n\n";
    }

    const parsedBlock = parseSseBlock(block);
    if (!parsedBlock.hasData) {
      return `${block}\n\n`;
    }

    if (parsedBlock.data === "[DONE]") {
      return formatSseData("[DONE]");
    }

    try {
      const payload = JSON.parse(parsedBlock.data);
      return formatSseData(this.repair.repairChunk(payload));
    } catch {
      return `${block}\n\n`;
    }
  }

  flush() {
    return "";
  }
}
