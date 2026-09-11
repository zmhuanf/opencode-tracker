/**
 * SSH Remote Execution Example
 *
 * Demonstrates delegating tool operations to a remote machine via SSH.
 * When --ssh is provided, read/write/edit/bash run on the remote.
 *
 * Usage:
 *   pi -e ./ssh.ts --ssh user@host
 *   pi -e ./ssh.ts --ssh user@host:/remote/path
 *   pi -e ./ssh.ts --ssh user@host:2222   (非默认 SSH 端口)
 *   npm run start -- --ssh user@host[:/remote/path|:<port>]  (pi-web 注入 PI_WEB_SSH)
 *   npm run start -- --ssh user@host:/path --pass xxx  (密码经 plink -pw)
 *
 * Requirements:
 *   - key 认证走原生 ssh；密码认证需 plink（scoop install putty）
 *   - 密码认证经常驻 plink -share 连接复用，避免每次命令重新握手
 *   - bash on remote
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLocalBashOperations,
	createLsTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type FindOperations,
	type LsOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

// 冒号后纯数字视为端口（如 host:2222），跨会话可被 buildSshInvocation 读取
let sshPort: string | undefined;

export interface SshTarget {
	remote: string;
	remoteCwd: string;
	remoteHome: string;
}
// sshpass/askpass 在本机均无法喂密码（详见排查），密码认证改用 plink -pw
// 首次连接自动提取指纹并缓存，plink -hostkey 可免交互信任
const HOSTKEY_STORE = path.join(os.tmpdir(), "pi-web-ssh-hostkeys.json");

function storedHostKey(remote: string): string | undefined {
	try {
		const store = JSON.parse(fs.readFileSync(HOSTKEY_STORE, "utf8"));
		return store[`${remote}:${sshPort ?? "22"}`];
	} catch {
		return undefined;
	}
}

function saveHostKey(remote: string, fingerprint: string): void {
	let store: Record<string, string> = {};
	try {
		store = JSON.parse(fs.readFileSync(HOSTKEY_STORE, "utf8"));
	} catch {
		// 缓存损坏时重建
	}
	store[`${remote}:${sshPort ?? "22"}`] = fingerprint;
	try {
		fs.writeFileSync(HOSTKEY_STORE, JSON.stringify(store), "utf8");
	} catch {
		// 写失败仅影响下次自动重试，不影响本次连接
	}
}

// 从 plink 错误输出提取 host key 指纹（ssh-ed25519 255 SHA256:xxxx）
function extractFingerprint(stderr: string): string | undefined {
	const m = stderr.match(/SHA256:[A-Za-z0-9+/=]+/);
	return m?.[0];
}

// 无密码的 key 认证走原生 ssh
function buildSshInvocation(remote: string, command: string): { bin: string; args: string[]; env: NodeJS.ProcessEnv } {
	// accept-new 免首次连接 host key 确认（stdin 被 ignore 无法交互）
	const sshArgs = ["-o", "StrictHostKeyChecking=accept-new", ...(sshPort ? ["-p", sshPort] : []), remote, command];
	return { bin: "ssh", args: sshArgs, env: process.env };
}

// 无密码时走原生 ssh（key 认证），有密码时走 plink -pw
function execShell(remote: string, command: string): Promise<Buffer> {
	const pass = process.env.PI_WEB_SSH_PASSWORD;
	if (!pass) {
		return sshOutput(remote, command);
	}
	return plinkOutput(remote, command).then((r) => {
		if (r.code !== 0) {
			const stderr = r.stderr.trim();
			// plink 失败时原因可能在 stdout，两者都带上才能定位
			throw new Error(`SSH failed (${r.code}): ${stderr || r.stdout.toString().trim()}`);
		}
		return r.stdout;
	});
}

function sshOutput(remote: string, command: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const { bin, args, env } = buildSshInvocation(remote, command);
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (data) => chunks.push(data));
		child.stderr.on("data", (data) => errChunks.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				const stderr = Buffer.concat(errChunks).toString().trim();
				// ssh 的部分失败原因只出现在 stdout，两者都带上才能定位
				const stdout = Buffer.concat(chunks).toString().trim();
				reject(new Error(`SSH failed (${code}): ${stderr || stdout}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
		});
	});
}

interface PlinkRunOptions {
	onData?: (chunk: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
}

interface PlinkResult {
	code: number | null;
	stdout: Buffer;
	stderr: string;
}

// 定位 plink 绝对路径（PATH 缺失时也可用），避免 spawn 失败难排查
let plinkBin: string | undefined;
function resolvePlink(): string | undefined {
	if (plinkBin) return plinkBin;
	const home = os.homedir();
	const candidates = [
		process.env.PLINK,
		path.join(home, "bin", "plink.exe"),
		path.join(home, "scoop", "shims", "plink.exe"),
		path.join(home, "scoop", "apps", "putty", "current", "plink.exe"),
	];
	for (const c of candidates) {
		if (c && fs.existsSync(c)) {
			plinkBin = c;
			return c;
		}
	}
	try {
		const r = spawnSync("where", ["plink"], { encoding: "utf8" });
		const first = r.stdout.split(/\r?\n/)[0]?.trim();
		if (first && fs.existsSync(first)) {
			plinkBin = first;
			return first;
		}
	} catch {
		// where 不可用时回退 null，错误信息会给出安装指引
	}
	return undefined;
}

// 密码认证无法用原生 ssh 的 ControlMaster，改用 plink -share 复用已认证连接
const UPSTREAM_IDLE_MS = 10 * 60 * 1000;
let upstream: { remote: string; child: ChildProcess } | null = null;
let upstreamIdleTimer: NodeJS.Timeout | undefined;

// 常驻上游：上游自身必须带 -share，否则后续连接无法复用
function startUpstream(remote: string): void {
	const bin = resolvePlink();
	const fingerprint = storedHostKey(remote);
	if (!bin || !fingerprint) return;
	const args = ["-share", "-ssh", "-batch"];
	if (sshPort) args.push("-P", sshPort);
	args.push("-pw", process.env.PI_WEB_SSH_PASSWORD ?? "", "-hostkey", fingerprint, remote, "cat");
	// stdin 保持打开且不 end，远端 cat 阻塞即保持连接；Node 退出时管道关闭自动收盘
	const child = spawn(bin, args, { stdio: ["pipe", "ignore", "ignore"] });
	child.unref();
	child.on("exit", () => {
		if (upstream?.child === child) upstream = null;
	});
	child.on("error", () => {
		if (upstream?.child === child) upstream = null;
	});
	upstream = { remote, child };
}

function stopUpstream(): void {
	if (upstreamIdleTimer) {
		clearTimeout(upstreamIdleTimer);
		upstreamIdleTimer = undefined;
	}
	const child = upstream?.child;
	upstream = null;
	child?.kill();
}

// 确保上游存在并刷新空闲计时；无上游时 -share 自动回退为新建连接，不影响正确性
function touchUpstream(remote: string): void {
	if (!upstream || upstream.remote !== remote || upstream.child.exitCode !== null || upstream.child.killed) {
		stopUpstream();
		startUpstream(remote);
	}
	if (upstreamIdleTimer) clearTimeout(upstreamIdleTimer);
	upstreamIdleTimer = setTimeout(stopUpstream, UPSTREAM_IDLE_MS);
	upstreamIdleTimer.unref();
}

// 单次 spawn plink；指纹缺失时首次连接会因 hostkey 未缓存而失败
function spawnPlink(remote: string, command: string, options: PlinkRunOptions, fingerprint: string | undefined): Promise<PlinkResult> {
	return new Promise((resolve, reject) => {
		const bin = resolvePlink();
		if (!bin) {
			reject(new Error("未找到 plink：请 winget install PuTTY.PuTTY 或 scoop install putty，或下载 plink.exe 放入 PATH"));
			return;
		}
		touchUpstream(remote);
		const args = ["-share", "-ssh", "-batch"];
		if (sshPort) args.push("-P", sshPort);
		args.push("-pw", process.env.PI_WEB_SSH_PASSWORD ?? "");
		if (fingerprint) args.push("-hostkey", fingerprint);
		args.push(remote, command);
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		let timedOut = false;
		const onData = options.onData;
		child.stdout.on("data", (d) => {
			chunks.push(d);
			onData?.(d);
		});
		child.stderr.on("data", (d) => errChunks.push(d));
		const timer = options.timeout
			? setTimeout(() => {
					timedOut = true;
					child.kill();
				}, options.timeout * 1000)
			: undefined;
		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			reject(new Error(`plink 启动失败（${e.message}），请确认已安装 plink`));
		});
		const onAbort = () => child.kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (options.signal?.aborted) reject(new Error("aborted"));
			else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
			else resolve({ code, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errChunks).toString() });
		});
	});
}

// plink 执行；hostkey 未缓存时提取指纹自动信任并重试一次再到缓存文件
function plinkOutput(remote: string, command: string, options: PlinkRunOptions = {}): Promise<PlinkResult> {
	return spawnPlink(remote, command, options, storedHostKey(remote)).then(async (result) => {
		if (result.code === 0 || result.code === undefined || storedHostKey(remote)) return result;
		const fingerprint = extractFingerprint(result.stderr);
		if (!fingerprint) return result;
		saveHostKey(remote, fingerprint);
		// 提前建立常驻连接，本次后续调用即可复用
		startUpstream(remote);
		return spawnPlink(remote, command, options, fingerprint);
	});
}

// Windows 路径大小写不敏感，比较时统一折叠
function foldCase(value: string): string {
	return process.platform === "win32" ? value.toLowerCase() : value;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** glob 转 GNU find 扩展正则：** 跨层，* ? 仅限单层；find 的 -regex 匹配从搜索根开始的完整路径 */
