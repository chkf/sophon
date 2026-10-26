import { createHash } from "node:crypto";
import { loadCore } from "./loader.js";
import { expressionInstruction, type ExpressionSnapshot } from "../expression/store.js";
import type { LocalContextSnapshot } from "./context-contract.js";
import type { RecentEntry } from "../knowledge/store.js";

/** Shared selection and text for channel chat, proactive chat and explicit CLI preview. */
export function renderRecentSummary(entries: readonly RecentEntry[]): string {
  const active = entries.filter(item => item.conversationState !== "Done");
  const recent = active.slice(0, 30).map(item => {
    const lines = item.body.split(/\r?\n/).map(line => line.replace(/^\s*#{1,6}\s*/, "").trim()).filter(Boolean);
    const name = (lines[0] || "未命名话题").slice(0, 48);
    const summary = (lines[1] || "").slice(0, 100);
    return "• " + name + (summary && summary !== name ? "： " + summary : "") + "（id=" + item.id + "）";
  }).join("\n");
  return "Recent 活跃话题目录（仅列名称与简述，不含完整记忆；需要细节时调用 gateway_recent_read）：\n" +
    (recent || "（暂无活跃话题）") +
    (active.length > 30 ? "\n另有 " + (active.length - 30) + " 个话题可通过 Recent 工具检索。" : "") +
    "\n已归档话题不会常驻目录，仍可通过工具检索。";
}

function revision(value: string): string {
  return "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
}

const RECENT_GUIDANCE = [
  "Recent 用于记录跨越当前上下文的持续交流话题，不记录普通闲聊。只在出现重要进展时更新，话题不再活跃时可归档。",
  "每轮提供的是活跃话题目录。需要细节时主动读取完整 Recent；查找过去的对话则使用历史检索，不凭摘要猜测。",
  "只根据可靠事实管理记忆，不混淆交流状态与任务完成状态。Core 和 Recent 的修改必须通过实际工具执行。",
].join("\n");

/** Assemble the local Core, expression settings and SQLite Recent directory. */
export class LocalCoreContextProvider {
  private snapshot?: LocalContextSnapshot;
  constructor(private readonly dataDir: string, private readonly recentSummary: () => string = () => "",
    private readonly currentExpression?: () => Promise<ExpressionSnapshot>,
    private readonly currentRecentRevision?: () => string) {}
  invalidate(): void { this.snapshot = undefined; }
  peek(): LocalContextSnapshot | undefined { return this.snapshot; }
  async load(): Promise<LocalContextSnapshot> {
    try {
      const core = await loadCore(this.dataDir);
      const recent = this.recentSummary();
      const recentVersion = this.currentRecentRevision?.();
      const expression = await this.currentExpression?.();
      const expressionText = expression ? expressionInstruction(expression) : "";
      if (typeof recent !== "string" || recent.length > 30_000) {
        throw new Error("Invalid or oversized local Recent context.");
      }
      const guidance = RECENT_GUIDANCE;
      this.snapshot = { available: true, loadedAt: new Date().toISOString(), data: {
        core: core.text, recent, guidance,
        coreRevision: revision(core.text + "\n" + guidance + (expressionText ? "\n" + expressionText : "")),
        recentRevision: revision(recent + (recentVersion ? "\n" + recentVersion : "")),
        ...(expression ? { expression, expressionRevision: revision(expressionText) } : {}),
      } };
    } catch {
      this.snapshot = { available: false, loadedAt: new Date().toISOString(),
        error: "本地 Core 缺失、无效或数据库读取失败；请检查本地配置。" };
    }
    return this.snapshot;
  }
}
