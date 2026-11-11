import { afterEach, test } from "node:test";
import { expect } from "expect";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { executeSource } from "../outcome.js";
import { loadConfig } from "../runtime-config.js";
import type { ToolContext } from "../types.js";
import youtube, { cleanVtt } from "./youtube.js";
import { transcript } from "./youtube_transcript.js";

// YouTube's automatic captions start with a header (WEBVTT, Kind, Language) and roll: each cue repeats the previous
// line above the new one, with a 10 ms cue between that holds only the finished line. The speaker says "The answer
// is yes." twice, a minute apart.
const rolling = [
	"WEBVTT",
	"Kind: captions",
	"Language: en",
	"",
	"00:00:00.160 --> 00:00:02.869 align:start position:0%",
	" ",
	"The<00:00:00.480><c> answer</c><00:00:00.800><c> is</c><00:00:01.120><c> yes.</c>",
	"",
	"00:00:02.869 --> 00:00:02.879 align:start position:0%",
	"The answer is yes.",
	" ",
	"",
	"00:00:02.879 --> 00:00:05.150 align:start position:0%",
	"The answer is yes.",
	"Here<00:00:03.200><c> is</c><00:00:03.520><c> why.</c>",
	"",
	"00:00:05.150 --> 00:00:05.160 align:start position:0%",
	"Here is why.",
	" ",
	"",
	"00:01:00.000 --> 00:01:02.000 align:start position:0%",
	"Here is why.",
	"The<00:01:00.300><c> answer</c><00:01:00.600><c> is</c><00:01:00.900><c> yes.</c>",
	"",
].join("\n");

test("the transcript cleaner drops the header and rolling caption overlap but keeps a sentence said again later", () => {
	expect(cleanVtt(rolling)).toBe("The answer is yes. Here is why. The answer is yes.");
});

const originalFetch = globalThis.fetch;
const environment = Object.fromEntries(["PATH", "DIG_STATE_DIR", "SCRAPECREATORS_API_KEY", "OPENCODE_RESEARCH_GOOGLE_API_KEY"].map((name) => [name, process.env[name]]));
const cleanup: string[] = [];
afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const [name, value] of Object.entries(environment)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});
const context: ToolContext = { sessionID: "youtube-test", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, keep: () => {} };
/** Isolated Dig state for one test; transcripts are saved in its library. */
function isolatedLibrary(): string {
	const state = mkdtempSync(join(tmpdir(), "dig-youtube-state-"));
	cleanup.push(state);
	process.env.DIG_STATE_DIR = state;
	return loadConfig().library;
}

/** A configured credential with characters URL encoding spells differently. */
const secret = "Transcript/Key+PRIVATE sample-7";
/** The credential as written and in the encoded spellings the redaction covers: percent-encoded (either hex case) and form-encoded. */
const spellings = [
	secret,
	encodeURIComponent(secret),
	encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
	new URLSearchParams({ v: secret }).toString().slice(2),
];
function expectNoCredential(file: string): string {
	const text = readFileSync(file, "utf8");
	for (const spelling of spellings) expect(text).not.toContain(spelling);
	return text;
}

test("a configured credential in yt-dlp captions or the video's title, in any spelling the redaction covers, never reaches the transcript file", async () => {
	process.env.SCRAPECREATORS_API_KEY = secret;
	process.env.OPENCODE_RESEARCH_GOOGLE_API_KEY = "fixture-google-key";
	const id = "redactYtdlp";
	const file = join(isolatedLibrary(), "youtube-transcripts", `${id}.md`);
	// yt-dlp writes the requested video's captions where `-o` points; the Data API (mocked) supplies the search.
	const bin = mkdtempSync(join(tmpdir(), "dig-ytdlp-"));
	cleanup.push(bin);
	const captions = ["WEBVTT", "", ...spellings.flatMap((spelling, i) => [`00:00:0${i}.000 --> 00:00:0${i}.900`, `caption ${i} says ${spelling}.`, ""])].join("\n");
	writeFileSync(
		join(bin, "yt-dlp"),
		[
			`#!${process.execPath}`,
			'const { writeFileSync } = require("node:fs");',
			"const args = process.argv.slice(2);",
			'const out = args[args.indexOf("-o") + 1];',
			'const id = new URL(args.at(-1)).searchParams.get("v");',
			`writeFileSync(out.replace("%(id)s", id) + ".en.vtt", ${JSON.stringify(captions)});`,
		].join("\n"),
		{ mode: 0o755 },
	);
	process.env.PATH = `${bin}${delimiter}${environment.PATH}`;
	const snippet = { title: `Talk by ${spellings[1]}`, channelTitle: "Creator", publishedAt: "2026-09-01T00:00:00Z" };
	let calls = 0;
	globalThis.fetch = (async () =>
		++calls === 1
			? Response.json({ items: [{ id: { videoId: id }, snippet }] })
			: Response.json({ items: [{ id, snippet, statistics: { viewCount: "1", likeCount: "1" } }] })) as typeof fetch;
	const result = await executeSource(youtube, { query: "redaction", limit: 1, transcripts: true }, context);
	expect(result.text).toContain(`Transcript: ${file}`);
	const text = expectNoCredential(file);
	expect(text).toContain("# Talk by [redacted]");
	for (let i = 0; i < spellings.length; i++) expect(text).toContain(`caption ${i} says [redacted].`);
});

