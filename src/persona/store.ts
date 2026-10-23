import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { mainPath, openDatabase, schemaVersion, transaction, readPersonaDocument, writePersonaDocument, getState, putState, PERSONA_KEY } from "../state/database.js";
import { SerialQueue } from "../util/serial-queue.js";

export interface PersonaSnapshot {
  showStageDirections?: boolean;
  active: string;
  presets: Record<string, string[]>;
}

const ID_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;
const KEYWORD_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;
const MAX_PRESETS = 24;
const MAX_KEYWORDS = 12;

export function normalizePersonaId(input: string): string {
  const id = input.trim().toLowerCase();
  if (!ID_PATTERN.test(id)) throw new Error("模式名仅支持 1–24 位小写英文、数字和下划线，必须以字母开头。");
  return id;
}

export function parsePersonaKeywords(input: string): string[] {
  const words = input.trim().toUpperCase().split(/[\s,]+/).filter(Boolean);
  if (!words.length || words.length > MAX_KEYWORDS ||
      words.some(word => !KEYWORD_PATTERN.test(word)) || new Set(words).size !== words.length) {
    throw new Error("请输入 1–12 个不重复的英文关键词（字母、数字、下划线），用空格或逗号分隔。");
  }
  return words;
}

function validateState(raw: unknown): PersonaSnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Persona 状态格式错误。");
  const state = raw as Record<string, unknown>;
  if ((state.version !== 1 && state.version !== 2) || typeof state.active !== "string" ||
      !state.presets || typeof state.presets !== "object" || Array.isArray(state.presets)) {
    throw new Error("Persona 状态版本不兼容。");
  }
  const presets: Record<string, string[]> = Object.create(null);
  const entries = Object.entries(state.presets);
  if (!entries.length || entries.length > MAX_PRESETS) throw new Error("Persona 模式数量不合法。");
  for (const [id, value] of entries) {
    if (normalizePersonaId(id) !== id || !Array.isArray(value) ||
        value.some(word => typeof word !== "string")) throw new Error("Persona 配置无效。");
    const words = value as string[];
    if (parsePersonaKeywords(words.join(" ")).join(" ") !== words.join(" ")) throw new Error("Persona 关键词无效。");
    presets[id] = [...words];
  }
  if (!presets.default || !Object.hasOwn(presets, state.active)) throw new Error("Persona 默认/当前模式缺失。");
  if (state.showStageDirections !== undefined && typeof state.showStageDirections !== "boolean") throw new Error("角色描写开关无效。");
  return { active: state.active, presets, showStageDirections: state.showStageDirections === true };
}

export function personaInstruction(snapshot: PersonaSnapshot): string {
  const keywords = snapshot.presets[snapshot.active];
  if (!keywords) throw new Error("当前 Persona 模式无效。");
  return [
    "【表达风格】当前模式：" + snapshot.active + "；关键词：" + keywords.join(", ") + "。",
    "自然遵循当前表达风格，保持事实准确；风格设置不改变身份、记忆或工具权限。",
    ...(snapshot.showStageDirections ? ["仅当用户明确要求角色扮演时，可以添加标明为虚构的简短角色描写。"] : []),
    "不要自行添加角色经历或内心独白。需要静默时仅返回 SILENT；严格 JSON 任务遵守其输出协议。",
  ].join("\n");
}

export class PersonaStore {
  private readonly queue = new SerialQueue();
  constructor(private readonly dataDir: string) {}

  private withDatabase<T>(run: (db: DatabaseSync) => T): T {
    if (!existsSync(mainPath(this.dataDir))) throw new Error("Persona 数据库缺失；请先导入已有配置，不会加载代码预设。");
    const db = openDatabase(mainPath(this.dataDir));
    try {
      if (![1,2].includes(schemaVersion(db))) throw new Error("Persona 需要先完成现有六表数据库迁移。");
      return transaction(db, () => run(db));
    } finally { db.close(); }
  }
  private read(db: DatabaseSync): PersonaSnapshot {
    const row = schemaVersion(db) === 1 ? getState(db, PERSONA_KEY) : undefined;
    const raw = schemaVersion(db) === 2 ? readPersonaDocument(db) : row ? JSON.parse(row.value) : undefined;
    if (!raw) throw new Error("数据库中的 Persona 缺失；不会回退旧文件或代码预设。");
    return validateState(raw);
  }
  snapshot(): Promise<PersonaSnapshot> {
    return this.queue.run(async () => this.withDatabase(db => this.read(db)));
  }
  private mutate(fn: (state: PersonaSnapshot) => void): Promise<PersonaSnapshot> {
    return this.queue.run(async () => this.withDatabase(db => {
      const state = this.read(db);
      fn(state);
      if (schemaVersion(db) === 2) writePersonaDocument(db, { version: 2, ...state });
      else putState(db,{key:PERSONA_KEY,value:JSON.stringify({version:2,...state})});
      return this.read(db);
    }));
  }
  setShowStageDirections(enabled: boolean): Promise<PersonaSnapshot> {
    return this.mutate(state => { state.showStageDirections = enabled; });
  }
  select(input: string): Promise<PersonaSnapshot> {
    const id = normalizePersonaId(input);
    return this.mutate(state => {
      if (!Object.hasOwn(state.presets, id)) throw new Error("找不到这个 Persona，发送 /persona 查看列表。");
      state.active = id;
    });
  }
  define(input: string, keywords: string[], overwrite = false): Promise<PersonaSnapshot> {
    const id = normalizePersonaId(input);
    const words = parsePersonaKeywords(keywords.join(" "));
    return this.mutate(state => {
      const exists = Object.hasOwn(state.presets, id);
      if (exists && !overwrite) throw new Error("模式已经存在。要修改请用 /persona set。");
      if (!exists && overwrite) throw new Error("模式不存在。要新增请用 /persona add。");
      if (!exists && Object.keys(state.presets).length >= MAX_PRESETS) throw new Error("已达到 Persona 数量上限。");
      state.presets[id] = words;
    });
  }
  remove(input: string): Promise<PersonaSnapshot> {
    const id = normalizePersonaId(input);
    if (id === "default") throw new Error("default 是必需的恢复模式，不能删除（可用 /persona set default 修改）。");
    return this.mutate(state => {
      if (!Object.hasOwn(state.presets, id)) throw new Error("模式不存在。");
      delete state.presets[id];
      if (state.active === id) state.active = "default";
    });
  }
}
