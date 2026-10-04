import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadAccessToken, normalizeAccessToken, verifyAccessToken } from "./bangumi-auth.mjs";

export async function main({ cwd = process.cwd(), args = process.argv.slice(2), input = process.stdin, ...options } = {}) {
  if (args.some(arg => arg !== "--stdin")) throw new Error("未知参数；可用 --stdin");
  const config = JSON.parse(await readFile(path.join(cwd, "config.json"), "utf8"));
  let token;
  if (args.includes("--stdin")) {
    let value = "";
    for await (const chunk of input) {
      value += chunk.toString("utf8");
      if (value.length > 4096) throw new Error("Bangumi 令牌输入过长");
    }
    token = normalizeAccessToken(value);
  } else token = await loadAccessToken(options);
  const user = await verifyAccessToken(token, { username: config.bangumi.username, ...options });
  console.log("Bangumi 授权有效：" + user.username + "；更新时会自动使用此授权");
  return user;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
