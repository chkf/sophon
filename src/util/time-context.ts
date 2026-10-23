export function formatLocalTimestamp(value: string | Date, timezone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "未知时间";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return parts.year + "-" + parts.month + "-" + parts.day + " " + parts.hour + ":" + parts.minute;
}

export function elapsedDescription(from: string | Date, to: string | Date): string {
  const start = from instanceof Date ? from : new Date(from);
  const end = to instanceof Date ? to : new Date(to);
  const milliseconds = end.getTime() - start.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "时间间隔未知";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "不到1分钟";
  if (minutes < 60) return minutes + "分钟";
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? hours + "小时" + restMinutes + "分钟" : hours + "小时";
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? days + "天" + restHours + "小时" : days + "天";
}