function globToFindRegex(glob: string, searchRoot: string): string {
	const segments = glob.replaceAll("\\", "/").split("/").filter((segment) => segment !== "" && segment !== ".");
	const body = segments
		.map((segment, index) => {
			if (segment === "**") return index === segments.length - 1 ? ".*" : "(.*/)?";
			const literal = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*").replaceAll("?", "[^/]");
			return `${literal}/`;
		})
		.join("");
	const root = searchRoot.replaceAll("\\", "/").replace(/\/+$/, "");
	const prefix = root === "" ? "/" : `${escapeRegExp(root)}/`;
	return `^${prefix}${body.replace(/\/$/, "")}$`;
}

/** 文案里的本地镜像路径还原为远程路径，命名空间外的本地路径保持原样 */
function restoreRemoteText(text: string, localCwd: string, ssh: SshTarget): string {
	const absolute = new RegExp(`${escapeRegExp(localCwd)}[^\\s"'\`()]*`, "gi");
	// 工具回显的可能是不带本地前缀的镜像相对路径
	const relative = new RegExp(`(?:${escapeRegExp(SSH_NAMESPACE)}/[^\\s"'\`()]*)`, "g");
	return text
		.replace(absolute, (match) => {
			try {
				return toRemotePath(match, localCwd, ssh.remoteCwd);
			} catch {
				return match;
			}
		})
		.replace(relative, (match) => `/${match.slice(SSH_NAMESPACE.length + 1)}`);
}

