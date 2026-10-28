import { existsSync } from "node:fs";
import { mainPath, openDatabase, schemaVersion, transaction, getState, putState, PERSONA_KEY, PERSONA_META_KEY } from "../state/database.js";

export interface ExpressionSnapshot { showStageDirections?: boolean }
export const EXPRESSION_KEY = "runtime/expression.json";
export function expressionInstruction(value: ExpressionSnapshot): string {
  return value.showStageDirections
    ? "心理和动作描写已开启。在本轮提供的 gateway_turn_decision.stage_direction 字段或 gateway_stage_direction 工具中填写简短、中性的心理或动作描写，程序单独展示，台词中的普通括号保持原义；这些属于虚构的表达，不代表真实身体行为或已经执行的操作。不要替用户断言内心状态。严格 JSON 任务遵守其格式；SILENT 时不添加描写。"
    : "心理和动作描写已关闭。提供 stage_direction 时仍用于辅助表达但不展示，台词仅包含正文，不复述隐藏描写。严格 JSON 任务遵守其格式。";
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