test("a configured credential in the hosted transcript's segments or language, in any spelling the redaction covers, never reaches the transcript file", async () => {
	process.env.SCRAPECREATORS_API_KEY = secret;
	const library = isolatedLibrary();
	const id = "redactHostd";
	globalThis.fetch = (async () =>
		Response.json({
			success: true,
			videoId: id,
			language: `English ${spellings[3]}`,
			credits_charged: 1,
			transcript: spellings.map((spelling, i) => ({ startMs: String(i * 1000), endMs: String(i * 1000 + 900), text: `segment ${i} says ${spelling}.` })),
		})) as typeof fetch;
	const result = await executeSource(transcript, { video: id, language: "en" }, context);
	expect(result.status).toBe("success");
	const file = result.details?.transcriptFile as string;
	expect(file).toBe(join(library, "youtube-transcripts", `${id}-scrapecreators-en.md`));
	expect(statSync(file).mode & 0o777).toBe(0o600);
	const text = expectNoCredential(file);
	expect(text).toContain("Language: English [redacted]");
	for (let i = 0; i < spellings.length; i++) expect(text).toContain(`segment ${i} says [redacted].`);
});

/** A fake yt-dlp on PATH running `body` (Node, with `args`, `out`, `id`, `fs` and `dir` = `logs`), and the Data API (mocked) returning `ids`. */
function fakeYtdlp(ids: string[], body: string): string {
	process.env.OPENCODE_RESEARCH_GOOGLE_API_KEY = "fixture-google-key";
	const bin = mkdtempSync(join(tmpdir(), "dig-ytdlp-"));
	cleanup.push(bin);
	const logs = join(bin, "logs");
	writeFileSync(
		join(bin, "yt-dlp"),
		[
			`#!${process.execPath}`,
			'const fs = require("node:fs"), path = require("node:path");',
			`const dir = ${JSON.stringify(logs)}; fs.mkdirSync(dir, { recursive: true });`,
			"const args = process.argv.slice(2);",
			'const out = args[args.indexOf("-o") + 1];',
			'const id = new URL(args.at(-1)).searchParams.get("v");',
			'fs.writeFileSync(path.join(dir, `${id}.args.json`), JSON.stringify(args));',
			body,
		].join("\n"),
		{ mode: 0o755 },
	);
	process.env.PATH = `${bin}${delimiter}${environment.PATH}`;
	const snippet = { title: "Talk", channelTitle: "Creator", publishedAt: "2026-09-01T00:00:00Z" };
	let calls = 0;
	globalThis.fetch = (async () =>
		++calls === 1
			? Response.json({ items: ids.map((videoId) => ({ id: { videoId }, snippet })) })
			: Response.json({ items: ids.map((id) => ({ id, snippet, statistics: { viewCount: "1", likeCount: "1" } })) })) as typeof fetch;
	return logs;
}
const vtt = (line: string) => `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${line}\n`;

