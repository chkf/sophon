/** Read-only account/key information; never infer account balance from a key cap. */
export async function creditSummary(apiKey?: string, managementKey?: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!apiKey) return "OpenRouter credit：Key 未配置。";
  const get = async (path: string, key: string) => {
    const response = await fetcher("https://openrouter.ai/api/v1/" + path, {
      headers: { Authorization: "Bearer " + key }, signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("credit unavailable");
    return (await response.json() as { data?: Record<string, unknown> }).data;
  };
  const [key, account] = await Promise.allSettled([
    get("key", apiKey), managementKey ? get("credits", managementKey) : Promise.resolve(undefined),
  ]);
  const money = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? "$" + n.toFixed(4) : undefined;
  const lines = ["OpenRouter credit："];
  const a = account.status === "fulfilled" ? account.value : undefined;
  if (a && typeof a.total_credits === "number" && typeof a.total_usage === "number" &&
      money(a.total_credits) && money(a.total_usage)) lines.push("账户余额：" + money(a.total_credits - a.total_usage));
  else lines.push("账户余额：" + (managementKey ? "暂时不可用" : "未配置余额查询权限"));
  const k = key.status === "fulfilled" ? key.value : undefined;
  if (k) {
    lines.push("Key 剩余限额：" + (k.limit_remaining === null ? "未设限额（不代表账户余额无限）" : money(k.limit_remaining) ?? "未知"));
    if (money(k.usage)) lines.push("Key 累计用量：" + money(k.usage));
  } else lines.push("Key 用量：暂时不可用");
  return lines.join("\n");
}
