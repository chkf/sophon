import type { LocalContextSnapshot } from "./context-contract.js";
const rev = (char: string) => "sha256:" + char.repeat(64);
export function localContext(core = "测试专用本地 Core", recent = "最近的合成测试记录"): LocalContextSnapshot {
  return { available: true, loadedAt: "2026-10-19T00:00:00Z", data: {
    core, recent, guidance: "只根据已核验的本地上下文回答。",
    coreRevision: rev("a"), recentRevision: rev("b"),
  } };
}