/** SSH 模式下统一还原返回内容与错误信息中的路径显示 */
async function withRemotePaths<T>(localCwd: string, ssh: SshTarget, run: () => Promise<T>): Promise<T> {
	try {
		const result = (await run()) as {
			content?: { type: string; text?: string }[];
			details?: { diff?: string; patch?: string };
		};
		for (const block of result?.content ?? []) {
			if (block.type === "text" && block.text) block.text = restoreRemoteText(block.text, localCwd, ssh);
		}
		if (result?.details?.diff) result.details.diff = restoreRemoteText(result.details.diff, localCwd, ssh);
		if (result?.details?.patch) result.details.patch = restoreRemoteText(result.details.patch, localCwd, ssh);
		return result as T;
	} catch (error) {
		throw new Error(restoreRemoteText(error instanceof Error ? error.message : String(error), localCwd, ssh));
	}
}

// 目标相对工作区的片段，null 表示落在工作区外
function relativeWithin(target: string, root: string): string | null {
	const normalizedTarget = target.replaceAll("\\", "/");
	const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
	if (normalizedRoot === "/") return foldCase(normalizedTarget) === "/" ? "" : normalizedTarget.replace(/^\/+/, "");
	if (foldCase(normalizedTarget) === foldCase(normalizedRoot)) return "";
	if (foldCase(normalizedTarget).startsWith(`${foldCase(normalizedRoot)}/`)) {
		return normalizedTarget.slice(normalizedRoot.length + 1);
	}
	return null;
}

