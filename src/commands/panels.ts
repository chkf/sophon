import type { PanelView, PanelButton } from "../channels/telegram/panels.js";
import type { ManagedChatRuntime, ProviderId } from "../runtime/types.js";
import type { ActiveChannelRouter } from "../channels/active.js";
import type { ExpressionStore } from "../expression/store.js";
import type { InboundMessage } from "../channels/types.js";
import { IMAGE_PRESETS } from "../runtime/image-settings.js";
import { readLogEvents, summarizeLog, type LogRange, type LogSource } from "./host-logs.js";
import { DiagnosticRegistry } from "./diagnostics.js";
import { API_UNSUPPORTED_IMAGES, PROVIDERS, isPaidProvider, providerLabel } from "./providers.js";

const button=(text:string,run:()=>Promise<PanelView>):PanelButton=>({text,run});
export class CommandPanels {
  constructor(private readonly runtime:ManagedChatRuntime,private readonly channels:ActiveChannelRouter,
    private readonly expressions:ExpressionStore,private readonly diagnostics:DiagnosticRegistry,
    private readonly logDir:string,private readonly timezone:string,private readonly credits:()=>Promise<string>,
    private readonly weixin?:{choose:()=>Promise<PanelView>;panel:()=>Promise<PanelView>},
    private readonly voice?:{open:()=>Promise<PanelView>}) {}
  async open(command:string,_message:InboundMessage):Promise<PanelView|undefined> {
    if(!["model","expression","proactive","test","logs"].includes(command))return undefined;
    if(command==="model")return this.model();
    if(command==="expression")return this.expression();
    if(command==="proactive")return this.proactive();
    if(command==="logs")return this.logs();
    return this.diagnosticMenu();
  }
  async model(note=""):Promise<PanelView> {
    const provider=await this.runtime.getProvider?.()??"api";
    let selected="暂时不可用";try{const s=await this.runtime.getModelSelection();selected=s.model??s.resolvedModel??"Auto";}catch{}
    let image=provider==="api"?"不支持":"未配置";if(provider!=="api")try{image=(await this.runtime.getImageSettings?.())?.model??image;}catch{}
    return {text:[note,"模型设置","Provider："+providerLabel(provider),"聊天模型："+selected,"生图模型："+image,...(provider==="api"?["本页仅显示配置，连接未验证；可在 /test 显式测试（可能收费）。",API_UNSUPPORTED_IMAGES]:[])].filter(Boolean).join("\n"),rows:[
      [button("聊天模型",()=>this.models())],...(this.runtime.listMemoryModels ? [[button("记忆分类模型（SIWC）",()=>this.memoryModels())]] : []),[button("生图设置",()=>this.images())],[button("切换 Provider",()=>this.providers())],...(this.voice?[[button("语音设置",()=>this.voice!.open())]]:[])]};
  }
  async models(page=0):Promise<PanelView> {
    const provider=await this.runtime.getProvider?.()??"api";
    const models=await this.runtime.listModels();const pages=Math.max(1,Math.ceil(models.length/8));
    page=Math.max(0,Math.min(page,pages-1));
    const rows=models.slice(page*8,page*8+8).map(m=>[button(m.displayName.slice(0,50),()=>this.chooseModel(provider,m.id))]);
    rows.push([button("Auto",()=>this.chooseModel(provider))]);
    const nav:PanelButton[]=[];if(page>0)nav.push(button("上一页",()=>this.models(page-1)));if(page+1<pages)nav.push(button("下一页",()=>this.models(page+1)));if(nav.length)rows.push(nav);
    rows.push([button("返回",()=>this.model())]);
    return {text:"选择聊天模型 · "+providerLabel(provider)+" · "+(page+1)+"/"+pages+(isPaidProvider(provider)?"\n后续调用可能按所配置服务商的规则收费。":""),rows};
  }
  private async chooseModel(provider:ProviderId,model?:string):Promise<PanelView> {
    const save=async()=>{await this.runtime.selectModel(model,provider);return this.model(model?"已切换聊天模型："+model:"已切换为 Auto。");};
    if(!isPaidProvider(provider))return save();
    return {text:"选择 "+providerLabel(provider)+" / "+(model??"Auto")+"？\n后续聊天和已启用的后台活动可能产生费用。",rows:[
      [button("确认选择",save),button("取消",()=>this.models())]]};
  }
  async memoryModels(page=0,note=""):Promise<PanelView> {
    if (!this.runtime.listMemoryModels || !this.runtime.getMemoryModel || !this.runtime.selectMemoryModel) throw Error("记忆模型设置不可用。");
    const models=await this.runtime.listMemoryModels(),selected=await this.runtime.getMemoryModel();
    const pages=Math.max(1,Math.ceil(models.length/8));page=Math.max(0,Math.min(page,pages-1));
    const rows=models.slice(page*8,page*8+8).map(m=>[button((m.id===selected?"✓ ":"")+m.displayName.slice(0,45),async()=>{
      await this.runtime.selectMemoryModel!(m.id);return this.memoryModels(page,"已选择："+m.id);
    })]);
    const nav:PanelButton[]=[];
    if(page>0)nav.push(button("上一页",()=>this.memoryModels(page-1)));
    if(page+1<pages)nav.push(button("下一页",()=>this.memoryModels(page+1)));
    if(nav.length)rows.push(nav);rows.push([button("返回",()=>this.model())]);
    return {text:[note,"记忆分类模型 · SIWC · "+(page+1)+"/"+pages,"当前："+selected,
      !models.some(m=>m.id===selected)?"当前模型不可用，分类任务将等待重新选择或权限恢复。":"",
      "此设置只影响后续记忆分类任务，不改变聊天模型。"].filter(Boolean).join("\n"),rows};
  }
  async providers():Promise<PanelView> {
    const current=await this.runtime.getProvider?.();
    return {text:"切换 Provider\n通用 API 和 OpenRouter 的后续调用可能收费，包括已启用的后台任务。",rows:PROVIDERS.map(p=>[button((p===current?"✓ ":"")+providerLabel(p),()=>this.chooseProvider(p))]).concat([[button("返回",()=>this.model())]])};
  }
  private async chooseProvider(provider:ProviderId):Promise<PanelView> {
    const save=async()=>{
      if(!this.runtime.selectProvider)throw Error("不可用");await this.runtime.selectProvider(provider);
      return this.model("已切换到 "+providerLabel(provider)+(provider==="openrouter"?"\n"+await this.credits():""));
    };
    if(!isPaidProvider(provider))return save();
    return {text:"切换到 "+providerLabel(provider)+"？\n后续聊天和已启用的后台活动可能产生费用。",rows:[
      [button("确认切换",save),button("取消",()=>this.providers())]]};
  }
  async images():Promise<PanelView> {
    if(await this.runtime.getProvider?.()==="api")return {text:API_UNSUPPORTED_IMAGES,rows:[[button("返回",()=>this.model())]]};
    const s=await this.runtime.getImageSettings?.();if(!s)return {text:"生图设置不可用。",rows:[[button("返回",()=>this.model())]]};
    return {text:"生图设置\n当前模型："+(s.model??"未配置")+"\n主动与明确请求生图共用此模型。\n主动生图："+(s.proactive?"开启":"关闭")+
      "\n路线："+(s.route==="openrouter"?"独立 OpenRouter（付费）":"跟随聊天 Provider")+"\n主动生图每天最多 "+s.dailyLimit+" 次尝试。",rows:[
      ...IMAGE_PRESETS.map(p=>[button((s.model===p.model?"✓ ":"")+p.label,async()=>{await this.runtime.selectImageModel?.(p.id);return this.images();})]),
      [button(s.proactive?"关闭主动生图":"开启主动生图（付费）",async()=>{await this.runtime.setProactiveImages?.(!s.proactive);return this.images();})],
      [button("独立 OpenRouter（付费）",async()=>{await this.runtime.selectImageRoute?.("openrouter");return this.images();}),button("跟随聊天 Provider",async()=>{await this.runtime.selectImageRoute?.("provider");return this.images();})],
      [button("返回",()=>this.model())]]};
  }
  async proactive():Promise<PanelView> {
    const active=await this.channels.getActive();
    return {text:"主动消息渠道\n只影响主动消息，你仍可使用任一已配置渠道聊天。",rows:(["telegram","wechat","off"] as const).map(c=>[button((c===active?"✓ ":"")+({telegram:"Telegram",wechat:"微信",off:"关闭"}[c]),async()=>{if(c==="wechat"&&this.weixin)return this.weixin.choose();await this.channels.setActive(c);return this.proactive();})]).concat(this.weixin?[[button("微信管理 / 重新绑定",()=>this.weixin!.panel())]]:[])};
  }
  async expression():Promise<PanelView> {
    const state=await this.expressions.snapshot();
    return {text:"心理和动作描写："+(state.showStageDirections?"开启":"关闭"),rows:[
      [button(state.showStageDirections?"关闭描写":"开启描写",async()=>{
        await this.expressions.setShowStageDirections(!state.showStageDirections);return this.expression();
      })]]};
  }
  async logs(range:LogRange="15m",source:LogSource="all",errorsOnly=true):Promise<PanelView> {
    const events=await readLogEvents(this.logDir,{range,source,errorsOnly,timezone:this.timezone});
    const label={"15m":"最近 15 分钟","1h":"最近 1 小时",today:"今天"}[range];
    const time=(at:number)=>new Intl.DateTimeFormat("zh-CN",{timeZone:this.timezone,hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(at);
    const rows:PanelButton[][]=[
      [button("15 分钟",()=>this.logs("15m",source,errorsOnly)),button("1 小时",()=>this.logs("1h",source,errorsOnly)),button("今天",()=>this.logs("today",source,errorsOnly))],
      [button(errorsOnly?"查看全部事件":"仅看错误",()=>this.logs(range,source,!errorsOnly)),button("刷新",()=>this.logs(range,source,errorsOnly))],
    ];
    const shown=events.slice(0,5);
    shown.forEach((e,i)=>rows.push([button("详情 "+(i+1),async()=>({text:e.text.slice(-3500)+"\n本时段 "+e.count+" 次",rows:[[button("返回",()=>this.logs(range,source,errorsOnly))]]}))]));
    return {text:"日志 · "+label+" · "+source+" · "+(errorsOnly?"错误":"全部事件")+"\n"+
      (shown.length?shown.map((e,i)=>(i+1)+". "+time(e.at)+" · "+e.source+" · "+e.count+" 次\n"+summarizeLog(e.text)).join("\n\n"):"这段时间没有"+(errorsOnly?"错误":"日志事件")+"。")+
      "\n\n只读取各文件末尾 256KB；高日志量时可能不完整。",rows};
  }
  async diagnosticMenu():Promise<PanelView> {
    const root=await this.diagnostics.menu();
    root.rows.push([button("模型专项测试",()=>this.diagnosticProviders())]);return root;
  }
  async diagnosticProviders():Promise<PanelView> {
    return {text:"选择诊断 Provider（不会切换正式配置）",rows:PROVIDERS.map(p=>[button(providerLabel(p),()=>this.diagnosticModels(p))]).concat([[button("返回",()=>this.diagnosticMenu())]])};
  }
  async diagnosticModels(provider:ProviderId,page=0):Promise<PanelView> {
    const models=await this.runtime.diagnosticModels?.(provider)??[];
    const rows=models.slice(page*8,page*8+8).map(m=>[button(m.displayName.slice(0,50),()=>this.diagnosticKinds(provider,m.id))]);
    if(page>0)rows.push([button("上一页",()=>this.diagnosticModels(provider,page-1))]);
    if((page+1)*8<models.length)rows.push([button("下一页",()=>this.diagnosticModels(provider,page+1))]);
    if(provider==="openrouter")rows.push([button("生图测试（付费）",()=>this.diagnosticRun(provider,"","image"))]);
    rows.push([button("返回",()=>this.diagnosticProviders())]);return {text:"选择测试模型 · "+providerLabel(provider)+(provider==="api"?"\n"+API_UNSUPPORTED_IMAGES:""),rows};
  }
  async diagnosticKinds(provider:ProviderId,model:string):Promise<PanelView> {
    return {text:providerLabel(provider)+" / "+model,rows:(["text","tools","vision"] as const).map(kind=>[button({text:"文字连通",tools:"工具调用",vision:"图片输入"}[kind],()=>this.diagnosticRun(provider,model,kind))]).concat([[button("返回",()=>this.diagnosticModels(provider))]])};
  }
  async diagnosticRun(provider:ProviderId,model:string,kind:"text"|"tools"|"vision"|"image"):Promise<PanelView> {
    if(provider==="api"&&kind==="image")return {text:API_UNSUPPORTED_IMAGES,rows:[[button("返回",()=>this.diagnosticModels(provider))]]};
    const image=kind==="image"?await this.runtime.getImageSettings?.():undefined;
    const item={id:"model:"+kind,group:"模型",label:kind==="image"?"生图测试":"模型测试："+kind,
      description:providerLabel(provider)+" / "+(image?.model??model)+"；独立诊断请求，不使用正式聊天历史。",
      cost:isPaidProvider(provider)?"会向 "+providerLabel(provider)+" 发送请求，可能产生费用。":"会消耗 ChatGPT 套餐额度。",timeoutMs:300_000,
      run:async()=>{if(!this.runtime.diagnosticReply)throw Error("诊断不可用");return this.runtime.diagnosticReply(provider,model,kind);}};
    return this.diagnostics.confirm(item,()=>this.diagnosticProviders());
  }
}
