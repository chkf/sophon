import { existsSync } from "node:fs";
import { mainPath, openDatabase, schemaVersion, transaction, getState, putState, PERSONA_KEY, PERSONA_META_KEY } from "../state/database.js";

export interface ExpressionSnapshot { showStageDirections?: boolean }
export const EXPRESSION_KEY = "runtime/expression.json";
export function expressionInstruction(value: ExpressionSnapshot): string {
  return value.showStageDirections
    ? "心理和动作描写已开启。可以用全角括号（……）加入简短、中性的心理或动作描写；这些属于虚构的表达，不代表真实身体行为或已经执行的操作。不要替用户断言内心状态。严格 JSON 任务遵守其格式；SILENT 时不添加描写。"
    : "心理和动作描写已关闭。回复仅包含正文，不添加全角括号形式的心理或动作描写。严格 JSON 任务遵守其格式。";
}
/** Only the legacy boolean is migrated. Presets never enter runtime context. */
export class ExpressionStore {
  constructor(private readonly root: string) {}
  private access(enabled?: boolean): ExpressionSnapshot {
    if (!existsSync(mainPath(this.root))) throw Error("表达设置数据库缺失。");
    const db = openDatabase(mainPath(this.root));
    try { return transaction(db, () => {
      const current = getState(db, EXPRESSION_KEY);
      const old = current ?? getState(db, schemaVersion(db) === 2 ? PERSONA_META_KEY : PERSONA_KEY);
      const raw = old ? JSON.parse(old.value) : {};
      if (raw.showStageDirections !== undefined && typeof raw.showStageDirections !== "boolean") throw Error("描写开关格式无效。");
      const value = {showStageDirections: enabled ?? raw.showStageDirections === true};
      if (!current || enabled !== undefined) putState(db, {key: EXPRESSION_KEY, value: JSON.stringify(value)});
      return value;
    }); } finally { db.close(); }
  }
  async snapshot(): Promise<ExpressionSnapshot> { return this.access(); }
  async setShowStageDirections(enabled: boolean): Promise<ExpressionSnapshot> {
    if (typeof enabled !== "boolean") throw Error("描写开关格式无效。");
    return this.access(enabled);
  }
}