// 远程根命名空间：镜像路径仅在本地下虚拟存在，从不写盘
const SSH_NAMESPACE = ".__pi_ssh__";

function stripTrailingSlash(value: string): string {
	return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

function mirrorRoot(localCwd: string): string {
	return path.join(localCwd, SSH_NAMESPACE);
}

/** 远程绝对路径换算为本地镜像绝对路径，远程 / 对应命名空间根 */
export function remoteToMirror(remotePath: string, localCwd: string): string {
	const relative = remotePath.replaceAll("\\", "/").replace(/^\/+/, "");
	return relative === "" ? mirrorRoot(localCwd) : path.join(mirrorRoot(localCwd), ...relative.split("/"));
}

// SDK 解析后的镜像本地路径还原为远程绝对路径
function toRemotePath(filePath: string, localCwd: string, remoteCwd: string): string {
	// 会话 cwd 自身代表远程工作目录
	if (foldCase(stripTrailingSlash(filePath)) === foldCase(stripTrailingSlash(localCwd))) return remoteCwd;
	const relative = relativeWithin(filePath, mirrorRoot(localCwd));
	if (relative === null) throw new Error(`路径不在 SSH 命名空间内: ${filePath}`);
	return relative === "" ? "/" : `/${relative}`;
}

function quoteRemoteArg(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** 模型给出的路径按远程语义解析为远程绝对路径，远程文件系统内任意路径均可访问 */
export function resolveRemotePath(input: string, localCwd: string, ssh: SshTarget): string {
	const normalized = input.replaceAll("\\", "/");
	// SDK 回传的镜像形式还原为远程路径
	const mirrored = relativeWithin(normalized, mirrorRoot(localCwd));
	if (mirrored !== null) return mirrored === "" ? "/" : `/${mirrored}`;
	if (process.platform === "win32" && /^[A-Za-z]:\//.test(normalized)) {
		throw new Error(`${input} 不是远程路径；远程可访问任意绝对路径（如 /etc/hosts）`);
	}
	if (normalized === "~") return ssh.remoteHome;
	if (normalized.startsWith("~/")) return path.posix.normalize(path.posix.join(ssh.remoteHome, normalized.slice(2)));
	if (normalized.startsWith("/")) return path.posix.normalize(normalized);
	return path.posix.normalize(path.posix.join(ssh.remoteCwd, normalized));
}

/** 模型路径折算为 sessionCwd 下的相对镜像路径，交给 SDK 工具自己的路径解析 */
export function toMirrorPath(input: string, localCwd: string, ssh: SshTarget): string {
	const mirror = remoteToMirror(resolveRemotePath(input, localCwd, ssh), localCwd);
	const relative = path.relative(localCwd, mirror);
	return relative === "" ? "." : relative.split(path.sep).join("/");
}

// 一次连接取回远端 cwd 与 $HOME，用于路径镜像
async function probeRemotePaths(remote: string): Promise<{ cwd: string; home: string }> {
	const lines = (await execShell(remote, `pwd; printf '%s\n' "$HOME"`))
		.toString()
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const cwd = lines[0] ?? "/";
	return { cwd, home: lines[1] ?? cwd };
}

async function remotePathExists(remote: string, remotePath: string): Promise<boolean> {
	const output = await execShell(
		remote,
		`if test -e ${quoteRemoteArg(remotePath)}; then printf 1; else printf 0; fi`,
	);
	return output.toString().trim() === "1";
}

async function resolveRemoteGrepTool(remote: string): Promise<"rg" | "grep"> {
	const output = await execShell(
		remote,
		"if command -v rg >/dev/null 2>&1; then printf rg; elif command -v grep >/dev/null 2>&1; then printf grep; else printf none; fi",
	);
	const tool = output.toString().trim();
	if (tool === "rg" || tool === "grep") return tool;
	throw new Error("远程未找到 rg 或 grep");
}

function createRemoteLsOps(remote: string, remoteCwd: string, localCwd: string): LsOperations {
	const toRemote = (p: string) => toRemotePath(p, localCwd, remoteCwd);
	return {
		exists: (p) => remotePathExists(remote, toRemote(p)),
		stat: async (p) => {
			const remotePath = toRemote(p);
			if (!(await remotePathExists(remote, remotePath))) throw new Error(`Path not found: ${p}`);
			const isDirectory = await remotePathExists(remote, `${remotePath}/.`);
			return { isDirectory: () => isDirectory };
		},
		readdir: async (p) => {
			const remotePath = toRemote(p);
			const output = await execShell(remote, `find ${quoteRemoteArg(remotePath)} -mindepth 1 -maxdepth 1 -printf '%f\\n'`);
			return output.toString().split(/\r?\n/).filter(Boolean);
		},
	};
}

function createRemoteFindOps(remote: string, remoteCwd: string, localCwd: string): FindOperations {
	const toRemote = (p: string) => toRemotePath(p, localCwd, remoteCwd);
	return {
		exists: (p) => remotePathExists(remote, toRemote(p)),
		glob: async (pattern, cwd, { ignore, limit }) => {
			const remotePath = toRemote(cwd);
			const maxResults = Math.max(1, Math.floor(limit));
			// GNU find 的 -path 不支持 ** 跨层，改用扩展正则精确表达 glob
			const regexArgs = [
				...ignore.flatMap((item) => ["!", "-regex", globToFindRegex(item, remotePath)]),
				"-regex",
				globToFindRegex(pattern, remotePath),
			];
			const command = [
				"find",
				quoteRemoteArg(remotePath),
				"-regextype",
				"posix-extended",
				"-type",
				"f",
				...regexArgs.map(quoteRemoteArg),
				"-print",
				"|",
				"head",
				"-n",
				String(maxResults),
			].join(" ");
			const output = await execShell(remote, command);
			return output.toString().split(/\r?\n/).filter(Boolean).map((p) => remoteToMirror(p, localCwd));
		},
	};
}

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
	const toRemote = (p: string) => toRemotePath(p, localCwd, remoteCwd);
	return {
		readFile: (p) => execShell(remote, `cat ${quoteRemoteArg(toRemote(p))}`),
		access: async (p) => {
			const remotePath = toRemote(p);
			const output = await execShell(
				remote,
				`if test -r ${quoteRemoteArg(remotePath)}; then printf 1; else printf 0; fi`,
			);
			if (output.toString().trim() !== "1") throw new Error(`Path not readable: ${remotePath}`);
		},
		detectImageMimeType: async (p) => {
			try {
				const r = await execShell(remote, `file --mime-type -b ${JSON.stringify(toRemote(p))}`);
				const m = r.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(remote: string, remoteCwd: string, localCwd: string): WriteOperations {
	const toRemote = (p: string) => toRemotePath(p, localCwd, remoteCwd);
	return {
		writeFile: async (p, content) => {
			const b64 = Buffer.from(content).toString("base64");
			await execShell(remote, `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(toRemote(p))}`);
		},
		mkdir: (dir) => execShell(remote, `mkdir -p ${JSON.stringify(toRemote(dir))}`).then(() => {}),
	};
}

function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string): EditOperations {
	const r = createRemoteReadOps(remote, remoteCwd, localCwd);
	const w = createRemoteWriteOps(remote, remoteCwd, localCwd);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createRemoteBashOps(remote: string, remoteCwd: string, localCwd: string): BashOperations {
	const toRemote = (p: string) => toRemotePath(p, localCwd, remoteCwd);
	const sshRun = (cmd: string, options: { onData?: (d: Buffer) => void; signal?: AbortSignal; timeout?: number }) =>
		new Promise<{ exitCode: number | null }>((resolve, reject) => {
			const { bin, args, env } = buildSshInvocation(remote, cmd);
			const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
			let timedOut = false;
			const timer = options.timeout
				? setTimeout(() => {
						timedOut = true;
						child.kill();
					}, options.timeout * 1000)
				: undefined;
			child.stdout.on("data", (d) => options.onData?.(d));
			child.stderr.on("data", (d) => options.onData?.(d));
			child.on("error", (e) => {
				if (timer) clearTimeout(timer);
				reject(e);
			});
			const onAbort = () => child.kill();
			options.signal?.addEventListener("abort", onAbort, { once: true });
			child.on("close", (code) => {
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				if (options.signal?.aborted) reject(new Error("aborted"));
				else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
				else resolve({ exitCode: code });
			});
		});
	return {
		exec: (command, cwd, { onData, signal, timeout }) => {
			const cmd = `cd ${JSON.stringify(toRemote(cwd))} && ${command}`;
			if (process.env.PI_WEB_SSH_PASSWORD) {
				return plinkOutput(remote, cmd, { onData, signal, timeout }).then((r) => ({ exitCode: r.code ?? 1 }));
			}
			return sshRun(cmd, { onData, signal, timeout });
		},
	};
}

async function executeRemoteGrep(
	ssh: SshTarget,
	localCwd: string,
	params: unknown,
	signal?: AbortSignal,
) {
	if (signal?.aborted) throw new Error("Operation aborted");
	const input = params as {
		pattern: string;
		path?: string;
		glob?: string;
		ignoreCase?: boolean;
		literal?: boolean;
		context?: number;
		limit?: number;
	};
	const remotePath = input.path ? resolveRemotePath(input.path, localCwd, ssh) : ssh.remoteCwd;
	if (!(await remotePathExists(ssh.remote, remotePath))) throw new Error(`Path not found: ${input.path ?? remotePath}`);
	const isDirectory = await remotePathExists(ssh.remote, `${remotePath}/.`);
	const workDir = isDirectory ? remotePath : path.posix.dirname(remotePath);
	const target = isDirectory ? "." : path.posix.basename(remotePath);
	const tool = await resolveRemoteGrepTool(ssh.remote);
	const args = tool === "rg"
		? ["rg", "--line-number", "--color=never", "--hidden", "--no-heading"]
		: ["grep", "-r", "-n", "-H", "-I", "--exclude-dir", "node_modules", "--exclude-dir", ".git"];
	if (input.ignoreCase) args.push(tool === "rg" ? "--ignore-case" : "-i");
	if (input.literal) args.push(tool === "rg" ? "--fixed-strings" : "-F");
	if (input.context && input.context > 0) args.push("-C", String(Math.floor(input.context)));
	if (tool === "rg") {
		args.push("--glob", "!**/node_modules/**", "--glob", "!**/.git/**");
		if (input.glob) args.push("--glob", input.glob);
	} else if (input.glob) {
		args.push("--include", input.glob);
	}
	args.push(tool === "rg" ? "--" : "-e", input.pattern, target);
	const command = [
		`cd ${quoteRemoteArg(workDir)} &&`,
		args.map(quoteRemoteArg).join(" "),
		`; status=$?; if [ "$status" -eq 1 ]; then exit 0; fi; exit "$status"`,
	].join(" ");
	const output = (await execShell(ssh.remote, command)).toString().trimEnd();
	if (!output) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
	const limit = Math.max(1, Math.floor(input.limit ?? 100));
	// grep -r 输出带 ./ 前缀，去掉以对齐本地 pi 的显示
	const lines = output.split(/\r?\n/).map((line) => line.replace(/^\.\//, ""));
	const limited = lines.slice(0, limit).join("\n");
	return {
		content: [{ type: "text" as const, text: limited }],
		details: lines.length > limit ? { matchLimitReached: limit } : undefined,
	};
}

// 宿主的运行时变量不应泄漏给项目命令（与 pi-web sanitize 逻辑一致）
function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const cleaned = { ...env };
	for (const key of Object.keys(cleaned)) {
		const comparable = process.platform === "win32" ? key.toUpperCase() : key;
		if (comparable === "PORT" || comparable === "NODE_ENV" || comparable.startsWith("NEXT_")) {
			delete cleaned[key];
		}
	}
	return cleaned;
}

// 本地执行时清洗 env，阻断宿主变量透传
function createSanitizedLocalBashOps(): BashOperations {
	const local = createLocalBashOperations();
	return {
		exec: (command, execCwd, options) =>
			local.exec(command, execCwd, { ...options, env: sanitizeEnv(options.env ?? process.env) }),
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

	// pi-web 的进程 cwd 是宿主根目录，会话 cwd 须在 session_start 用 ctx.cwd 绑定
	let sessionCwd = process.cwd();
	const localRead = createReadTool(sessionCwd);
	const localWrite = createWriteTool(sessionCwd);
	const localEdit = createEditTool(sessionCwd);
	const localLs = createLsTool(sessionCwd);
	const localFind = createFindTool(sessionCwd);
	const localGrep = createGrepTool(sessionCwd);
	const localBashOps = createSanitizedLocalBashOps();
	const localBash = createBashTool(sessionCwd, { operations: localBashOps });

	// Resolved lazily on session_start (CLI flags not available during factory)
	let resolvedSsh: SshTarget | null = null;

	const getSsh = () => resolvedSsh;
	const isSshConfigured = () => Boolean(process.env.PI_WEB_SSH || typeof pi.getFlag("ssh") === "string");
	const requireSsh = () => {
		const ssh = getSsh();
		if (ssh) return ssh;
		if (isSshConfigured()) throw new Error("SSH 未连接，已拒绝本地执行");
		return undefined;
	};

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = requireSsh();
			const ops = ssh ? createRemoteReadOps(ssh.remote, ssh.remoteCwd, sessionCwd) : undefined;
			const tool = createReadTool(sessionCwd, ops ? { operations: ops } : undefined);
			const input = ssh ? { ...params, path: toMirrorPath(params.path, sessionCwd, ssh) } : params;
			if (!ssh) return tool.execute(id, input, signal, onUpdate);
			return withRemotePaths(sessionCwd, ssh, () => tool.execute(id, input, signal, onUpdate));
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = requireSsh();
			const ops = ssh ? createRemoteWriteOps(ssh.remote, ssh.remoteCwd, sessionCwd) : undefined;
			const tool = createWriteTool(sessionCwd, ops ? { operations: ops } : undefined);
			const input = ssh ? { ...params, path: toMirrorPath(params.path, sessionCwd, ssh) } : params;
			if (!ssh) return tool.execute(id, input, signal, onUpdate);
			return withRemotePaths(sessionCwd, ssh, () => tool.execute(id, input, signal, onUpdate));
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = requireSsh();
			const ops = ssh ? createRemoteEditOps(ssh.remote, ssh.remoteCwd, sessionCwd) : undefined;
			const tool = createEditTool(sessionCwd, ops ? { operations: ops } : undefined);
			const input = ssh ? { ...params, path: toMirrorPath(params.path, sessionCwd, ssh) } : params;
			if (!ssh) return tool.execute(id, input, signal, onUpdate);
			return withRemotePaths(sessionCwd, ssh, () => tool.execute(id, input, signal, onUpdate));
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = requireSsh();
			if (!ssh) return localLs.execute(id, params, signal, onUpdate);
			const tool = createLsTool(sessionCwd, { operations: createRemoteLsOps(ssh.remote, ssh.remoteCwd, sessionCwd) });
			const input = params.path ? { ...params, path: toMirrorPath(params.path, sessionCwd, ssh) } : params;
			return withRemotePaths(sessionCwd, ssh, () => tool.execute(id, input, signal, onUpdate));
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = requireSsh();
			if (!ssh) return localFind.execute(id, params, signal, onUpdate);
			const tool = createFindTool(sessionCwd, { operations: createRemoteFindOps(ssh.remote, ssh.remoteCwd, sessionCwd) });
			const input = params.path ? { ...params, path: toMirrorPath(params.path, sessionCwd, ssh) } : params;
			return withRemotePaths(sessionCwd, ssh, () => tool.execute(id, input, signal, onUpdate));
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(_id, params, signal) {
			const ssh = requireSsh();
			if (!ssh) return localGrep.execute(_id, params, signal);
			return withRemotePaths(sessionCwd, ssh, () => executeRemoteGrep(ssh, sessionCwd, params, signal));
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = requireSsh();
			const ops = ssh ? createRemoteBashOps(ssh.remote, ssh.remoteCwd, sessionCwd) : undefined;
			const tool = createBashTool(sessionCwd, ops ? { operations: ops } : undefined);
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// 绑定会话 cwd（pi CLI 下等于进程 cwd，pi-web 下以 ctx.cwd 为准）
		sessionCwd = ctx.cwd;
		// pi-web 经 ssh-launcher 注入 PI_WEB_SSH，pi CLI 直接传 --ssh flag
		const flag = pi.getFlag("ssh");
		const arg = process.env.PI_WEB_SSH ?? (typeof flag === "string" ? flag : undefined);
		if (arg) {
			try {
				const sep = arg.indexOf(":");
				const suffix = sep >= 0 ? arg.slice(sep + 1) : "";
				// 冒号后纯数字视为端口（host:2222），其余视为远程路径（host:/remote/path）
				const portOnly = sep >= 0 && /^\d+$/.test(suffix);
				const remote = sep >= 0 ? arg.slice(0, sep) : arg;
				if (portOnly) sshPort = suffix;
				const probe = await probeRemotePaths(remote);
				resolvedSsh = {
					remote,
					remoteCwd: (portOnly || sep < 0 ? probe.cwd : suffix).replace(/\/+$/, "") || "/",
					remoteHome: probe.home,
				};
				ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`));
				ctx.ui.notify(`SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, "info");
				console.log(`[pi-web] SSH connected: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				console.error(`[pi-web] SSH failed: ${detail}`);
				ctx.ui.notify(`SSH 连接失败（${detail}），已拒绝本地执行`, "error");
			}
		}
	});

	// 会话销毁时释放常驻连接
	pi.on("session_shutdown", () => {
		stopUpstream();
	});

	// user_bash 旁路同样清洗本地环境，SSH 时仍走远程
	pi.on("user_bash", (_event) => {
		const ssh = requireSsh();
		if (!ssh) return { operations: localBashOps };
		return { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, sessionCwd) };
	});

	// Replace local cwd with remote cwd in system prompt
	pi.on("before_agent_start", async (event) => {
		const ssh = getSsh();
		if (ssh) {
			const modified = event.systemPrompt.replace(
				`Current working directory: ${sessionCwd}`,
				`Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`,
			);
			return { systemPrompt: modified };
		}
	});
}
