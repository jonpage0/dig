import { afterEach, test } from "node:test";
import { expect } from "expect";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
