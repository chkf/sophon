import type { RuntimeTool } from "./types.js";

export const LOAD_TOOLS_NAME = "gateway_load_tools";
const definitions = [
  { id: "plans", description: "创建、查询或取消提醒，按明确请求调整主动联系计划", match: (name: string) => name.startsWith("gateway_reminder_") || name === "gateway_heartbeat_replan" },
  { id: "files", description: "浏览、读取、生成或发送文件；修改和删除仍需用户确认", match: (name: string) => name.startsWith("gateway_file_") || name === "telegram_send_document" },
  { id: "recent_manage", description: "维护持续话题正文和状态", match: (name: string) => /^gateway_recent_(create|write|delete)$/.test(name) },
];

/** A fresh catalog per message; selection exposes definitions, never new permissions. */
export class ToolGroups {
  readonly tools: RuntimeTool[];
  readonly groups: Array<{ id: string; description: string; tools: RuntimeTool[] }>;
  private readonly selected = new Set<string>();
  constructor(available: RuntimeTool[]) {
    this.groups = definitions.map(group => ({id: group.id, description: group.description,
      tools: available.filter(tool => group.match(tool.name))})).filter(group => group.tools.length);
    for (const tool of available) {
      const id = /^(mcp_.+)_[a-f0-9]{24}$/.exec(tool.name)?.[1];
      if (!id) continue;
      let group = this.groups.find(group => group.id === id);
      if (!group) { group = {id, description: "用户配置的 MCP 服务；仅提供已授权工具", tools: []}; this.groups.push(group); }
      group.tools.push(tool);
    }
    for (const group of this.groups.filter(group => group.id.startsWith("mcp_"))) {
      group.description += "：" + group.tools.map(tool => (tool.description || tool.name).slice(0,100)).slice(0,20).join("；");
    }
    const deferred = new Set(this.groups.flatMap(group => group.tools.map(tool => tool.name)));
    this.tools = available.filter(tool => !deferred.has(tool.name));
    if (this.groups.length) this.tools.push({name: LOAD_TOOLS_NAME, readOnly: true, replaySafe: true,
      description: "仅在本轮需要时加载工具组。返回成功后，下一次模型请求才提供对应定义；加载本身不执行操作，也不改变权限。",
      parameters: {type: "object", additionalProperties: false, required: ["groups"], properties: {groups: this.parameter}}});
  }
  get parameter() { return {type: "array", uniqueItems: true, maxItems: this.groups.length,
    items: {type: "string", enum: this.groups.map(group => group.id)},
    description: "只选当前请求需要的组，普通聊天填 []。" + this.groups.map(group => group.id + "：" + group.description).join("；")}; }
  load(value: unknown) {
    if (!Array.isArray(value) || value.length > this.groups.length || new Set(value).size !== value.length ||
      value.some(id => typeof id !== "string" || !this.groups.some(group => group.id === id))) throw Error("请只选择本轮目录中的工具组。");
    for (const id of value as string[]) {
      if (this.selected.has(id)) continue;
      this.selected.add(id); this.tools.push(...this.groups.find(group => group.id === id)!.tools);
    }
    return {loaded_groups: [...this.selected], tools: this.groups.filter(group => this.selected.has(group.id)).flatMap(group => group.tools.map(tool => tool.name))};
  }
  execute(args: Record<string, unknown>) {
    if (Object.keys(args).some(key => key !== "groups") || !Object.hasOwn(args,"groups")) throw Error("请提供工具组 groups。");
    return this.load(args.groups);
  }
}