test("youtube runs at most three yt-dlp processes at once, each given Dig's own Node as its JavaScript runtime, and still saves every transcript", async () => {
	const library = isolatedLibrary();
	const ids = Array.from({ length: 7 }, (_, i) => `concurrent${i}`);
	const logs = fakeYtdlp(
		ids,
		[
			'fs.writeFileSync(path.join(dir, `${id}.running`), "");',
			'fs.appendFileSync(path.join(dir, "counts"), fs.readdirSync(dir).filter((f) => f.endsWith(".running")).length + "\\n");',
			"setTimeout(() => {",
			'  fs.writeFileSync(out.replace("%(id)s", id) + ".en.vtt", `WEBVTT\\n\\n00:00:00.000 --> 00:00:01.000\\nSaid in ${id}.\\n`);',
			'  fs.unlinkSync(path.join(dir, `${id}.running`));',
			"}, 150);",
		].join("\n"),
	);
	const result = await executeSource(youtube, { query: "concurrency", limit: 7, transcripts: true }, context);
	expect(result.status).toBe("success");
	const counts = readFileSync(join(logs, "counts"), "utf8").trim().split("\n").map(Number);
	expect(counts).toHaveLength(7);
	expect(Math.max(...counts)).toBeLessThanOrEqual(3);
	for (const id of ids) {
		expect(readFileSync(join(library, "youtube-transcripts", `${id}.md`), "utf8")).toContain(`Said in ${id}.`);
		const args = JSON.parse(readFileSync(join(logs, `${id}.args.json`), "utf8")) as string[];
		expect(args[args.indexOf("--js-runtimes") + 1]).toBe(`node:${process.execPath}`);
		expect(args).not.toContain("--no-warnings");
	}
});

test("aborting youtube stops every running yt-dlp process and starts no further one", async () => {
	isolatedLibrary();
	const ids = Array.from({ length: 6 }, (_, i) => `abortable_${i}`);
	const logs = fakeYtdlp(ids, ['fs.writeFileSync(path.join(dir, `${id}.pid`), String(process.pid));', "setTimeout(() => {}, 60000);"].join("\n"));
	const controller = new AbortController();
	const pending = executeSource(youtube, { query: "abort", limit: 6, transcripts: true }, { ...context, abort: controller.signal });
	const started = () => (existsSync(logs) ? readdirSync(logs).filter((f) => f.endsWith(".pid")) : []);
	while (started().length < 3) await new Promise((resolve) => setTimeout(resolve, 5));
	controller.abort();
	const result = await pending;
	expect(result.status).toBe("cancelled");
	const pids = started().map((f) => Number(readFileSync(join(logs, f), "utf8")));
	expect(pids).toHaveLength(3);
	const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
	while (pids.some(alive)) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(readdirSync(logs).filter((f) => f.endsWith(".args.json"))).toHaveLength(3);
});

test("youtube asks yt-dlp for uploaded and automatic English captions, prefers the uploaded track and says which kind it read", async () => {
	const library = isolatedLibrary();
	const ids = ["uploadedCap", "automaticCa", "unknownKind"];
	const logs = fakeYtdlp(
		ids,
		[
			"const base = out.replace(\"%(id)s\", id);",
			'if (id === "uploadedCap") { fs.writeFileSync(base + ".info.json", JSON.stringify({ subtitles: { "en-US": [] } })); fs.writeFileSync(base + ".en-US.vtt", ' + JSON.stringify(vtt("Uploaded words.")) + '); fs.writeFileSync(base + ".en.vtt", ' + JSON.stringify(vtt("Automatic words.")) + "); }",
			'if (id === "automaticCa") { fs.writeFileSync(base + ".info.json", JSON.stringify({ subtitles: {} })); fs.writeFileSync(base + ".en.vtt", ' + JSON.stringify(vtt("Automatic words.")) + "); }",
			'if (id === "unknownKind") fs.writeFileSync(base + ".en.vtt", ' + JSON.stringify(vtt("Some words.")) + ");",
		].join("\n"),
	);
	const result = await executeSource(youtube, { query: "captions", limit: 3, transcripts: true }, context);
	expect(result.status).toBe("success");
	const file = (id: string) => join(library, "youtube-transcripts", `${id}.md`);
	expect(readFileSync(file("uploadedCap"), "utf8")).toContain("Uploaded words.");
	expect(readFileSync(file("uploadedCap"), "utf8")).not.toContain("Automatic words.");
	expect(result.text).toMatch(new RegExp(`${file("uploadedCap")} \\(\\d+ words, from uploaded English captions \\(en-US\\)\\)`));
	expect(result.text).toMatch(new RegExp(`${file("automaticCa")} \\(\\d+ words, from automatic English captions \\(en\\)\\)`));
	expect(result.text).toMatch(new RegExp(`${file("unknownKind")} \\(\\d+ words, from English captions \\(en\\)\\)`));
	const args = JSON.parse(readFileSync(join(logs, "uploadedCap.args.json"), "utf8")) as string[];
	expect(args).toEqual(expect.arrayContaining(["--write-subs", "--write-auto-subs", "--write-info-json"]));
	// Named codes only: `en.*` would also fetch every machine translation into English and fail on a rate limit.
	expect(args[args.indexOf("--sub-langs") + 1]).toBe("en,en-US,en-GB,en-CA,en-AU");
});
