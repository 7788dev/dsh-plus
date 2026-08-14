import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { CallId, contentHasImage, freezeMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/host/vision/caption.ts
/** OpenAI-compatible vision captioning against a configured VL endpoint. */
const TEST_TIMEOUT_MS = 3e4;
const CAPTION_TIMEOUT_MS = 18e4;
const CAPTION_PROMPT = [
	"Describe this image for a text-only assistant.",
	"Cover the scene, layout, and transcribe visible text exactly.",
	"Be concise. Do not mention that you are a vision model. Do not ask follow-up questions."
].join(" ");
function joinEndpoint(baseURL, path) {
	return `${baseURL.replace(/\/+$/u, "")}${path.startsWith("/") ? path : `/${path}`}`;
}
function combineSignal(signal, timeoutMs) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal === void 0 ? timeout : AbortSignal.any([signal, timeout]);
}
function asRecord$1(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	return value;
}
function errorMessageFromBody(value, fallback) {
	const record = asRecord$1(value);
	if (record === void 0) return fallback;
	const error = asRecord$1(record.error);
	if (error !== void 0 && typeof error.message === "string" && error.message.length > 0) return error.message;
	if (typeof record.message === "string" && record.message.length > 0) return record.message;
	return fallback;
}
function textFromContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const item of content) {
		const record = asRecord$1(item);
		if (record === void 0) continue;
		if (typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("");
}
function captionMessages(image) {
	return [{
		role: "user",
		content: [{
			type: "text",
			text: CAPTION_PROMPT
		}, {
			type: "image_url",
			image_url: { url: `data:${image.mediaType};base64,${bytesToBase64(image.data)}` }
		}]
	}];
}
function textFromCompletion(value) {
	const record = asRecord$1(value);
	const choices = record === void 0 ? void 0 : record.choices;
	const first = Array.isArray(choices) ? asRecord$1(choices[0]) : void 0;
	if (first === void 0) return "";
	const message = asRecord$1(first.message);
	if (message === void 0) return "";
	const content = textFromContent(message.content);
	if (content.length > 0) return content;
	if (typeof message.reasoning_content === "string") return message.reasoning_content;
	return "";
}
async function readJson(response) {
	const text = await response.text();
	if (text.length === 0) return void 0;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
function bytesToBase64(data) {
	return Buffer.from(data).toString("base64");
}
async function authorizedJson(input) {
	const headers = { Authorization: `Bearer ${input.config.apiKey.trim()}` };
	if (input.body !== void 0) headers["Content-Type"] = "application/json";
	const response = await fetch(joinEndpoint(input.config.baseURL, input.path), {
		method: input.method,
		headers,
		signal: combineSignal(input.signal, TEST_TIMEOUT_MS),
		...input.body === void 0 ? {} : { body: JSON.stringify(input.body) }
	});
	const value = await readJson(response);
	return {
		status: response.status,
		value
	};
}
/** Probe the vision endpoint with GET /models. */
async function testVisionConnection(config, signal) {
	try {
		const { status, value } = await authorizedJson({
			config,
			path: "/models",
			method: "GET",
			signal
		});
		if (status < 200 || status >= 300) return {
			kind: "error",
			message: errorMessageFromBody(value, `HTTP ${String(status)}`)
		};
		const record = asRecord$1(value);
		const data = record === void 0 ? void 0 : record.data;
		const count = Array.isArray(data) ? data.length : void 0;
		return {
			kind: "ok",
			message: `Connected${count === void 0 ? "" : ` (${String(count)} models)`}.`
		};
	} catch (error) {
		return {
			kind: "error",
			message: error instanceof Error ? error.message : String(error)
		};
	}
}
/**
* Caption one image with a non-streaming chat completion.
* Streaming is unused here: the 识图 tool only shows the finished result.
*/
async function captionImage(config, image, signal) {
	const response = await fetch(joinEndpoint(config.baseURL, "/chat/completions"), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${config.apiKey.trim()}`,
			"Content-Type": "application/json"
		},
		signal: combineSignal(signal, CAPTION_TIMEOUT_MS),
		body: JSON.stringify({
			model: config.model,
			stream: false,
			messages: captionMessages(image)
		})
	});
	const value = await readJson(response);
	if (!response.ok) throw new Error(`vision-bridge: vision model failed: ${errorMessageFromBody(value, `HTTP ${String(response.status)}`)}`);
	const text = textFromCompletion(value).trim();
	if (text.length === 0) throw new Error("vision-bridge: vision model returned empty content");
	return text;
}
//#endregion
//#region src/host/vision/native-decorate.ts
function runInitializers(thisArg, initializers) {
	for (const initializer of initializers) initializer.call(thisArg);
}
function esDecorate(ctor, decorators, contextIn, extraInitializers) {
	const target = ctor.prototype;
	const descriptor = Object.getOwnPropertyDescriptor(target, contextIn.name);
	if (descriptor === void 0) throw new Error(`vision-bridge: missing method ${contextIn.name} for Remote decoration`);
	let done = false;
	for (let i = decorators.length - 1; i >= 0; i -= 1) {
		const decorator = decorators[i];
		if (typeof decorator !== "function") throw new TypeError("Function expected");
		const context = {
			kind: contextIn.kind,
			name: contextIn.name,
			static: contextIn.static,
			private: contextIn.private,
			access: {
				has: contextIn.access.has,
				get: contextIn.access.get
			},
			addInitializer: (fn) => {
				if (done) throw new TypeError("Cannot add initializers after decoration has completed");
				extraInitializers.push(fn);
			}
		};
		const result = decorator(descriptor.value, context);
		if (result !== void 0) {
			if (typeof result !== "function") throw new TypeError("Function expected");
			descriptor.value = result;
		}
	}
	Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
}
/**
* Apply Typert native `@Remote` method decorators without relying on oxc, which
* cannot lower Stage-3 decorator syntax for Node 22.
*/
function decorateRemoteMethods(ctor, methods) {
	const extraInitializers = [];
	for (const [name, remoteName] of Object.entries(methods)) esDecorate(ctor, [Remote(remoteName)], {
		kind: "method",
		name,
		static: false,
		private: false,
		access: {
			has: (obj) => name in obj,
			get: (obj) => Reflect.get(obj, name)
		}
	}, extraInitializers);
	return (instance) => {
		runInitializers(instance, extraInitializers);
	};
}
//#endregion
//#region src/host/vision/document.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertKnownKeys(record, allowed, label) {
	for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`vision-bridge: unexpected ${label} key ${JSON.stringify(key)}`);
}
function parseString(value, label) {
	if (typeof value !== "string") throw new Error(`vision-bridge: ${label} must be a string`);
	return value;
}
/** Return an empty Settings document. */
function emptyVisionBridgeDocument() {
	return {
		version: 1,
		vision: {
			baseURL: "",
			apiKey: "",
			model: ""
		},
		targets: []
	};
}
function parseVision(value) {
	if (!isRecord(value)) throw new Error("vision-bridge: document.vision must be an object");
	assertKnownKeys(value, [
		"baseURL",
		"apiKey",
		"model"
	], "vision");
	return {
		baseURL: parseString(value.baseURL, "vision.baseURL").trim(),
		apiKey: parseString(value.apiKey, "vision.apiKey"),
		model: parseString(value.model, "vision.model").trim()
	};
}
function parseTarget(value, index) {
	const label = `targets[${String(index)}]`;
	if (!isRecord(value)) throw new Error(`vision-bridge: ${label} must be an object`);
	assertKnownKeys(value, [
		"provider",
		"model",
		"enabled"
	], label);
	if (typeof value.enabled !== "boolean") throw new Error(`vision-bridge: ${label}.enabled must be a boolean`);
	const provider = parseString(value.provider, `${label}.provider`).trim();
	const model = parseString(value.model, `${label}.model`).trim();
	if (provider.length === 0) throw new Error(`vision-bridge: ${label}.provider must be non-empty`);
	if (model.length === 0) throw new Error(`vision-bridge: ${label}.model must be non-empty`);
	return {
		provider,
		model,
		enabled: value.enabled
	};
}
/** Parse and validate a Settings document body. */
function parseVisionBridgeDocument(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		throw new Error("vision-bridge: document is not valid JSON", { cause });
	}
	if (!isRecord(parsed)) throw new Error("vision-bridge: document must be a JSON object");
	assertKnownKeys(parsed, [
		"version",
		"vision",
		"targets"
	], "document");
	if (parsed.version !== 1) throw new Error(`vision-bridge: unsupported document version ${String(parsed.version)}`);
	if (!Array.isArray(parsed.targets)) throw new Error("vision-bridge: document.targets must be an array");
	return {
		version: 1,
		vision: parsed.vision === void 0 ? emptyVisionBridgeDocument().vision : parseVision(parsed.vision),
		targets: dedupeTargets(parsed.targets.map((entry, index) => parseTarget(entry, index)))
	};
}
function targetKey(provider, model) {
	return `${provider}\0${model}`;
}
function dedupeTargets(targets) {
	const seen = /* @__PURE__ */ new Map();
	for (const target of targets) seen.set(targetKey(target.provider, target.model), target);
	return [...seen.values()];
}
/** Serialize a Settings document as stable JSON. */
function serializeVisionBridgeDocument(document) {
	return `${JSON.stringify(document, null, 2)}\n`;
}
function visionEndpointReady(vision) {
	return vision.baseURL.length > 0 && vision.model.length > 0 && vision.apiKey.trim().length > 0;
}
function isTargetEnabled(targets, provider, model) {
	return targets.some((target) => target.provider === provider && target.model === model && target.enabled);
}
function mergeVision(current, next) {
	const apiKey = next.apiKey === void 0 || next.apiKey.length === 0 ? current.apiKey : next.apiKey;
	return {
		baseURL: next.baseURL.trim(),
		model: next.model.trim(),
		apiKey
	};
}
//#endregion
//#region src/host/vision/look-at-tool.ts
/** Wire name sent in tool-call chunks. Card title is {@link LOOK_AT_TOOL_TITLE}. */
const LOOK_AT_TOOL_NAME = "look_at_image";
/** Conversation card label, same role as a Curl command line. */
const LOOK_AT_TOOL_TITLE = "识图";
function lookAtArgFromImage(image) {
	const { attachment } = image;
	return {
		attachmentId: String(attachment.attachmentId),
		mediaType: attachment.mediaType,
		bytes: attachment.bytes,
		width: attachment.width,
		height: attachment.height,
		...attachment.name === void 0 || attachment.name.length === 0 ? {} : { name: attachment.name }
	};
}
function imageName(image) {
	return image.name === void 0 || image.name.length === 0 ? "image" : image.name;
}
function formatCaptions(images, captions) {
	return images.map((image) => {
		const text = captions.get(image.attachmentId) ?? "";
		return `[Image: ${imageName(image)}]\n${text}`;
	}).join("\n");
}
function lookAtTitle(images) {
	const names = images.map(imageName).join(", ");
	return names.length === 0 ? LOOK_AT_TOOL_TITLE : `${LOOK_AT_TOOL_TITLE} ${names}`;
}
function asRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	return value;
}
function imagesOf(args) {
	const record = asRecord(args);
	const raw = record === void 0 ? void 0 : record.images;
	if (!Array.isArray(raw)) return [];
	const images = [];
	for (const item of raw) {
		const image = asRecord(item);
		if (image === void 0) continue;
		if (typeof image.attachmentId !== "string" || typeof image.mediaType !== "string") continue;
		if (typeof image.bytes !== "number" || typeof image.width !== "number" || typeof image.height !== "number") continue;
		images.push({
			attachmentId: image.attachmentId,
			mediaType: image.mediaType,
			bytes: image.bytes,
			width: image.width,
			height: image.height,
			...typeof image.name === "string" ? { name: image.name } : {}
		});
	}
	return images;
}
/** Host-injected 识图 tool: captions pasted images; the text model must not call it. */
function defineLookAtImageTool(captionImages) {
	return defineTool({
		name: LOOK_AT_TOOL_NAME,
		description: [
			"Caption user-attached images for a text-only model.",
			"The host calls this automatically when the user pastes images.",
			"Do not call this tool yourself."
		].join(" "),
		parameters: { images: {
			type: "array",
			required: true,
			description: "Images to caption.",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					attachmentId: {
						type: "string",
						required: true,
						description: "Attachment id of the image."
					},
					mediaType: {
						type: "string",
						required: true,
						description: "MIME type of the image."
					},
					bytes: {
						type: "integer",
						required: true,
						description: "Encoded byte length of the stored image."
					},
					width: {
						type: "integer",
						required: true,
						description: "Intrinsic width in pixels."
					},
					height: {
						type: "integer",
						required: true,
						description: "Intrinsic height in pixels."
					},
					name: {
						type: "string",
						description: "Original filename, when known."
					}
				}
			}
		} },
		output: {
			schema: { type: "string" },
			render(_args, value) {
				return [{
					type: "text",
					text: value
				}];
			}
		},
		timeoutMs: 3e5,
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const images = imagesOf(args);
			return formatCaptions(images, await captionImages(images, exec.signal));
		},
		presentCall(args) {
			const images = imagesOf(args);
			return {
				card: "generic",
				title: lookAtTitle(images),
				kind: "fetch",
				rawInput: images.map(imageName).join(", ")
			};
		},
		presentResult(args) {
			return {
				card: "generic",
				title: lookAtTitle(imagesOf(args))
			};
		}
	});
}
//#endregion
//#region src/host/vision/rewrite.ts
/** True when any message (including nested tool results) carries an image block. */
function messagesHaveImage(messages) {
	return messages.some((message) => contentHasImage(message.content));
}
function collectImageBlocks(content, into) {
	for (const block of content) switch (block.type) {
		case "image":
			into.push(block);
			break;
		case "tool-result": collectImageBlocks(block.content, into);
	}
}
/** Every image block in the request, including images nested in tool results. */
function collectRequestImages(messages) {
	const images = [];
	for (const message of messages) collectImageBlocks(message.content, images);
	return images;
}
/** Unique images in request order (attachment id). */
function uniqueRequestImages(messages) {
	const unique = [];
	const seen = /* @__PURE__ */ new Set();
	for (const image of collectRequestImages(messages)) {
		const id = String(image.attachment.attachmentId);
		if (seen.has(id)) continue;
		seen.add(id);
		unique.push(image);
	}
	return unique;
}
function isToolResultMessage(message) {
	return message.content.some((block) => block.type === "tool-result");
}
/** True when this turn already issued a look-at-image tool call (success or error). */
function hasLookAtToolSinceLastUser(messages, toolName) {
	let from = 0;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message.role === "user" && !isToolResultMessage(message)) from = index + 1;
	}
	for (let index = from; index < messages.length; index += 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (message.content.some((block) => block.type === "tool-call" && block.name === toolName)) return true;
	}
	return false;
}
/** True when every image in the request already has a cached caption. */
function allImagesCaptioned(messages, captions) {
	return uniqueRequestImages(messages).every((image) => captions.has(String(image.attachment.attachmentId)));
}
/** Drop the host-injected look-at tool so the text model never calls it. */
function stripLookAtTool(options, toolName) {
	const tools = options.tools;
	if (tools === void 0) return options;
	const next = tools.filter((tool) => {
		if (typeof tool !== "object" || tool === null || !("name" in tool)) return true;
		return tool.name !== toolName;
	});
	if (next.length === tools.length) return options;
	return next.length === 0 ? {
		...options,
		tools: void 0
	} : {
		...options,
		tools: next
	};
}
/** Filename shown in the look-at-image reasoning row and the rewritten `[Image:]` block. */
function imageLabel(block) {
	const name = block.attachment.name;
	return name === void 0 || name.length === 0 ? "image" : name;
}
function formatCaption(block, caption) {
	return `[Image: ${imageLabel(block)}]\n${caption}`;
}
function replaceImagesInContent(content, captions) {
	const next = [];
	for (const block of content) switch (block.type) {
		case "image": {
			const caption = captions.get(String(block.attachment.attachmentId));
			if (caption === void 0) throw new Error(`vision-bridge: missing caption for ${String(block.attachment.attachmentId)}`);
			next.push({
				type: "text",
				text: formatCaption(block, caption)
			});
			break;
		}
		case "tool-result":
			next.push({
				...block,
				content: replaceImagesInContent(block.content, captions)
			});
			break;
		case "text":
		case "reasoning":
		case "tool-call": next.push(block);
	}
	return next;
}
/** Copy the request with every image block replaced by caption text. */
function rewriteOptions(options, captions) {
	const messages = options.messages.map((message) => freezeMessage({
		...message,
		content: replaceImagesInContent(message.content, captions)
	}));
	return {
		...options,
		messages
	};
}
function modelSourceOf(message) {
	const source = message.source;
	if (typeof source !== "object" || source === null) return void 0;
	const record = source;
	if (record.kind !== "model") return void 0;
	if (typeof record.provider !== "string" || typeof record.model !== "string") return void 0;
	return {
		kind: "model",
		provider: record.provider,
		model: record.model,
		...record.replayState === void 0 ? {} : { replayState: record.replayState }
	};
}
function hasLookAtReasoning(message) {
	if (message.role !== "assistant") return false;
	return message.content.some((block) => block.type === "reasoning" && block.text.startsWith("查看图片"));
}
/**
* Drop adapter replay metadata on assistant turns that include look-at-image
* reasoning. Injecting that block changes the assistant content list, so pi-ai
* replay would fail with INVALID_REPLAY_STATE.
*/
function dropLookAtReplayState(options) {
	let changed = false;
	const messages = options.messages.map((message) => {
		if (!hasLookAtReasoning(message)) return message;
		const source = modelSourceOf(message);
		if (source === void 0 || source.replayState === void 0) return message;
		changed = true;
		return freezeMessage({
			...message,
			source: {
				kind: "model",
				provider: source.provider,
				model: source.model
			}
		});
	});
	return changed ? {
		...options,
		messages
	} : options;
}
//#endregion
//#region src/host/vision/index.ts
function isEnoent(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function hasSection(value) {
	if (typeof value !== "object" || value === null) return false;
	if (!("section" in value)) return false;
	return typeof value.section === "function";
}
/**
* Host Remote that stores the Vision Bridge document, claims image input for
* opted-in text models, and captions images before those models see the turn.
*/
var VisionBridgeGateway = class extends TypertRemoteService {
	static inject = [
		"llm",
		"attachments",
		"tools"
	];
	static Config = z.object({ path: z.string().required() });
	filename;
	document = emptyVisionBridgeDocument();
	chain = Promise.resolve();
	captions = /* @__PURE__ */ new Map();
	originalResolve;
	constructor(ctx, config) {
		super(ctx, "visionBridge");
		this.filename = resolve(config.path);
		runRemoteInitializers(this);
	}
	async [Service.init]() {
		this.document = await this.readDocument();
		this.installCapabilityClaim();
		this.installLookAtTool();
		this.ctx.on("llm/stream", (options, next) => {
			return this.onStream(options, next);
		});
		const systemPrompt = this.ctx.get("systemPrompt");
		if (hasSection(systemPrompt)) systemPrompt.section({
			name: "vision-bridge",
			order: 80,
			text: [
				"Images in this conversation appear as [Image: filename] text blocks after the 识图 (look_at_image) tool runs.",
				"Those blocks are already complete descriptions; treat them as what the user attached.",
				"Do not call look_at_image yourself. Do not announce that you are reviewing images, and do not restate the [Image] blocks.",
				"Answer the user's question directly. Your thinking stays in the normal reasoning channel."
			].join(" ")
		});
	}
	installLookAtTool() {
		this.ctx.effect(() => this.ctx.tools.register(defineLookAtImageTool((images, signal) => this.captionRefs(images, signal))), "vision-bridge: look_at_image tool");
		this.ctx.on("tools/pre-execute", async (exec, next) => {
			if (exec.name === "look_at_image") return { kind: "allow" };
			return next();
		});
	}
	installCapabilityClaim() {
		const llm = this.ctx.llm;
		const original = llm.resolveModelInfo.bind(llm);
		this.originalResolve = original;
		const patched = async (provider, model, signal) => {
			const info = await original(provider, model, signal);
			if (!this.shouldClaim(provider, model)) return info;
			if (info.inputModalities !== void 0 && info.inputModalities.includes("image")) return info;
			const modalities = new Set(info.inputModalities ?? ["text"]);
			modalities.add("text");
			modalities.add("image");
			return {
				...info,
				inputModalities: [...modalities]
			};
		};
		llm.resolveModelInfo = patched;
		this.ctx.effect(() => () => {
			if (llm.resolveModelInfo === patched) llm.resolveModelInfo = original;
		}, "vision-bridge: restore resolveModelInfo");
	}
	shouldClaim(provider, model) {
		return visionEndpointReady(this.document.vision) && isTargetEnabled(this.document.targets, provider, model);
	}
	async isNativeVision(provider, model, signal) {
		const resolve = this.originalResolve ?? this.ctx.llm.resolveModelInfo.bind(this.ctx.llm);
		try {
			const info = await resolve(provider, model, signal);
			return info.inputModalities !== void 0 && info.inputModalities.includes("image");
		} catch {
			return false;
		}
	}
	async shouldWrap(options) {
		if (!this.shouldClaim(options.provider, options.model)) return false;
		if (!messagesHaveImage(options.messages)) return false;
		if (await this.isNativeVision(options.provider, options.model, options.signal)) return false;
		return true;
	}
	async *onStream(options, next) {
		const sanitized = dropLookAtReplayState(options);
		if (!await this.shouldWrap(sanitized)) {
			if (sanitized === options) {
				yield* next();
				return;
			}
			yield* this.ctx.llm.stream(sanitized);
			return;
		}
		if (sanitized.purpose === "compaction" || sanitized.purpose === "session-title") {
			yield* this.ctx.llm.stream(await this.captionAndRewrite(sanitized));
			return;
		}
		const alreadyCalled = hasLookAtToolSinceLastUser(sanitized.messages, LOOK_AT_TOOL_NAME);
		const cached = allImagesCaptioned(sanitized.messages, this.captions);
		if (!alreadyCalled && !cached) {
			yield* this.emitLookAtCall(sanitized);
			return;
		}
		if (!cached) {
			const text = "识图超时或失败，请再发一次图片。";
			yield {
				type: "block-start",
				index: 0,
				blockType: "text"
			};
			yield {
				type: "text-delta",
				index: 0,
				text
			};
			yield {
				type: "block-end",
				index: 0,
				block: {
					type: "text",
					text
				}
			};
			yield {
				type: "finish",
				reason: { kind: "stop" }
			};
			return;
		}
		yield* this.ctx.llm.stream(stripLookAtTool(await this.captionAndRewrite(sanitized), LOOK_AT_TOOL_NAME));
	}
	async *emitLookAtCall(options) {
		const images = uniqueRequestImages(options.messages).map(lookAtArgFromImage);
		const args = JSON.stringify({ images });
		const id = CallId(randomUUID());
		const index = 0;
		yield {
			type: "block-start",
			index,
			blockType: "tool-call"
		};
		yield {
			type: "tool-call-delta",
			index,
			id,
			name: LOOK_AT_TOOL_NAME,
			argumentsDelta: args
		};
		yield {
			type: "block-end",
			index,
			block: {
				type: "tool-call",
				id,
				name: LOOK_AT_TOOL_NAME,
				arguments: args
			}
		};
		yield {
			type: "finish",
			reason: { kind: "tool-calls" }
		};
	}
	visionConfig() {
		const vision = this.document.vision;
		if (!visionEndpointReady(vision)) throw new Error("vision-bridge: configure a vision model before sending images");
		return vision;
	}
	/** Caption each unique image; reuse cache entries when present. */
	async captionRefs(images, signal) {
		const captions = /* @__PURE__ */ new Map();
		const config = this.visionConfig();
		await Promise.all(images.map(async (image) => {
			const id = String(image.attachmentId);
			const cached = this.captions.get(id);
			if (cached !== void 0) {
				captions.set(id, cached);
				return;
			}
			const stored = await this.ctx.attachments.readImage({
				attachmentId: id,
				mediaType: image.mediaType,
				bytes: image.bytes,
				width: image.width,
				height: image.height,
				...image.name === void 0 ? {} : { name: image.name }
			}, signal);
			const trimmed = (await captionImage(config, {
				attachmentId: id,
				mediaType: stored.ref.mediaType,
				...image.name === void 0 ? {} : { name: image.name },
				data: stored.data
			}, signal)).trim();
			if (trimmed.length === 0) throw new Error("vision-bridge: vision model returned empty content");
			this.captions.set(id, trimmed);
			captions.set(id, trimmed);
		}));
		return captions;
	}
	async captionAndRewrite(options) {
		const images = uniqueRequestImages(options.messages).map(lookAtArgFromImage);
		return rewriteOptions(options, await this.captionRefs(images, options.signal));
	}
	snapshot() {
		return this.enqueue(async () => this.projectSnapshot());
	}
	save(request) {
		return this.enqueue(async () => {
			const vision = request.vision === void 0 ? this.document.vision : mergeVision(this.document.vision, request.vision);
			const targets = request.targets === void 0 ? this.document.targets : normalizeTargets(request.targets);
			this.document = {
				version: 1,
				vision,
				targets
			};
			await this.persist();
			return { ok: true };
		});
	}
	testConnection(request) {
		return this.enqueue(async () => {
			const apiKey = request.apiKey === void 0 || request.apiKey.length === 0 ? this.document.vision.apiKey : request.apiKey;
			const config = {
				baseURL: request.baseURL.trim(),
				model: request.model.trim(),
				apiKey
			};
			if (!visionEndpointReady(config)) return {
				kind: "error",
				message: "Base URL, model, and API key are required."
			};
			return testVisionConnection(config);
		});
	}
	async projectSnapshot() {
		return {
			vision: {
				baseURL: this.document.vision.baseURL,
				model: this.document.vision.model,
				hasApiKey: this.document.vision.apiKey.trim().length > 0
			},
			targets: this.document.targets.map((target) => ({
				provider: target.provider,
				model: target.model,
				enabled: target.enabled
			})),
			catalog: await this.listCatalog()
		};
	}
	async listCatalog() {
		const groups = [];
		for (const provider of this.ctx.llm.listProviders()) try {
			const models = await this.ctx.llm.listModels(provider.id);
			groups.push({
				provider: provider.id,
				providerName: provider.name,
				models: models.map((model) => ({
					id: model.id,
					name: model.name,
					nativeVision: model.inputModalities !== void 0 && model.inputModalities.includes("image")
				}))
			});
		} catch (error) {
			this.ctx.logger.warn(`vision-bridge: failed to list models for ${provider.id}: ${String(error)}`);
		}
		return groups;
	}
	async readDocument() {
		try {
			return parseVisionBridgeDocument(await readFile(this.filename, "utf8"));
		} catch (error) {
			if (isEnoent(error)) return emptyVisionBridgeDocument();
			throw error;
		}
	}
	async persist() {
		await writeFileAtomic(this.filename, serializeVisionBridgeDocument(this.document));
	}
	enqueue(work) {
		const run = this.chain.then(work, work);
		this.chain = run.then(() => void 0, () => void 0);
		return run;
	}
};
function normalizeTargets(targets) {
	const seen = /* @__PURE__ */ new Map();
	for (const target of targets) {
		const provider = target.provider.trim();
		const model = target.model.trim();
		if (provider.length === 0 || model.length === 0) continue;
		seen.set(`${provider}\0${model}`, {
			provider,
			model,
			enabled: target.enabled
		});
	}
	return [...seen.values()];
}
const runRemoteInitializers = decorateRemoteMethods(VisionBridgeGateway, {
	snapshot: "snapshot",
	save: "save",
	testConnection: "testConnection"
});
//#endregion
export { VisionBridgeGateway, VisionBridgeGateway as default };
