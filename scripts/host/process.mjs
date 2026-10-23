export function commandSpec(
  command,
  args = [],
  platform = process.platform,
  comspec = process.env.ComSpec,
) {
  if (platform === "win32" && command === "npm") {
    return {
      file: comspec || "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", ...args],
    };
  }
  return { file: command, args };
}
