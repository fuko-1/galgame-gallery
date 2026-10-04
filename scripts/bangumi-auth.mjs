import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const BANGUMI_UA = "fuko-galgame-gallery/2.0 (https://github.com/fuko-1/galgame-gallery)";
const run = promisify(execFile);

export function normalizeAccessToken(value) {
  const token = String(value ?? "").trim();
  if (token && (!/^[A-Za-z0-9._~+/-]+={0,2}$/.test(token) || token.length > 4096)) {
    throw new Error("Bangumi 令牌格式无效，请重新复制完整的 Access Token");
  }
  return token;
}

/** Credentials stay outside the public site directory and Git history. */
export async function loadAccessToken({ env = process.env, platform = process.platform, runImpl = run, accessImpl = access } = {}) {
  if (env.BANGUMI_ACCESS_TOKEN?.trim()) return normalizeAccessToken(env.BANGUMI_ACCESS_TOKEN);
  if (platform !== "win32" || !env.LOCALAPPDATA) return "";
  const filename = path.join(env.LOCALAPPDATA, "galgame-gallery", "bangumi-token.dpapi");
  try { await accessImpl(filename); } catch (error) {
    if (error.code === "ENOENT") return "";
    throw new Error("无法读取本地 Bangumi 授权，请重新运行 npm run auth:setup");
  }
  // Only the same Windows user on this machine can decrypt the DPAPI value.
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$env:PSModulePath = Join-Path $PSHOME 'Modules'",
    "$file = Join-Path $env:LOCALAPPDATA 'galgame-gallery/bangumi-token.dpapi'",
    "$secret = (Get-Content -LiteralPath $file -Raw).Trim() | ConvertTo-SecureString",
    "$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)",
    "try { [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }",
  ].join("; ");
  try {
    const { stdout } = await runImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, timeout: 10_000, maxBuffer: 8192, env });
    return normalizeAccessToken(stdout);
  } catch {
    // Never print child-process errors: they can contain captured credentials.
    throw new Error("本地 Bangumi 授权无法解密，请重新运行 npm run auth:setup");
  }
}

export function authorizationHeaders(url, accessToken = "") {
  const token = normalizeAccessToken(accessToken);
  if (!token) return {};
  const target = new URL(url);
  if (target.origin !== "https://api.bgm.tv" || !target.pathname.startsWith("/v0/") || target.username || target.password) {
    throw new Error("授权请求只允许发送到 https://api.bgm.tv/v0/，请检查 apiBase");
  }
  return { Authorization: "Bearer " + token };
}

export function authorizationError(status) {
  return new Error(status === 401
    ? "Bangumi 授权已失效或令牌不正确，请重新运行 npm run auth:setup 或更新 GitHub Secret BANGUMI_ACCESS_TOKEN"
    : "Bangumi 拒绝了当前授权（HTTP 403），请检查账号访问权限");
}

/** Validate the credential before a long scrape; never expose the /me payload. */
export async function verifyAccessToken(accessToken, { username, fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const url = "https://api.bgm.tv/v0/me";
  const headers = authorizationHeaders(url, accessToken);
  if (!headers.Authorization) throw new Error("尚未配置 Bangumi 授权，请运行 npm run auth:setup");
  let response;
  try {
    response = await fetchImpl(url, { headers: { "User-Agent": BANGUMI_UA, ...headers },
      redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error("无法连接 Bangumi 验证授权，请检查网络或代理后重试");
  }
  if ([401, 403].includes(response.status)) throw authorizationError(response.status);
  if (!response.ok) throw new Error("Bangumi 授权检查失败（HTTP " + response.status + "）");
  let user;
  try { user = await response.json(); } catch { throw new Error("Bangumi 授权响应格式无效"); }
  if (!Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.username !== "string" || !user.username) {
    throw new Error("Bangumi 授权响应缺少有效账号");
  }
  if (username && user.username.toLowerCase() !== username.toLowerCase()) {
    throw new Error("授权账号与 config.json 中的 Bangumi 用户不一致，请使用 " + username + " 的令牌");
  }
  return { id: user.id, username: user.username };
}
