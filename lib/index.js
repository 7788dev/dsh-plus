import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
//#region lib/types/document.js
/**
* On-disk Settings document for UI-managed MCP servers.
* @module @deepseek-ai/dsh-mcp-settings/document
*/
/** Current Settings document envelope version. */
const MCP_SETTINGS_DOCUMENT_VERSION = 1;
/** Default filename under the harness home. */
const MCP_SETTINGS_DOCUMENT_FILENAME = "mcp-servers.json";
/** Module specifier of every Settings-owned and composition-owned MCP client. */
const MCP_CLIENT_MODULE = "@deepseek-ai/dsh-mcp-client";
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 6e4;
/**
* Return an empty Settings document.
* @returns version 1 document with no servers.
*/
function emptyMcpSettingsDocument() {
	return {
		version: 1,
		servers: []
	};
}
/**
* Parse and validate a Settings document body.
* @param text - UTF-8 JSON file contents.
* @returns the validated document.
*/
function parseMcpSettingsDocument(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		throw new Error("mcp-settings: document is not valid JSON", { cause });
	}
	if (!isRecord(parsed)) throw new Error("mcp-settings: document must be a JSON object");
	assertKnownKeys(parsed, ["version", "servers"], "document");
	if (parsed.version !== 1) throw new Error(`mcp-settings: unsupported document version ${String(parsed.version)}`);
	if (!Array.isArray(parsed.servers)) throw new Error("mcp-settings: document.servers must be an array");
	const servers = parsed.servers.map((entry, index) => parseRecord(entry, `servers[${index}]`));
	const names = /* @__PURE__ */ new Set();
	for (const server of servers) {
		if (names.has(server.serverName)) throw new Error(`mcp-settings: duplicate serverName ${JSON.stringify(server.serverName)}`);
		names.add(server.serverName);
	}
	return {
		version: 1,
		servers
	};
}
/**
* Serialize a Settings document as stable JSON.
* @param document - validated document.
* @returns UTF-8 JSON with a trailing newline.
*/
function serializeMcpSettingsDocument(document) {
	return `${JSON.stringify(document, null, 2)}\n`;
}
/**
* Apply an upsert to a document. `env` / `headers` omission keeps the stored map.
* A distinct `fromServerName` replaces that Settings row in place.
* @param document - current document.
* @param request - create, replace, or rename payload.
* @returns a new document.
*/
function upsertMcpServerRecord(document, request) {
	const nextName = parseServerName(request.serverName);
	const fromName = request.fromServerName === void 0 ? nextName : parseServerName(request.fromServerName, "fromServerName");
	const existing = document.servers.find((server) => server.serverName === fromName);
	if (fromName !== nextName) {
		if (existing === void 0) throw new Error(`mcp-settings: no Settings-owned server named ${JSON.stringify(fromName)}`);
		if (document.servers.some((server) => server.serverName === nextName)) throw new Error(`mcp-settings: cannot rename ${JSON.stringify(fromName)} to ${JSON.stringify(nextName)} because that serverName is already in use`);
	}
	const next = mergeRecord(existing, request);
	return {
		version: 1,
		servers: existing === void 0 ? [...document.servers, next] : document.servers.map((server) => server.serverName === fromName ? next : server)
	};
}
/**
* Remove one Settings-owned server.
* @param document - current document.
* @param serverName - namespace to delete.
* @returns the document without that server.
*/
function removeMcpServerRecord(document, serverName) {
	return {
		version: 1,
		servers: document.servers.filter((server) => server.serverName !== serverName)
	};
}
/**
* Convert a persisted record into mcp-client plugin config.
* @param record - Settings-owned server.
* @returns config matching mcp-client's schema defaults.
*/
function toMcpClientConfig(record) {
	switch (record.transport) {
		case "stdio": return {
			transport: "stdio",
			serverName: record.serverName,
			command: record.command,
			args: [...record.args],
			env: { ...record.env },
			cwd: record.cwd,
			toolCallTimeoutMs: record.toolCallTimeoutMs,
			failOnStartupError: record.failOnStartupError
		};
		case "streamable-http": return {
			transport: "streamable-http",
			serverName: record.serverName,
			url: record.url,
			headers: { ...record.headers },
			toolCallTimeoutMs: record.toolCallTimeoutMs,
			failOnStartupError: record.failOnStartupError
		};
		/* v8 ignore start -- transport union is exhaustive at the type boundary */
		default: return record;
	}
}
/**
* Public-name prefix mcp-client uses for every tool in one server namespace.
* @param serverName - MCP `serverName` (1–32 `[A-Za-z0-9_-]`).
* @returns `mcp__<serverName>__`, including the trailing separators.
*/
function mcpToolNamePrefix(serverName) {
	return `mcp__${serverName}__`;
}
/**
* Count globally registered tools owned by one MCP server namespace.
* The prefix includes the trailing separators so `js` does not count `js_extra`.
* @param names - public tool names from the global `ctx.tools` view.
* @param serverName - MCP `serverName`.
* @returns matching name count.
*/
function countMcpTools(names, serverName) {
	const prefix = mcpToolNamePrefix(serverName);
	let count = 0;
	for (const name of names) if (name.startsWith(prefix)) count += 1;
	return count;
}
/**
* Project a Settings-owned record for the Remote, omitting secret values.
* @param record - persisted server.
* @param origin - settings vs composition.
* @param fiberPhase - live fiber phase.
* @param toolCount - globally registered tools in this server's namespace.
* @returns client-safe view.
*/
function viewMcpServerRecord(record, origin, fiberPhase, toolCount) {
	switch (record.transport) {
		case "stdio": return {
			serverName: record.serverName,
			origin,
			enabled: record.enabled,
			fiberPhase,
			toolCount,
			transport: "stdio",
			command: record.command,
			args: [...record.args],
			cwd: record.cwd,
			envKeys: Object.keys(record.env),
			headerKeys: [],
			toolCallTimeoutMs: record.toolCallTimeoutMs,
			failOnStartupError: record.failOnStartupError
		};
		case "streamable-http": return {
			serverName: record.serverName,
			origin,
			enabled: record.enabled,
			fiberPhase,
			toolCount,
			transport: "streamable-http",
			url: record.url,
			envKeys: [],
			headerKeys: Object.keys(record.headers),
			toolCallTimeoutMs: record.toolCallTimeoutMs,
			failOnStartupError: record.failOnStartupError
		};
		/* v8 ignore start -- transport union is exhaustive at the type boundary */
		default: return record;
	}
}
/**
* Best-effort projection of a composition-owned mcp-client config.
* Secret maps contribute keys only. Unrecognized config yields null.
* @param config - Loader entry config after interpolation.
* @param enabled - Loader enablement.
* @param fiberPhase - live fiber phase.
* @param toolNames - public tool names from the global `ctx.tools` view.
* @returns a read-only view, or null when the config is not an MCP client.
*/
function viewCompositionConfig(config, enabled, fiberPhase, toolNames = []) {
	if (!isRecord(config) || typeof config.serverName !== "string") return null;
	if (!SERVER_NAME_PATTERN.test(config.serverName)) return null;
	const toolCount = countMcpTools(toolNames, config.serverName);
	if (config.transport === "stdio") {
		if (typeof config.command !== "string") return null;
		return viewMcpServerRecord({
			transport: "stdio",
			serverName: config.serverName,
			enabled,
			command: config.command,
			args: Array.isArray(config.args) ? config.args.filter((item) => typeof item === "string") : [],
			env: stringMap(config.env),
			cwd: typeof config.cwd === "string" ? config.cwd : "",
			toolCallTimeoutMs: numberOr(config.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS),
			failOnStartupError: config.failOnStartupError === true
		}, "composition", fiberPhase, toolCount);
	}
	if (config.transport === "streamable-http") {
		if (typeof config.url !== "string") return null;
		return viewMcpServerRecord({
			transport: "streamable-http",
			serverName: config.serverName,
			enabled,
			url: config.url,
			headers: stringMap(config.headers),
			toolCallTimeoutMs: numberOr(config.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS),
			failOnStartupError: config.failOnStartupError === true
		}, "composition", fiberPhase, toolCount);
	}
	return null;
}
function mergeRecord(existing, request) {
	const enabled = request.enabled ?? existing?.enabled ?? true;
	const toolCallTimeoutMs = request.toolCallTimeoutMs ?? existing?.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
	const failOnStartupError = request.failOnStartupError ?? existing?.failOnStartupError ?? false;
	switch (request.transport) {
		case "stdio": return {
			transport: "stdio",
			serverName: parseServerName(request.serverName),
			enabled,
			command: requiredString(request.command, "command"),
			args: request.args === void 0 ? [] : parseStringArray(request.args, "args"),
			env: request.env ?? (existing?.transport === "stdio" ? existing.env : {}),
			cwd: request.cwd ?? "",
			toolCallTimeoutMs,
			failOnStartupError
		};
		case "streamable-http": return {
			transport: "streamable-http",
			serverName: parseServerName(request.serverName),
			enabled,
			url: requiredString(request.url, "url"),
			headers: request.headers ?? (existing?.transport === "streamable-http" ? existing.headers : {}),
			toolCallTimeoutMs,
			failOnStartupError
		};
		/* v8 ignore start -- upsert transport union is exhaustive at the type boundary */
		default: return request;
	}
}
function parseRecord(value, label) {
	if (!isRecord(value)) throw new Error(`mcp-settings: ${label} must be an object`);
	const serverName = parseServerName(value.serverName, label);
	const enabled = value.enabled === void 0 ? true : parseBoolean(value.enabled, `${label}.enabled`);
	const toolCallTimeoutMs = value.toolCallTimeoutMs === void 0 ? DEFAULT_TOOL_CALL_TIMEOUT_MS : parsePositive(value.toolCallTimeoutMs, `${label}.toolCallTimeoutMs`);
	const failOnStartupError = value.failOnStartupError === void 0 ? false : parseBoolean(value.failOnStartupError, `${label}.failOnStartupError`);
	if (value.transport === "stdio") {
		assertKnownKeys(value, [
			"transport",
			"serverName",
			"enabled",
			"command",
			"args",
			"env",
			"cwd",
			"toolCallTimeoutMs",
			"failOnStartupError"
		], label);
		return {
			transport: "stdio",
			serverName,
			enabled,
			command: requiredString(value.command, `${label}.command`),
			args: parseStringArray(value.args, `${label}.args`),
			env: parseStringMap(value.env, `${label}.env`),
			cwd: parseCwd(value.cwd, `${label}.cwd`),
			toolCallTimeoutMs,
			failOnStartupError
		};
	}
	if (value.transport === "streamable-http") {
		assertKnownKeys(value, [
			"transport",
			"serverName",
			"enabled",
			"url",
			"headers",
			"toolCallTimeoutMs",
			"failOnStartupError"
		], label);
		return {
			transport: "streamable-http",
			serverName,
			enabled,
			url: requiredString(value.url, `${label}.url`),
			headers: parseStringMap(value.headers, `${label}.headers`),
			toolCallTimeoutMs,
			failOnStartupError
		};
	}
	throw new Error(`mcp-settings: ${label}.transport must be "stdio" or "streamable-http"`);
}
function parseServerName(value, label = "serverName") {
	const serverName = requiredString(value, label);
	if (!SERVER_NAME_PATTERN.test(serverName)) throw new Error(`mcp-settings: ${label} must match [A-Za-z0-9_-]{1,32}`);
	return serverName;
}
function requiredString(value, label) {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`mcp-settings: ${label} must be a non-empty string`);
	return value;
}
function parseBoolean(value, label) {
	if (typeof value !== "boolean") throw new Error(`mcp-settings: ${label} must be a boolean`);
	return value;
}
function parsePositive(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) throw new Error(`mcp-settings: ${label} must be a positive number`);
	return value;
}
function parseCwd(value, label) {
	if (value === void 0) return "";
	if (typeof value !== "string") throw new Error(`mcp-settings: ${label} must be a string`);
	return value;
}
function parseStringArray(value, label) {
	if (value === void 0) return [];
	if (!Array.isArray(value)) throw new Error(`mcp-settings: ${label} must be an array of strings`);
	const items = [];
	for (const item of value) {
		if (typeof item !== "string") throw new Error(`mcp-settings: ${label} must be an array of strings`);
		items.push(item);
	}
	return items;
}
function assertKnownKeys(value, allowed, label) {
	const known = new Set(allowed);
	for (const key of Object.keys(value)) if (!known.has(key)) throw new Error(`mcp-settings: ${label} has unknown key ${JSON.stringify(key)}`);
}
function parseStringMap(value, label) {
	if (value === void 0) return {};
	if (!isRecord(value)) throw new Error(`mcp-settings: ${label} must be an object of strings`);
	const result = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") throw new Error(`mcp-settings: ${label}.${key} must be a string`);
		result[key] = entry;
	}
	return result;
}
function stringMap(value) {
	if (!isRecord(value)) return {};
	const result = {};
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") result[key] = entry;
	return result;
}
function numberOr(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? value : fallback;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
//#endregion
//#region lib/types/index.js
/**
* Settings-owned MCP server catalog: persist UI-managed servers and mount
* one mcp-client child fiber per enabled record.
* @module @deepseek-ai/dsh-mcp-settings
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
	PENDING: 0,
	LOADING: 1,
	ACTIVE: 2,
	FAILED: 3,
	DISPOSED: 4,
	UNLOADING: 5
};
/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
	[FIBER_STATE.PENDING]: "pending",
	[FIBER_STATE.LOADING]: "loading",
	[FIBER_STATE.ACTIVE]: "active",
	[FIBER_STATE.FAILED]: "failed",
	[FIBER_STATE.DISPOSED]: null,
	[FIBER_STATE.UNLOADING]: "unloading"
};
/**
* Host Remote that stores UI-managed MCP servers and mounts mcp-client
* children for enabled Settings-origin records.
*/
let McpSettingsGateway = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _list_decorators;
	let _upsert_decorators;
	let _delete_decorators;
	return class McpSettingsGateway extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_list_decorators = [Remote("list")];
			_upsert_decorators = [Remote("upsert")];
			_delete_decorators = [Remote("delete")];
			__esDecorate(this, null, _list_decorators, {
				kind: "method",
				name: "list",
				static: false,
				private: false,
				access: {
					has: (obj) => "list" in obj,
					get: (obj) => obj.list
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _upsert_decorators, {
				kind: "method",
				name: "upsert",
				static: false,
				private: false,
				access: {
					has: (obj) => "upsert" in obj,
					get: (obj) => obj.upsert
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _delete_decorators, {
				kind: "method",
				name: "delete",
				static: false,
				private: false,
				access: {
					has: (obj) => "delete" in obj,
					get: (obj) => obj.delete
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = ["tools"];
		static Config = z.object({ path: z.string().required() });
		filename = __runInitializers(this, _instanceExtraInitializers);
		document = emptyMcpSettingsDocument();
		fibers = /* @__PURE__ */ new Map();
		chain = Promise.resolve();
		/**
		* @param ctx - Host context carrying `ctx.tools`.
		* @param config - resolved document path.
		*/
		constructor(ctx, config) {
			super(ctx, "mcpSettings");
			this.filename = resolve(config.path);
		}
		/** Read the document and mount enabled Settings-origin servers. */
		async [Service.init]() {
			this.document = await this.readDocument();
			this.syncAll();
			this.ctx.effect(() => async () => {
				const names = [...this.fibers.keys()];
				for (const name of names) await this.dropFiber(name);
			}, "mcp-settings.dispose-children");
		}
		/**
		* Project Settings-owned records and composition-owned mcp-client rows.
		* Secret maps contribute keys only. Each row includes the live fiber phase
		* and the number of globally registered tools in that server's namespace.
		* @returns the current catalog snapshot.
		*/
		list() {
			return this.enqueue(() => Promise.resolve({ servers: this.snapshot() }));
		}
		/**
		* Create or replace one Settings-owned MCP server and remount its fiber.
		* A distinct `fromServerName` renames that Settings row in place, keeps
		* omitted env/headers, and remounts tools under the new namespace.
		* @param request - create, replace, or rename payload.
		* @returns acknowledgement after the document commit.
		*/
		upsert(request) {
			return this.enqueue(async () => {
				this.assertNotComposition(request.serverName, "upsert");
				const fromName = request.fromServerName;
				if (fromName !== void 0 && fromName !== request.serverName) this.assertNotComposition(fromName, "upsert");
				this.document = upsertMcpServerRecord(this.document, request);
				await this.persist();
				if (fromName !== void 0 && fromName !== request.serverName) await this.dropFiber(fromName);
				const record = this.document.servers.find((server) => server.serverName === request.serverName);
				/* v8 ignore start -- upsertMcpServerRecord always inserts or replaces request.serverName */
				if (record === void 0) throw new Error(`mcp-settings: upsert did not persist ${JSON.stringify(request.serverName)}`);
				/* v8 ignore stop */
				await this.syncRecord(record);
				return { ok: true };
			});
		}
		/**
		* Delete one Settings-owned MCP server and dispose its fiber.
		* @param request - namespace to delete.
		* @returns acknowledgement after the document commit.
		*/
		delete(request) {
			return this.enqueue(async () => {
				this.assertNotComposition(request.serverName, "delete");
				if (!this.document.servers.some((server) => server.serverName === request.serverName)) throw new Error(`mcp-settings: no Settings-owned server named ${JSON.stringify(request.serverName)}`);
				this.document = removeMcpServerRecord(this.document, request.serverName);
				await this.persist();
				await this.dropFiber(request.serverName);
				return { ok: true };
			});
		}
		snapshot() {
			const toolNames = this.toolNames();
			return [...this.document.servers.map((record) => {
				return viewMcpServerRecord(record, "settings", fiberPhase(this.fibers.get(record.serverName)), countMcpTools(toolNames, record.serverName));
			}), ...this.compositionViews(toolNames)];
		}
		compositionViews(toolNames = this.toolNames()) {
			const views = [];
			for (const entry of this.loaderEntries()) {
				if (entry.options.name !== "@deepseek-ai/dsh-mcp-client") continue;
				const view = viewCompositionConfig(entry.options.config, !entry.disabled, fiberPhase(entry.fiber), toolNames);
				if (view !== null) views.push(view);
			}
			return views;
		}
		toolNames() {
			return this.ctx.tools.schemas().map((schema) => schema.name);
		}
		compositionNames() {
			return new Set(this.compositionViews().map((view) => view.serverName));
		}
		assertNotComposition(serverName, action) {
			if (this.compositionNames().has(serverName)) throw new Error(`mcp-settings: cannot ${action} ${JSON.stringify(serverName)} because a composition mcp-client row already owns that serverName`);
		}
		syncAll() {
			for (const record of this.document.servers) if (record.enabled && !this.compositionNames().has(record.serverName)) this.mount(record);
		}
		async syncRecord(record) {
			await this.dropFiber(record.serverName);
			if (record.enabled && !this.compositionNames().has(record.serverName)) this.mount(record);
		}
		mount(record) {
			const fiber = this.ctx.plugin({
				name: mcpClient.name,
				inject: mcpClient.inject,
				Config: mcpClient.Config,
				apply: mcpClient.apply
			}, toMcpClientConfig(record));
			this.fibers.set(record.serverName, fiber);
			Promise.resolve(fiber).then(() => void 0, (error) => {
				this.ctx.logger.warn(error);
			});
		}
		async dropFiber(serverName) {
			const fiber = this.fibers.get(serverName);
			if (fiber === void 0) return;
			this.fibers.delete(serverName);
			await fiber.dispose();
		}
		async persist() {
			await writeFileAtomic(this.filename, serializeMcpSettingsDocument(this.document), {
				mode: 384,
				dirMode: 448
			});
		}
		async readDocument() {
			let text;
			try {
				text = await readFile(this.filename, "utf8");
			} catch (error) {
				if (isENOENT(error)) return emptyMcpSettingsDocument();
				throw error;
			}
			return parseMcpSettingsDocument(text);
		}
		loaderEntries() {
			const loader = this.ctx.get("loader");
			if (loader === void 0) return [];
			return loader.entries();
		}
		enqueue(work) {
			const run = this.chain.then(work, work);
			this.chain = run.then(() => void 0, () => void 0);
			return run;
		}
	};
})();
/**
* Read the Fiber phase used by the Settings projection.
* @param fiber - live child or Loader fiber, if any.
* @returns the public phase, or null when nothing is mounted.
*/
function fiberPhase(fiber) {
	return fiber === void 0 ? null : FIBER_PHASE[fiber.state];
}
/**
* Whether a filesystem error means the Settings document is absent.
* @param error - caught rejection.
* @returns true only for ENOENT.
*/
function isENOENT(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
//#endregion
export { MCP_CLIENT_MODULE, MCP_SETTINGS_DOCUMENT_FILENAME, MCP_SETTINGS_DOCUMENT_VERSION, McpSettingsGateway, McpSettingsGateway as default, emptyMcpSettingsDocument, parseMcpSettingsDocument, removeMcpServerRecord, serializeMcpSettingsDocument, toMcpClientConfig, upsertMcpServerRecord, viewCompositionConfig, viewMcpServerRecord };
