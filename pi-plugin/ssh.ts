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
 *   - bash on remote
 */

import { spawn, spawnSync } from "node:child_process";
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
			throw new Error(`SSH failed (${r.code}): ${r.stderr}`);
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
				reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
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

// 单次 spawn plink；指纹缺失时首次连接会因 hostkey 未缓存而失败
function spawnPlink(remote: string, command: string, options: PlinkRunOptions, fingerprint: string | undefined): Promise<PlinkResult> {
	return new Promise((resolve, reject) => {
		const bin = resolvePlink();
		if (!bin) {
			reject(new Error("未找到 plink：请 winget install PuTTY.PuTTY 或 scoop install putty，或下载 plink.exe 放入 PATH"));
			return;
		}
		const args = ["-ssh", "-batch"];
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
		return spawnPlink(remote, command, options, fingerprint);
	});
}

function toRemotePath(filePath: string, localCwd: string, remoteCwd: string): string {
	const normalizedPath = filePath.replaceAll("\\", "/");
	const normalizedLocalCwd = localCwd.replaceAll("\\", "/").replace(/\/+$/, "");
	const normalizedRemoteCwd = remoteCwd.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
	const comparablePath = process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
	const comparableLocalCwd = process.platform === "win32" ? normalizedLocalCwd.toLowerCase() : normalizedLocalCwd;
	const comparableRemoteCwd = process.platform === "win32" ? normalizedRemoteCwd.toLowerCase() : normalizedRemoteCwd;

	if (comparablePath === comparableRemoteCwd || comparablePath.startsWith(`${comparableRemoteCwd}/`)) {
		return normalizedPath;
	}
	if (comparablePath === comparableLocalCwd) return normalizedRemoteCwd;
	if (comparablePath.startsWith(`${comparableLocalCwd}/`)) {
		return `${normalizedRemoteCwd}/${normalizedPath.slice(normalizedLocalCwd.length + 1)}`;
	}
	if (process.platform === "win32" && /^[A-Za-z]:\//.test(normalizedPath)) {
		return normalizedPath.slice(2) || "/";
	}
	throw new Error(`路径不在 SSH 工作区内: ${filePath}`);
}

function quoteRemoteArg(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function toLocalPath(remotePath: string, localCwd: string, remoteCwd: string): string {
	const normalizedPath = remotePath.replaceAll("\\", "/");
	const normalizedRemoteCwd = remoteCwd.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
	const comparablePath = normalizedPath.toLowerCase();
	const comparableRemoteCwd = normalizedRemoteCwd.toLowerCase();
	if (comparablePath === comparableRemoteCwd) return localCwd;
	if (normalizedRemoteCwd === "/" && normalizedPath.startsWith("/")) {
		return path.join(localCwd, ...normalizedPath.slice(1).split("/"));
	}
	if (comparablePath.startsWith(`${comparableRemoteCwd}/`)) {
		const relative = normalizedPath.slice(normalizedRemoteCwd.length + 1);
		return path.join(localCwd, ...relative.split("/"));
	}
	return remotePath;
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
			const patternArgs = pattern.includes("/")
				? ["-path", path.posix.join(remotePath, pattern)]
				: ["-name", pattern];
			const ignoreArgs = ignore.flatMap((item) => ["!", "-path", path.posix.join(remotePath, item)]);
			const maxResults = Math.max(1, Math.floor(limit));
			const command = [
				"find",
				quoteRemoteArg(remotePath),
				"-type",
				"f",
				...ignoreArgs.map(quoteRemoteArg),
				...patternArgs.map(quoteRemoteArg),
				"-print",
				"|",
				"head",
				"-n",
				String(maxResults),
			].join(" ");
			const output = await execShell(remote, command);
			return output.toString().split(/\r?\n/).filter(Boolean).map((p) => toLocalPath(p, cwd, remotePath));
		},
	};
}

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
	const toRemote = (p: string) => toRemotePath(p, localCwd, remoteCwd);
	return {
		readFile: (p) => execShell(remote, `cat ${JSON.stringify(toRemote(p))}`),
		access: (p) => execShell(remote, `test -r ${JSON.stringify(toRemote(p))}`).then(() => {}),
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
	remote: string,
	remoteCwd: string,
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
	const searchPath = input.path ? path.resolve(localCwd, input.path) : localCwd;
	const remotePath = toRemotePath(searchPath, localCwd, remoteCwd);
	if (!(await remotePathExists(remote, remotePath))) throw new Error(`Path not found: ${searchPath}`);
	const isDirectory = await remotePathExists(remote, `${remotePath}/.`);
	const workDir = isDirectory ? remotePath : path.posix.dirname(remotePath);
	const target = isDirectory ? "." : path.posix.basename(remotePath);
	const tool = await resolveRemoteGrepTool(remote);
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
	const output = (await execShell(remote, command)).toString().trimEnd();
	if (!output) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
	const limit = Math.max(1, Math.floor(input.limit ?? 100));
	const lines = output.split(/\r?\n/);
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
	let resolvedSsh: { remote: string; remoteCwd: string } | null = null;

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
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = requireSsh();
			const ops = ssh ? createRemoteWriteOps(ssh.remote, ssh.remoteCwd, sessionCwd) : undefined;
			const tool = createWriteTool(sessionCwd, ops ? { operations: ops } : undefined);
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = requireSsh();
			const ops = ssh ? createRemoteEditOps(ssh.remote, ssh.remoteCwd, sessionCwd) : undefined;
			const tool = createEditTool(sessionCwd, ops ? { operations: ops } : undefined);
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = requireSsh();
			if (!ssh) return localLs.execute(id, params, signal, onUpdate);
			const tool = createLsTool(sessionCwd, { operations: createRemoteLsOps(ssh.remote, ssh.remoteCwd, sessionCwd) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = requireSsh();
			if (!ssh) return localFind.execute(id, params, signal, onUpdate);
			const tool = createFindTool(sessionCwd, { operations: createRemoteFindOps(ssh.remote, ssh.remoteCwd, sessionCwd) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(_id, params, signal) {
			const ssh = requireSsh();
			if (!ssh) return localGrep.execute(_id, params, signal);
			return executeRemoteGrep(ssh.remote, ssh.remoteCwd, sessionCwd, params, signal);
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
				if (sep >= 0 && !suffix.startsWith("/") && /^\d+$/.test(suffix)) {
					// 冒号后纯数字为端口（如 host:2222），cwd 由远端 pwd 解析
					sshPort = suffix;
					const remote = arg.slice(0, sep);
					const pwd = (await execShell(remote, "pwd")).toString().trim();
					resolvedSsh = { remote, remoteCwd: pwd };
				} else if (sep >= 0) {
					// 冒号后视为远程路径（如 host:/remote/path）
					resolvedSsh = { remote: arg.slice(0, sep), remoteCwd: suffix };
				} else {
					// 无路径无端口，cwd 由远端 pwd 解析
					const remote = arg;
					const pwd = (await execShell(remote, "pwd")).toString().trim();
					resolvedSsh = { remote, remoteCwd: pwd };
				}
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
